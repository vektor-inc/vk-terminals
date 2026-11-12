'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { isSameProcessStart, isDescendant, listProcessTable } = require('./agentLifecycle');
const SUBAGENT_TTL_MS = 10 * 60 * 1000;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,160}$/;

// 同じ PID でも開始時刻が変われば、次の確認から数え直す。
function inspectBackgroundProcesses(snapshot, processes, previous = new Set()) {
  if (!snapshot || !processes || snapshot.state !== 'running') return { alive: false, candidates: new Set(), running: false };
  const identities = [...(snapshot.trackedGroups || new Map()).values()].flatMap(group => [...group]);
  const roots = identities.map(([pid, start]) => processes.get(pid)).filter(p =>
    p && !/^[ZX]/.test(p.stat) && p.ppid === snapshot.shellPid && identities.some(([pid, start]) => pid === p.pid && isSameProcessStart(start, p.lstart)));
  const candidates = new Set();
  for (const p of processes.values()) {
    if (/^[ZX]/.test(p.stat)) continue;
    if (roots.some(root => p.pgid !== root.pgid && p.tpgid <= 0 && isDescendant(processes, p.pid, root.pid, root.lstart))) {
      candidates.add(`${p.pid}:${p.lstart}`);
    }
  }
  return { alive: roots.length > 0, candidates, running: [...candidates].some(key => previous.has(key)) };
}

// フックが示す既知の transcript 形からだけ、同じ agent_id のファイルを求める。
function agentTranscriptPaths(input, homeDir = os.homedir()) {
  if (typeof input.agent_id !== 'string' || typeof input.session_id !== 'string' ||
      !SAFE_ID.test(input.agent_id) || !SAFE_ID.test(input.session_id)) return null;
  const base = path.join(homeDir, '.claude', 'projects');
  const transcript = input.agent_transcript_path || input.transcript_path;
  if (typeof transcript !== 'string' || !path.isAbsolute(transcript)) return null;
  const relative = path.relative(base, transcript).split(path.sep);
  let project;
  if (relative.length === 2 && relative[1] === `${input.session_id}.jsonl`) project = relative[0];
  if (relative.length === 4 && relative[1] === input.session_id && relative[2] === 'subagents' && relative[3] === `agent-${input.agent_id}.jsonl`) project = relative[0];
  if (!project || project === '..' || !/^[a-zA-Z0-9_.-]+$/.test(project)) return null;
  const jsonl = path.join(base, project, input.session_id, 'subagents', `agent-${input.agent_id}.jsonl`);
  return { base, jsonl, meta: jsonl.replace(/\.jsonl$/, '.meta.json') };
}

function readAgentEvidence(paths, fsImpl = fs) {
  if (!paths) return {};
  // realpath の一致で途中のシンボリックリンクから別の場所へ抜ける経路も拒否する。
  const safe = filename => fsImpl.realpathSync(filename) === filename && fsImpl.realpathSync(paths.base) === paths.base;
  let modifiedAt;
  let finished = false;
  try {
    if (safe(paths.jsonl)) {
      const stat = fsImpl.statSync(paths.jsonl);
      if (stat.isFile()) modifiedAt = stat.mtimeMs;
    }
  } catch (_) {}
  try {
    if (safe(paths.meta)) {
      const stat = fsImpl.statSync(paths.meta);
      if (stat.isFile() && stat.size <= 65536) finished = JSON.parse(fsImpl.readFileSync(paths.meta, 'utf8')).finished === true;
    }
  } catch (_) {}
  return { modifiedAt, finished };
}

// 記録ファイルの置き場所から、そのセッションのプロジェクト名を取り出す。
function transcriptProject(paths) {
  if (!paths) return null;
  const [project] = path.relative(paths.base, paths.jsonl).split(path.sep);
  return project && project !== '..' && /^[a-zA-Z0-9_.-]+$/.test(project) ? project : null;
}

// アプリが閉じていた間の開始・終了は通知で取り戻せないため、セッションの記録ファイルを数え直す。
function listSessionSubagents(project, session, homeDir = os.homedir(), fsImpl = fs) {
  if (typeof project !== 'string' || typeof session !== 'string' || !SAFE_ID.test(session) ||
      project === '..' || !/^[a-zA-Z0-9_.-]{1,160}$/.test(project)) return [];
  const base = path.join(homeDir, '.claude', 'projects');
  const directory = path.join(base, project, session, 'subagents');
  let names;
  try {
    if (fsImpl.realpathSync(directory) !== directory) return [];
    names = fsImpl.readdirSync(directory);
  } catch (_) { return []; }
  const agents = [];
  for (const name of names) {
    const match = /^agent-([a-zA-Z0-9_-]{1,160})\.jsonl$/.exec(name);
    if (!match) continue;
    const jsonl = path.join(directory, name);
    agents.push({ agentId: match[1], paths: { base, jsonl, meta: jsonl.replace(/\.jsonl$/, '.meta.json') } });
    if (agents.length >= 256) break;
  }
  return agents;
}

function createBackgroundWorkStore({ getEntry, onChange = () => {}, onSession = () => {}, now = Date.now, homeDir, readEvidence = readAgentEvidence, listProcesses = listProcessTable, listSubagents = listSessionSubagents } = {}) {
  const entries = new Map();
  let polling = false;
  function publish(id, entry, running) {
    if (entry.running === running) return;
    entry.running = running;
    onChange(id, running);
  }
  function refreshAgents(entry) {
    for (const [id, agent] of entry.agents) {
      const evidence = readEvidence(agent.paths);
      if (Number.isFinite(evidence.modifiedAt)) agent.lastActivity = Math.max(agent.lastActivity, Math.min(now(), evidence.modifiedAt));
      if (evidence.finished || now() - agent.lastActivity >= SUBAGENT_TTL_MS) {
        entry.agents.delete(id);
        entry.stopped.add(id);
      }
    }
  }
  return {
    begin(id, generation, epoch = crypto.randomBytes(24).toString('hex')) {
      id = String(id);
      const entry = { generation, epoch, agents: new Map(), stopped: new Set(), candidates: new Set(), running: false, commandRunning: false, session: null, project: null, retiredSessions: new Set() };
      entries.set(id, entry);
      onChange(id, false);
      return entry.epoch;
    },
    // 再起動後に保存した合言葉で受け口を作り直し、記録ファイルの更新時刻でサブエージェントを見直す。
    restore(id, generation, epoch, { session, project } = {}) {
      this.begin(id, generation, epoch);
      const entry = entries.get(String(id));
      if (typeof session !== 'string' || !SAFE_ID.test(session) || typeof project !== 'string') return entry.epoch;
      entry.session = session;
      entry.project = project;
      for (const { agentId, paths } of listSubagents(project, session, homeDir)) {
        const evidence = readEvidence(paths);
        if (evidence.finished || !Number.isFinite(evidence.modifiedAt)) continue;
        const lastActivity = Math.min(now(), evidence.modifiedAt);
        if (now() - lastActivity < SUBAGENT_TTL_MS) entry.agents.set(agentId, { paths, lastActivity });
      }
      return entry.epoch;
    },
    recordHookEvent({ termId, epoch, input }) {
      const id = String(termId), entry = entries.get(id);
      if (!entry || epoch !== entry.epoch || !input || !['SessionStart', 'SubagentStart', 'SubagentStop'].includes(input.hook_event_name)) return false;
      if (input.source !== undefined && typeof input.source !== 'string') return false;
      if (getEntry(id, entry.generation)?.state !== 'running') return false;
      const paths = agentTranscriptPaths(input.hook_event_name === 'SessionStart' ? { ...input, agent_id: 'session-start' } : input, homeDir);
      if (!paths) return false;
      // 正規の再開通知では退役を解除し、元のセッションへ戻れるようにする。
      if (input.hook_event_name === 'SessionStart' && (input.source === undefined || input.source === 'resume')) entry.retiredSessions.delete(input.session_id);
      if (entry.retiredSessions.has(input.session_id)) return false;
      // /clear などでセッションが変わった後に、旧セッションの遅延通知を混ぜない。
      if (entry.session && entry.session !== input.session_id) {
        if (!['SessionStart', 'SubagentStart'].includes(input.hook_event_name)) return false;
        entry.retiredSessions.add(entry.session);
        entry.agents.clear();
        entry.stopped.clear();
      }
      if (entry.session !== input.session_id) {
        entry.session = input.session_id;
        entry.project = transcriptProject(paths);
        onSession(id, entry.generation, { session: entry.session, project: entry.project });
      }
      if (input.hook_event_name === 'SessionStart') {
        publish(id, entry, entry.commandRunning || entry.agents.size > 0);
        return true;
      }
      if (input.hook_event_name === 'SubagentStop') {
        entry.stopped.add(input.agent_id);
        entry.agents.delete(input.agent_id);
      } else if (!entry.stopped.has(input.agent_id) && !entry.agents.has(input.agent_id)) {
        entry.agents.set(input.agent_id, { paths, lastActivity: now() });
      }
      refreshAgents(entry);
      publish(id, entry, entry.commandRunning || entry.agents.size > 0);
      return true;
    },
    async poll() {
      if (polling || entries.size === 0) return;
      polling = true;
      try {
        let table;
        try { if ([...entries].some(([id, entry]) => getEntry(id, entry.generation)?.state === 'running')) table = await listProcesses(); } catch (_) { table = null; }
        for (const [id, entry] of entries) {
          const result = inspectBackgroundProcesses(getEntry(id, entry.generation), table, entry.candidates);
          entry.candidates = result.candidates;
          entry.commandRunning = result.running;
          if (table && !result.alive) entry.agents.clear();
          refreshAgents(entry);
          publish(id, entry, (table ? result.alive : getEntry(id, entry.generation)?.state === 'running') && (result.running || entry.agents.size > 0));
        }
      } finally { polling = false; }
    },
    has(id) { return entries.has(String(id)); },
    isRunning(id) { return entries.get(String(id))?.running === true; },
    delete(id) { entries.delete(String(id)); onChange(String(id), false); },
  };
}

module.exports = { SUBAGENT_TTL_MS, inspectBackgroundProcesses, agentTranscriptPaths, readAgentEvidence, listSessionSubagents, createBackgroundWorkStore };
