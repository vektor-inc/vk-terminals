'use strict';

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const PS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid=,tpgid=,stat=,lstart='];
const LSTART_TOLERANCE_MS = 2000;
const DEFAULT_ACQUISITION_TIMEOUT_MS = 750;
const MARKER_PREFIX = '\x1b]1337;VKAgentLifecycle=';
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
  if (snapshot.trackedPgid === null) {
    const candidate = shell.tpgid;
    if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate === shell.pgid) return { state: null };
    const members = [...processes.values()].filter((process) =>
      process.pgid === candidate && isDescendant(processes, process.pid, shell.pid, shell.lstart));
    if (members.length === 0) return { state: null };
    if (snapshot.baselinePgids?.has(candidate)) return { state: null };
    if (members.some((process) => {
      const baselineStart = snapshot.baselineIdentities?.get(process.pid);
      return baselineStart !== undefined && isSameProcessStart(process.lstart, baselineStart);
    })) return { state: null };
    return { state: 'running', trackedPgid: candidate, identities: new Map(members.map((process) => [process.pid, process.lstart])) };
  }
  const members = [...processes.values()].filter((process) => process.pgid === snapshot.trackedPgid);
  if (members.length === 0) return { state: 'exited', terminal: true };
  const knownAlive = members.some((process) => {
    const knownStart = snapshot.identities.get(process.pid);
    return knownStart !== undefined && isSameProcessStart(process.lstart, knownStart);
  });
  // 同じ PGID にプロセスが残る限り、未観測の子と PGID 再利用を区別できないため終了とは断定しない。
  if (!knownAlive) return { state: null, terminal: true };
  const identities = new Map(snapshot.identities);
  for (const process of members) identities.set(process.pid, process.lstart);
  return { state: 'running', identities };
}

function quoteForSingleShellArgument(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function buildTrackedLaunchCommand(command, marker, shellPath) {
  // 制御文字を起動行へ直接埋め込むと PTY のエコーを完了通知と誤認するため、printf で復元する。
  const markerArgument = quoteForSingleShellArgument(`\\033]1337;VKAgentLifecycle=${marker}\\007`);
  if (pathBasename(shellPath) === 'fish') {
    return `begin; ${command}; set -l vk_agent_status_${marker} $status; printf %b ${markerArgument}; command sh -c "exit \$vk_agent_status_${marker}"; end`;
  }
  const statusName = `vk_agent_status_${marker}`;
  return `{ ${command}; ${statusName}=$?; printf %b ${markerArgument}; eval "unset ${statusName}; command sh -c 'exit \$${statusName}'"; }`;
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
    if (result.trackedPgid !== undefined) entry.trackedPgid = result.trackedPgid;
    if (result.identities) entry.identities = result.identities;
    entry.polling = false;
    if (result.terminal) stop(entry); else schedule(id, entry);
  };
  const finishAcquisition = (entry) => {
    if (entry.trackedPgid === null) {
      entry.state = null;
      stop(entry);
    }
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
      const isCurrent = () => states.get(id) === entry && entry?.generation === generation && entry?.launchToken === launchToken && !entry.cancelled && !closed;
      if (!isCurrent()) return { status: 'cancelled' };
      Object.assign(entry, { shellPid, shellLstart: null, trackedPgid: null, identities: new Map(), baselinePgids: new Set(), baselineIdentities: new Map(), marker: null, markerBuffer: '', acquisitionOpen: false, acquisitionTimer: null });
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
      entry.acquisitionOpen = true;
      entry.acquisitionTimer = setTimer(() => finishAcquisition(entry), acquisitionTimeoutMs);
      schedule(id, entry);
      return { status: 'ready', command: buildTrackedLaunchCommand(command, entry.marker, shellPath) };
    },
    isCurrent(termId, generation, launchToken) {
      const entry = states.get(String(termId));
      return Boolean(entry && !entry.cancelled && !closed && entry.generation === generation && entry.launchToken === launchToken);
    },
    filterOutput(termId, data) {
      const entry = states.get(String(termId));
      if (!entry?.marker || typeof data !== 'string') return data;
      const marker = `${MARKER_PREFIX}${entry.marker}${MARKER_SUFFIX}`;
      const combined = entry.markerBuffer + data;
      entry.markerBuffer = '';
      if (combined.includes(marker)) {
        if (entry.acquisitionOpen) {
          entry.acquisitionOpen = false;
          if (entry.acquisitionTimer) clearTimer(entry.acquisitionTimer);
          entry.acquisitionTimer = null;
          finishAcquisition(entry);
        }
        return combined.replaceAll(marker, '');
      }
      // PTY は任意の位置でデータを分割するため、正しいマーカーの接頭辞だけを次回へ持ち越す。
      for (let length = Math.min(marker.length - 1, combined.length); length > 0; length -= 1) {
        const suffix = combined.slice(-length);
        if (marker.startsWith(suffix)) {
          entry.markerBuffer = suffix;
          return combined.slice(0, -length);
        }
      }
      return combined;
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

module.exports = { PS_ARGS, DEFAULT_ACQUISITION_TIMEOUT_MS, MARKER_PREFIX, MARKER_SUFFIX, parseProcessTable, listProcessTable, isDescendant, inspectLifecycle, buildTrackedLaunchCommand, createAgentLifecycleStore, mergeAgentLifecycleStates };
