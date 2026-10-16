'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const PS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid=,tpgid=,stat=,lstart='];
const LSTART_TOLERANCE_MS = 2000;

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
    return { state: 'running', trackedPgid: candidate, identities: new Map(members.map((process) => [process.pid, process.lstart])) };
  }
  const members = [...processes.values()].filter((process) => process.pgid === snapshot.trackedPgid);
  const knownAlive = members.some((process) => {
    const knownStart = snapshot.identities.get(process.pid);
    return knownStart !== undefined && isSameProcessStart(process.lstart, knownStart);
  });
  if (!knownAlive) return { state: 'exited', terminal: true };
  const identities = new Map(snapshot.identities);
  for (const process of members) identities.set(process.pid, process.lstart);
  return { state: 'running', identities };
}

function createAgentLifecycleStore(options = {}) {
  const platform = options.platform || process.platform;
  const listProcesses = options.listProcesses || listProcessTable;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const states = new Map();
  let closed = false;
  const stop = (entry) => { entry.cancelled = true; if (entry.timer) clearTimer(entry.timer); entry.timer = null; };
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
  return {
    initialize(termId, generation) {
      const id = String(termId); const previous = states.get(id); if (previous) stop(previous);
      states.set(id, { generation, state: null, cancelled: false, timer: null, polling: false });
    },
    async monitor(termId, generation, shellPid) {
      const id = String(termId); const previous = states.get(id); if (previous) stop(previous);
      const entry = { generation, state: null, shellPid, shellLstart: null, trackedPgid: null, identities: new Map(), cancelled: false, timer: null, polling: false };
      states.set(id, entry);
      if (platform === 'win32' || !Number.isSafeInteger(shellPid) || shellPid <= 0) return false;
      let processes;
      try { processes = await listProcesses(); } catch (_error) { return false; }
      if (states.get(id) !== entry || entry.cancelled || closed) return false;
      const shell = processes.get(shellPid);
      if (!shell) return false;
      entry.shellLstart = shell.lstart;
      schedule(id, entry);
      return true;
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

module.exports = { PS_ARGS, parseProcessTable, listProcessTable, isDescendant, inspectLifecycle, createAgentLifecycleStore, mergeAgentLifecycleStates };
