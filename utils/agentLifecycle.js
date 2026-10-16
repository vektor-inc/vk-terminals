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

function hasBaselineAncestor(processes, process, shell, baselineIdentities) {
  const visited = new Set();
  let current = process;
  while (current && current.pid !== shell.pid) {
    if (visited.has(current.pid)) return null;
    visited.add(current.pid);
    if (current.pid !== process.pid) {
      const baselineStart = baselineIdentities?.get(current.pid);
      if (baselineStart !== undefined) {
        if (!isSameProcessStart(current.lstart, baselineStart)) return null;
        return true;
      }
    }
    current = processes.get(current.ppid);
  }
  return current?.pid === shell.pid ? false : null;
}

function inspectLifecycle(snapshot, processes) {
  const shell = processes.get(snapshot.shellPid);
  if (!shell || !isSameProcessStart(shell.lstart, snapshot.shellLstart)) return { state: null, terminal: true };
  const trackedGroups = new Map(snapshot.trackedGroups || []);
  const shellDescendants = [...processes.values()].filter((process) => {
    if (process.pid === shell.pid || !isDescendant(processes, process.pid, shell.pid, shell.lstart)) return false;
    const baselineStart = snapshot.baselineIdentities?.get(process.pid);
    return baselineStart === undefined || !isSameProcessStart(process.lstart, baselineStart);
  });
  const knownIdentities = new Map();
  for (const identities of trackedGroups.values()) {
    for (const [pid, lstart] of identities) knownIdentities.set(pid, lstart);
  }
  const aliveKnown = new Map();
  for (const [pid, lstart] of knownIdentities) {
    const process = processes.get(pid);
    if (!process) continue;
    if (!isSameProcessStart(process.lstart, lstart)) return { state: null, terminal: true };
    aliveKnown.set(pid, process);
  }

  // identity は PGID や PPID より強い連続性の根拠になる。fresh snapshot 全体で照合し、
  // orphan 化や group 移動後も同じ PID + lstart を追跡し続ける。
  for (const process of aliveKnown.values()) {
    if (!Number.isSafeInteger(process.pgid) || process.pgid <= 0 || process.pgid === shell.pgid) {
      return { state: null, trackedGroups, hasAliveGroup: false, terminal: true };
    }
    for (const identities of trackedGroups.values()) identities.delete(process.pid);
    let identities = trackedGroups.get(process.pgid);
    if (!identities) {
      identities = new Map();
      trackedGroups.set(process.pgid, identities);
    }
    identities.set(process.pid, process.lstart);
  }

  // 新規 member は、既知 identity と同じ group、または既知 identity の子孫である場合だけ追加する。
  // baseline 外という理由だけでは、既存 background job の子を今回世代へ取り込まない。
  const continuousProcesses = [...processes.values()].filter((process) => {
    if (process.pid === shell.pid || process.pgid === shell.pgid) return false;
    if ([...aliveKnown.values()].some((known) => known.pgid === process.pgid)) return true;
    return [...aliveKnown.values()].some((known) =>
      process.pid !== known.pid && isDescendant(processes, process.pid, known.pid, known.lstart));
  });
  for (const process of continuousProcesses) {
    let identities = trackedGroups.get(process.pgid);
    if (!identities) {
      identities = new Map();
      trackedGroups.set(process.pgid, identities);
    }
    identities.set(process.pid, process.lstart);
    aliveKnown.set(process.pid, process);
  }

  const candidate = shell.tpgid;
  const trackedGroupStillPresent = [...trackedGroups.keys()].some((pgid) =>
    [...processes.values()].some((process) => process.pgid === pgid));
  const mayAcquireInitial = trackedGroups.size === 0 && !snapshot.completionReceived;
  const mayAcquireSuccessor = trackedGroups.size > 0 && !snapshot.completionReceived &&
    aliveKnown.size === 0 && !trackedGroupStillPresent;
  if ((mayAcquireInitial || mayAcquireSuccessor) && Number.isSafeInteger(candidate) &&
      candidate > 0 && candidate !== shell.pgid && !trackedGroups.has(candidate)) {
    const members = [...processes.values()].filter((process) =>
      process.pgid === candidate && isDescendant(processes, process.pid, shell.pid, shell.lstart));
    const isBaselineGroup = snapshot.baselinePgids?.has(candidate);
    const hasBaselineMember = members.some((process) => {
      const baselineStart = snapshot.baselineIdentities?.get(process.pid);
      return baselineStart !== undefined && isSameProcessStart(process.lstart, baselineStart);
    });
    const hasDirectShellChild = members.some((process) => process.ppid === shell.pid);
    const ancestryIsSafe = members.every((process) =>
      hasBaselineAncestor(processes, process, shell, snapshot.baselineIdentities) === false);
    // 初回は厳格な前景条件を満たす group だけを取得する。後継は、直前の group と identity が
    // 全消失した gap に限り、shell function が次に起動した shell 直下の sibling を受け入れる。
    if (members.length > 0 && (mayAcquireInitial || hasDirectShellChild) && !isBaselineGroup && !hasBaselineMember &&
        (!mayAcquireInitial || ancestryIsSafe)) {
      trackedGroups.set(candidate, new Map(members.map((process) => [process.pid, process.lstart])));
      for (const process of members) aliveKnown.set(process.pid, process);
    }
  }

  for (const [pgid] of trackedGroups) {
    const members = [...processes.values()].filter((process) => process.pgid === pgid);
    if (members.length === 0) continue;
    // 既知 identity が全消失した古い PGID に別プロセスだけが残る場合は再利用等を判別できない。
    if (!members.some((process) => aliveKnown.has(process.pid))) return { state: null, terminal: true };
  }

  if (trackedGroups.size === 0) return { state: null, trackedGroups, hasAliveGroup: false, terminal: Boolean(snapshot.completionReceived) };
  if (aliveKnown.size > 0) return { state: 'running', trackedGroups, hasAliveGroup: true };
  if (!snapshot.completionReceived) return { state: 'running', trackedGroups, hasAliveGroup: false };
  // completion 後に由来不明の baseline 外子孫が残る場合は終了も実行中も断定しない。
  if (shellDescendants.length > 0) return { state: null, trackedGroups, hasAliveGroup: false, terminal: true };
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
    const mode = `vk_agent_mode_${marker}`;
    const index = `vk_agent_index_${marker}`;
    const saved = `vk_agent_saved_prompt_${marker}`;
    const wasSet = `vk_agent_prompt_was_set_${marker}`;
    const cleanup = `vk_agent_cleanup_${marker}`;
    return `case \"$(declare -p PROMPT_COMMAND 2>/dev/null)\" in \"declare -a\"*) if [ \"\${BASH_VERSINFO[0]}\" -ge 5 ]; then ${mode}=array; else ${mode}=; printf %b ${failed}; fi;; \"\"|\"declare --\"*) ${mode}=string;; *) ${mode}=; printf %b ${failed};; esac; if [ -n \"\$${mode}\" ]; then ${armed}=0; ${wasSet}=0; ${saved}=; if [ \"\$${mode}\" = string ]; then if declare -p PROMPT_COMMAND >/dev/null 2>&1; then ${wasSet}=1; fi; ${saved}=\${PROMPT_COMMAND-}; fi; ${cleanup}() { if [ \"\$${mode}\" = array ]; then for ${index} in \"\${!PROMPT_COMMAND[@]}\"; do [ \"\${PROMPT_COMMAND[\$${index}]}\" = ${name} ] && unset \"PROMPT_COMMAND[\$${index}]\"; done; elif [ \"\$${wasSet}\" = 1 ]; then PROMPT_COMMAND=\$${saved}; else unset PROMPT_COMMAND; fi; unset ${mode} ${index} ${armed} ${saved} ${wasSet}; unset -f ${name} ${cleanup}; }; ${name}() { if [ \"\$${armed}\" = 0 ]; then ${armed}=1; printf %b ${ready}; return; fi; ${cleanup}; printf %b ${completion}; }; if [ \"\$${mode}\" = array ]; then PROMPT_COMMAND+=( ${name} ); else PROMPT_COMMAND=\"\${PROMPT_COMMAND-}\"$'\\n'${name}; fi; fi`;
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
    if (entry.readyTimer) clearTimer(entry.readyTimer);
    entry.timer = null;
    entry.acquisitionTimer = null;
    entry.readyTimer = null;
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
      Object.assign(entry, { shellPid, shellLstart: null, trackedGroups: new Map(), baselinePgids: new Set(), baselineIdentities: new Map(), marker: null, markerBuffer: '', completionReceived: false, acquisitionOpen: false, acquisitionTimer: null, readyResolve: null, readyTimer: null, activated: false });
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
      entry.readyTimer = setTimer(() => finishAcquisition(entry), acquisitionTimeoutMs);
      const setupCommand = buildPromptHookCommand(entry.marker, shellPath);
      const cleanupCommand = pathBasename(shellPath) === 'bash'
        ? `type vk_agent_cleanup_${entry.marker} >/dev/null 2>&1 && vk_agent_cleanup_${entry.marker}`
        : null;
      return { status: 'ready', command, setupCommand, cleanupCommand, ready };
    },
    async activate(termId, generation, launchToken) {
      const id = String(termId);
      const entry = states.get(id);
      const isCurrent = () => states.get(id) === entry && entry?.generation === generation && entry?.launchToken === launchToken && !closed;
      if (!isCurrent() || entry.cancelled) return false;
      let processes;
      try { processes = await listProcesses(); } catch (_error) { return false; }
      if (!isCurrent() || entry.cancelled) return false;
      const shell = processes.get(entry.shellPid);
      if (!shell || !isSameProcessStart(shell.lstart, entry.shellLstart)) return false;
      entry.baselinePgids = new Set();
      entry.baselineIdentities = new Map();
      for (const process of processes.values()) {
        entry.baselinePgids.add(process.pgid);
        entry.baselineIdentities.set(process.pid, process.lstart);
      }
      entry.activated = true;
      entry.acquisitionOpen = true;
      entry.acquisitionTimer = setTimer(() => finishAcquisition(entry), acquisitionTimeoutMs);
      schedule(id, entry);
      return true;
    },
    cancelPending(termId, generation) {
      return this.initialize(termId, generation);
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
        if (entry.readyTimer) clearTimer(entry.readyTimer);
        entry.readyTimer = null;
        if (!ok) {
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
        if (entry.activated && !entry.cancelled && !closed && !entry.timer && !entry.polling) schedule(String(termId), entry);
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
