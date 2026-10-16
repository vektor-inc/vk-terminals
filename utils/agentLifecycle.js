'use strict';

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const PS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid=,tpgid=,stat=,lstart='];
const LSTART_TOLERANCE_MS = 2000;
const DEFAULT_ACQUISITION_TIMEOUT_MS = 750;
const MARKER_PREFIX = '\x1b]1337;VKAgentLifecycle=';
const READY_MARKER_PREFIX = '\x1b]1337;VKAgentLifecycleReady=';
const MARKER_SUFFIX = '\x07';

function isSameProcessStart(a, b) {
  const first = Date.parse(a);
  const second = Date.parse(b);
  return Number.isFinite(first) && Number.isFinite(second) && Math.abs(first - second) <= LSTART_TOLERANCE_MS;
}

function parseProcessTable(output) {
  if (typeof output !== 'string') throw new Error('invalid process table');
  const processes = new Map();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (!match) throw new Error('invalid process table');
    const [, pid, ppid, pgid, tpgid, stat, lstart] = match;
    processes.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), tpgid: Number(tpgid), stat, lstart });
  }
  if (processes.size === 0) throw new Error('invalid process table');
  return processes;
}

async function listProcessTable() {
  const { stdout } = await execFileAsync('ps', PS_ARGS, {
    encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024,
    killSignal: 'SIGKILL', env: { ...process.env, LC_ALL: 'C' },
  });
  return parseProcessTable(stdout);
}

function isDescendant(processes, pid, ancestorPid, ancestorLstart) {
  const visited = new Set();
  let current = processes.get(pid);
  while (current && !visited.has(current.pid)) {
    if (current.pid === ancestorPid) return isSameProcessStart(current.lstart, ancestorLstart);
    visited.add(current.pid);
    current = processes.get(current.ppid);
  }
  return false;
}

function inspectLifecycle(snapshot, processes) {
  const shell = processes.get(snapshot.shellPid);
  if (!shell || !isSameProcessStart(shell.lstart, snapshot.shellLstart)) return { state: null, terminal: true };
  const trackedGroups = new Map(snapshot.trackedGroups || []);
  const outsideBaseline = [...processes.values()].filter((process) => {
    if (process.pid === shell.pid || !isDescendant(processes, process.pid, shell.pid, shell.lstart)) return false;
    const baselineStart = snapshot.baselineIdentities?.get(process.pid);
    return baselineStart === undefined || !isSameProcessStart(process.lstart, baselineStart);
  });
  const candidate = shell.tpgid;
  if (Number.isSafeInteger(candidate) && candidate > 0 && candidate !== shell.pgid && !trackedGroups.has(candidate)) {
    const members = [...processes.values()].filter((process) =>
      process.pgid === candidate && isDescendant(processes, process.pid, shell.pid, shell.lstart));
    const isBaselineGroup = snapshot.baselinePgids?.has(candidate);
    const hasBaselineMember = members.some((process) => {
      const baselineStart = snapshot.baselineIdentities?.get(process.pid);
      return baselineStart !== undefined && isSameProcessStart(process.lstart, baselineStart);
    });
    // completion の前後を問わず、シェル関数内で順次起動される別 PGID も同じ世代として取得する。
    if (members.length > 0 && !isBaselineGroup && !hasBaselineMember) {
      trackedGroups.set(candidate, new Map(members.map((process) => [process.pid, process.lstart])));
    }
  }

  // 終了判定と同じ fresh snapshot で、前景から外れた停止中プロセスも含む全子孫を確認する。
  // shell まで親子関係を辿れたものは今回世代との連続性が証明できるため後継 group として追跡する。
  for (const process of outsideBaseline) {
    let identities = trackedGroups.get(process.pgid);
    if (!identities) {
      identities = new Map();
      trackedGroups.set(process.pgid, identities);
    }
    identities.set(process.pid, process.lstart);
  }

  let hasAliveGroup = false;
  for (const [pgid, identities] of trackedGroups) {
    const members = [...processes.values()].filter((process) => process.pgid === pgid);
    if (members.length === 0) continue;
    const knownAlive = members.some((process) => {
      const knownStart = identities.get(process.pid);
      return knownStart !== undefined && isSameProcessStart(process.lstart, knownStart);
    });
    // 同じ PGID の再利用と未観測 member を区別できない場合は終了を断定しない。
    if (!knownAlive) return { state: null, terminal: true };
    hasAliveGroup = true;
    for (const process of members) identities.set(process.pid, process.lstart);
  }

  if (trackedGroups.size === 0) return { state: null, trackedGroups, hasAliveGroup: false, terminal: Boolean(snapshot.completionReceived) };
  if (hasAliveGroup || outsideBaseline.length > 0 || !snapshot.completionReceived) return { state: 'running', trackedGroups, hasAliveGroup: hasAliveGroup || outsideBaseline.length > 0 };
  return { state: 'exited', trackedGroups, hasAliveGroup: false, terminal: true };
}

function quoteForSingleShellArgument(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function buildPromptHookCommand(marker, shellPath) {
  const name = `vk_agent_prompt_${marker}`;
  const armed = `vk_agent_armed_${marker}`;
  const completion = quoteForSingleShellArgument(`\\033]1337;VKAgentLifecycle=${marker}\\007`);
  const ready = quoteForSingleShellArgument(`\\033]1337;VKAgentLifecycleReady=${marker}:ok\\007`);
  const failed = quoteForSingleShellArgument(`\\033]1337;VKAgentLifecycleReady=${marker}:fail\\007`);
  const shell = pathBasename(shellPath);
  if (shell === 'zsh') {
    return `function ${name} { if (( \${+${armed}} == 0 )); then typeset -g ${armed}=1; printf %b ${ready}; return; fi; precmd_functions=(\${precmd_functions:#${name}}); unfunction ${name}; unset ${armed}; printf %b ${completion}; }; precmd_functions+=( ${name} )`;
  }
  if (shell === 'bash') {
    const saved = `vk_agent_saved_prompt_${marker}`;
    return `if declare -p PROMPT_COMMAND 2>/dev/null | grep -q '^declare -a'; then printf %b ${failed}; else ${saved}=\"\${PROMPT_COMMAND-}\"; ${armed}=0; ${name}() { if [ \"\$${armed}\" = 0 ]; then ${armed}=1; printf %b ${ready}; return; fi; PROMPT_COMMAND=\"\$${saved}\"; unset ${saved} ${armed}; unset -f ${name}; printf %b ${completion}; }; PROMPT_COMMAND=\"${name}\${PROMPT_COMMAND:+;}\${PROMPT_COMMAND-}\"; fi`;
  }
  if (shell === 'fish') {
    return `set -g ${armed} 0; function ${name} --on-event fish_prompt; if test \$${armed} -eq 0; set -g ${armed} 1; printf %b ${ready}; else; functions -e ${name}; set -e ${armed}; printf %b ${completion}; end; end`;
  }
  return `printf %b ${failed}`;
}

function pathBasename(filePath) {
  return String(filePath || '').split('/').pop();
}

function createAgentLifecycleStore(options = {}) {
  const platform = options.platform || process.platform;
  const listProcesses = options.listProcesses || listProcessTable;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const acquisitionTimeoutMs = options.acquisitionTimeoutMs ?? DEFAULT_ACQUISITION_TIMEOUT_MS;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const states = new Map();
  let closed = false;
  const stop = (entry) => {
    entry.cancelled = true;
    if (entry.readyResolve) entry.readyResolve(false);
    entry.readyResolve = null;
    if (entry.timer) clearTimer(entry.timer);
    if (entry.acquisitionTimer) clearTimer(entry.acquisitionTimer);
    entry.timer = null;
    entry.acquisitionTimer = null;
  };
  const schedule = (id, entry) => {
    if (!entry.cancelled && !closed && states.get(id) === entry) entry.timer = setTimer(() => poll(id, entry), pollIntervalMs);
  };
  const poll = async (id, entry) => {
    if (entry.polling || entry.cancelled || closed || states.get(id) !== entry) return;
    entry.polling = true;
    let processes;
    try { processes = await listProcesses(); } catch (_error) {
      if (states.get(id) === entry && !entry.cancelled) entry.state = null;
      entry.polling = false;
      stop(entry);
      return;
    }
    if (states.get(id) !== entry || entry.cancelled || closed) { entry.polling = false; return; }
    const result = inspectLifecycle(entry, processes);
    entry.state = result.state;
    if (result.trackedGroups) entry.trackedGroups = result.trackedGroups;
    if (result.hasAliveGroup && entry.acquisitionTimer) {
      clearTimer(entry.acquisitionTimer);
      entry.acquisitionTimer = null;
    } else if (entry.trackedGroups.size > 0 && !result.hasAliveGroup && !entry.completionReceived && !entry.acquisitionTimer) {
      // group 間の builtin 処理を許容しつつ、後継を確認できない状態は有限時間で null に倒す。
      entry.acquisitionTimer = setTimer(() => finishAcquisition(entry), acquisitionTimeoutMs);
    }
    entry.polling = false;
    if (result.terminal) stop(entry); else schedule(id, entry);
  };
  const finishAcquisition = (entry) => {
    entry.state = null;
    stop(entry);
  };
  return {
    initialize(termId, generation) {
      const id = String(termId); const previous = states.get(id); if (previous) stop(previous);
      const launchToken = crypto.randomBytes(24).toString('hex');
      states.set(id, { generation, launchToken, state: null, cancelled: false, timer: null, polling: false });
      return launchToken;
    },
    async prepare(termId, generation, launchToken, shellPid, command, shellPath) {
      const id = String(termId);
      const entry = states.get(id);
      const isCurrent = () => states.get(id) === entry && entry?.generation === generation && entry?.launchToken === launchToken && !closed;
      if (!isCurrent()) return { status: 'cancelled' };
      Object.assign(entry, { shellPid, shellLstart: null, trackedGroups: new Map(), baselinePgids: new Set(), baselineIdentities: new Map(), marker: null, markerBuffer: '', completionReceived: false, acquisitionOpen: false, acquisitionTimer: null, readyResolve: null });
      if (platform === 'win32' || !Number.isSafeInteger(shellPid) || shellPid <= 0) return { status: 'passthrough', command };
      let processes;
      try { processes = await listProcesses(); } catch (_error) {
        return isCurrent() ? { status: 'passthrough', command } : { status: 'cancelled' };
      }
      if (!isCurrent()) return { status: 'cancelled' };
      const shell = processes.get(shellPid);
      if (!shell) return { status: 'passthrough', command };
      entry.shellLstart = shell.lstart;
      for (const process of processes.values()) {
        entry.baselinePgids.add(process.pgid);
        entry.baselineIdentities.set(process.pid, process.lstart);
      }
      entry.marker = crypto.randomBytes(24).toString('hex');
      const ready = new Promise((resolve) => { entry.readyResolve = resolve; });
      entry.acquisitionOpen = true;
      entry.acquisitionTimer = setTimer(() => finishAcquisition(entry), acquisitionTimeoutMs);
      return { status: 'ready', command, setupCommand: buildPromptHookCommand(entry.marker, shellPath), ready };
    },
    isCurrent(termId, generation, launchToken) {
      const entry = states.get(String(termId));
      return Boolean(entry && !closed && entry.generation === generation && entry.launchToken === launchToken);
    },
    filterOutput(termId, data) {
      const entry = states.get(String(termId));
      if (!entry?.marker || typeof data !== 'string') return data;
      const marker = `${MARKER_PREFIX}${entry.marker}${MARKER_SUFFIX}`;
      const readyOk = `${READY_MARKER_PREFIX}${entry.marker}:ok${MARKER_SUFFIX}`;
      const readyFail = `${READY_MARKER_PREFIX}${entry.marker}:fail${MARKER_SUFFIX}`;
      const combined = entry.markerBuffer + data;
      entry.markerBuffer = '';
      let visible = combined;
      if (visible.includes(readyOk) || visible.includes(readyFail)) {
        const ok = visible.includes(readyOk);
        visible = visible.replaceAll(readyOk, '').replaceAll(readyFail, '');
        if (entry.readyResolve) entry.readyResolve(ok);
        entry.readyResolve = null;
        if (ok) {
          if (entry.acquisitionTimer) clearTimer(entry.acquisitionTimer);
          entry.acquisitionTimer = setTimer(() => finishAcquisition(entry), acquisitionTimeoutMs);
          if (!entry.cancelled && !closed && !entry.timer && !entry.polling) schedule(String(termId), entry);
        } else {
          finishAcquisition(entry);
        }
      }
      if (visible.includes(marker)) {
        entry.completionReceived = true;
        if (entry.acquisitionOpen) {
          entry.acquisitionOpen = false;
          if (entry.acquisitionTimer) clearTimer(entry.acquisitionTimer);
          entry.acquisitionTimer = null;
        }
        // marker が先着しても、終了判定は必ず次の fresh process snapshot で行う。
        if (!entry.cancelled && !closed && !entry.timer && !entry.polling) schedule(String(termId), entry);
        visible = visible.replaceAll(marker, '');
      }
      // PTY は任意の位置でデータを分割するため、正しいマーカーの接頭辞だけを次回へ持ち越す。
      const markers = [marker, readyOk, readyFail];
      for (let length = Math.min(Math.max(...markers.map((value) => value.length)) - 1, visible.length); length > 0; length -= 1) {
        const suffix = visible.slice(-length);
        if (markers.some((value) => value.startsWith(suffix))) {
          entry.markerBuffer = suffix;
          return visible.slice(0, -length);
        }
      }
      return visible;
    },
    get(termId, generation) { const entry = states.get(String(termId)); return entry && entry.generation === generation ? entry.state : null; },
    delete(termId) { const id = String(termId); const entry = states.get(id); if (entry) stop(entry); states.delete(id); },
    async close() { closed = true; for (const entry of states.values()) stop(entry); states.clear(); },
  };
}

function mergeAgentLifecycleStates(states, getGeneration, getLifecycleState) {
  if (!states || typeof states !== 'object' || Array.isArray(states)) return states;
  return Object.fromEntries(Object.entries(states).map(([paneId, state]) => {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return [paneId, state];
    const generation = getGeneration(state.termId);
    return [paneId, { ...state, agentGeneration: generation, agentCommandState: getLifecycleState(state.termId, generation) }];
  }));
}

module.exports = { PS_ARGS, DEFAULT_ACQUISITION_TIMEOUT_MS, MARKER_PREFIX, READY_MARKER_PREFIX, MARKER_SUFFIX, parseProcessTable, listProcessTable, isDescendant, inspectLifecycle, buildPromptHookCommand, createAgentLifecycleStore, mergeAgentLifecycleStates };
