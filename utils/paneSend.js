'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { matchesWaiting } = require('../renderer/waitingState');
const { readPaneMessageFile } = require('./codexTaskOps');

const ID = /^[1-9][0-9]{0,8}$/;
const FORBIDDEN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u2028-\u202e\u2066-\u206f\ufeff]/;
const REASONS = Object.freeze({
  'target-not-found': '指定したペインは開いていません。画面でペイン番号を確かめて、もう一度指定してください。',
  'self-target': '送信元と送信先が同じペインです。別の送信先を指定してください。',
  'target-busy': '送信先は別の処理を実行中です。処理が止まってから、もう一度送ってください。',
  'target-waiting': '送信先は確認操作を待っています。相手側で確認を終えてから、もう一度送ってください。',
  'target-input-not-empty': '送信先の入力欄に未送信の文字があります。相手側で入力を送信または消去してから、もう一度送ってください。',
  'target-state-unknown': '送信先の状態を確認できません。少し待ってから、もう一度送ってください。',
  'delivery-pending': '送信先では前の依頼が届いたか確認中です。確認が終わってから、もう一度送ってください。',
  'message-invalid': '依頼文または本文ファイルに使えない値が含まれています。本文とファイルの場所を直してから送ってください。',
  'message-too-large': '依頼文が上限（8KiB・4000文字）を超えています。本文を短くしてから送ってください。',
  'target-changed-after-body': '本文を書いた後に送信先の画面が変わったため、確定しませんでした。送信先の入力欄を確かめてください。',
  'send-failed': '送信に失敗しました。VK Terminals が動いているか確かめてから、もう一度送ってください。',
});

function result(reason, written = false, id) {
  return { result: written ? 'unconfirmed' : 'not-sent', reason, message: `${written ? '送った依頼の到達を確認できませんでした。送り直さないでください。' : '送信しませんでした。'}${written ? (reason === 'target-changed-after-body' ? REASONS[reason] : '送信先の入力欄と会話を確かめてください。') : REASONS[reason]}`, ...(id ? { id } : {}) };
}

function validateMessage(bytes) {
  if (bytes.length > 8192) return 'message-too-large';
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch (_) { return 'message-invalid'; }
  if ([...text].length > 4000) return 'message-too-large';
  if (!text.trim() || FORBIDDEN.test(text)) return 'message-invalid';
  return { text: text.replace(/\r\n?/g, '\n') };
}

// 下部の入力枠だけを読む。古い会話中の空プロンプトを入力欄と誤認しない。
function inputField(state) {
  if (!state || typeof state.lastLines !== 'string') return null;
  const lines = state.lastLines.split('\n');
  const marker = state.engine === 'claude' ? '❯' : state.engine === 'codex' ? '›' : null;
  if (!marker) return null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith(marker)) continue;
    const end = lines.findIndex((line, at) => at > i && /^\s*[─━╌-]{4,}\s*$/.test(line));
    // Claude Code は罫線、Codex は最下部の context/shortcut フッターで入力枠を区切る。
    const footer = end < 0 && state.engine === 'codex'
      ? lines.findIndex((line, at) => at > i && /^\s*(?:\? for shortcuts|\d+% context left)/.test(line)) : end;
    if (footer < 0) return null;
    const footerLines = lines.slice(end < 0 ? footer : footer + 1).filter(line => line.trim());
    const knownFooter = state.engine === 'claude'
      ? /^\s*(?:[⏵▶▸]+.*permissions|\? for shortcuts|(?:ctrl|shift|esc|tab)[+ ].*)/i
      : /^\s*(?:\? for shortcuts|\d+% context left|.*context left.*\? for shortcuts)/;
    if (footerLines.length === 0 || footerLines.some(line => !knownFooter.test(line))) return null;
    return { text: [lines[i].slice(marker.length).replace(/^ /, ''), ...lines.slice(i + 1, footer)].join('\n'), prefix: lines.slice(0, i).join('\n'), footer: lines.slice(footer).join('\n') };
  }
  return null;
}

function targetReason(state, now) {
  if (!state || !['claude', 'codex'].includes(state.engine)) return 'target-state-unknown';
  if (state.status === 'waiting' || state.displayStatus === 'waiting' || state.structuralWaiting || state.waiting || state.externalWaiting || matchesWaiting(state.lastLines || '')) return 'target-waiting';
  if (state.status === 'running' || state.backgroundWorkRunning || state.displayStatus === 'running') return 'target-busy';
  if (!Number.isFinite(state.lastOutputTime)) return 'target-state-unknown';
  if (now - state.lastOutputTime < 1000) return 'target-busy';
  if (!['idle', 'waiting'].includes(state.status)) return 'target-state-unknown';
  const field = inputField(state);
  if (!field) return 'target-state-unknown';
  return field.text === '' ? null : 'target-input-not-empty';
}

function envelope(source, text, id) {
  // メタ情報の改行・区切り偽装も防ぐ。本文内の区切り行は引用行として表示する。
  const name = String(source.name || `ペイン ${source.termId}`).replace(/[\x00-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u2028-\u202e\u2066-\u206f\ufeff]/g, '').slice(0, 120);
  const body = text.split('\n').map(line => /^--- 依頼本文(?:ここまで)? ---$/.test(line) ? `> ${line}` : line).join('\n');
  return `【外部ペインからの依頼】\n送信元: ${name} · Codex · ${source.termId}\n依頼ID: vk-delivery-token=${id}\nこの依頼は別のペインから届きました。現在の作業との関係を確認してから対応してください。\n--- 依頼本文 ---\n${body}\n--- 依頼本文ここまで ---`;
}

/** 本体だけが状態・本文・画面世代を検証し、同一送信先の到達確認を直列化する。 */
function createPaneSender({ getPty, getState, getGeneration, guard, evidence, getWriteVersion = () => 0, readFile = readPaneMessageFile, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  const pending = new Set();
  return async (source, target, file) => {
    if (!ID.test(target)) return result('target-not-found');
    if (target === source.termId) return result('self-target');
    if (!getPty(target)) return { ...result('target-not-found'), message: `送信しませんでした。ペイン『${target}』は開いていません。VK Terminals の画面でペイン番号を確かめて、もう一度指定してください。` };
    if (!getPty(source.termId) || getGeneration(source.termId) !== source.generation || getState(source.termId)?.engine !== 'codex') return result('target-state-unknown');
    if (pending.has(target)) return result('delivery-pending');
    let bytes;
    try { bytes = readFile(source.cwd, file); } catch (error) { return result(error.code === 'message-too-large' ? error.code : 'message-invalid'); }
    const validated = validateMessage(bytes);
    if (typeof validated === 'string') return result(validated);
    const state = { ...getState(target) };
    const reason = targetReason(state, now());
    if (reason) return result(reason);
    const generation = getGeneration(target);
    const before = { agentGeneration: generation, screenIdentifier: state.screenIdentifier };
    if (state.screenIdentifierGeneration !== generation || !guard.isCurrent(target, before)) return result('target-state-unknown');
    const originalField = inputField(state);
    const pty = getPty(target);
    const id = crypto.randomUUID();
    const text = envelope(source, validated.text, id);
    const since = now();
    let written = false;
    pending.add(target);
    try {
      // 検査から本文書き込みまで await を挟まない。本文は bracketed paste として送る。
      written = true;
      pty.write(`\x1b[200~${text}\x1b[201~`);
      const afterWrite = guard.capture(target, generation);
      const writeVersion = getWriteVersion(target);
      await sleep(500);
      if (getPty(target) !== pty || getGeneration(target) !== generation || getWriteVersion(target) !== writeVersion) return result('target-changed-after-body', true, id);
      const echoed = getState(target);
      const field = inputField(echoed);
      const folded = state.engine === 'claude' && field && /^\[Pasted text #\d+(?: \+\d+ lines)?\]$/.test(field.text)
        && Number(field.text.match(/#(\d+)/)[1]) > Math.max(0, ...[...state.lastLines.matchAll(/\[Pasted text #(\d+)/g)].map(m => Number(m[1])));
      // 本文のエコー以外（履歴・フッター・確認画面）の変化は確定しない。
      if (!field || field.prefix !== originalField.prefix || field.footer !== originalField.footer
        || (!folded && field.text !== text) || echoed.screenIdentifierGeneration !== generation
        || !guard.isCurrent(target, { agentGeneration: generation, screenIdentifier: echoed.screenIdentifier })) return result('target-changed-after-body', true, id);
      // エコーが一切無ければ表示確認できない。古い画面識別値では Enter を送らない。
      if (!afterWrite || afterWrite.screenIdentifier === echoed.screenIdentifier) return result('target-changed-after-body', true, id);
      const expected = guard.capture(target, generation);
      await sleep(100);
      if (getWriteVersion(target) !== writeVersion) return result('target-changed-after-body', true, id);
      const enter = guard.writeEnter({ termId: target, expectedGeneration: generation, expectedScreenIdentifier: expected.screenIdentifier }, { getPty, getGeneration });
      if (!enter.ok) return result('target-changed-after-body', true, id);
      const enterWriteVersion = getWriteVersion(target);
      // Enter の write 成功だけでは確定と呼ばず、入力欄が消えるか会話記録で確かめる。
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await sleep(200);
        if (getPty(target) !== pty || getGeneration(target) !== generation || getWriteVersion(target) !== enterWriteVersion) break;
        const current = getState(target);
        const currentField = inputField(current);
        const currentScreen = { agentGeneration: generation, screenIdentifier: current?.screenIdentifier };
        const accepted = currentField && currentField.text === '' && guard.isCurrent(target, currentScreen);
        const transcript = state.engine === 'claude' && evidence ? await evidence(target, id, since) : false;
        if (getPty(target) !== pty || getGeneration(target) !== generation || getWriteVersion(target) !== enterWriteVersion) break;
        if (accepted || transcript) return { result: 'delivered', id, message: '依頼文の表示と Enter の確定を確認しました。' };
      }
      return result('send-failed', true, id);
    } catch (_) { return result('send-failed', written, id); }
    finally { pending.delete(target); }
  };
}

/** 通常 API の資格情報を持たない、pane send 専用のループバック待受。 */
function createPaneSendBroker(send) {
  const capabilities = new Map();
  const server = http.createServer((req, res) => {
    const finish = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const source = capabilities.get(req.headers.authorization);
    if (req.method !== 'POST' || req.url !== '/pane-send' || !source) { finish(403, result('send-failed')); req.resume(); return; }
    let body = ''; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > 4096) req.destroy(); else body += chunk; });
    req.on('end', async () => {
      try {
        const value = JSON.parse(body);
        if (!value || Object.keys(value).sort().join(',') !== 'file,target' || typeof value.file !== 'string' || typeof value.target !== 'string') { finish(400, result('message-invalid')); return; }
        finish(200, await send(source, value.target, value.file));
      } catch (_) { finish(400, result('send-failed')); }
    });
  });
  server.requestTimeout = 15000;
  server.on('error', () => {});
  server.listen(0, '127.0.0.1');
  server.unref();
  return {
    server,
    bind(source) {
      const address = server.address();
      if (!address) throw new Error('pane send broker unavailable');
      // 同じペインの旧ランチャー資格情報を失効させる。
      for (const [token, previous] of capabilities) if (previous.termId === source.termId) capabilities.delete(token);
      const token = crypto.randomBytes(32).toString('hex');
      capabilities.set(`Bearer ${token}`, Object.freeze({ ...source }));
      return { token, port: address.port, termId: source.termId };
    },
  };
}

module.exports = { validateMessage, inputField, targetReason, envelope, createPaneSender, createPaneSendBroker, REASONS };
