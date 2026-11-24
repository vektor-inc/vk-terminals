'use strict';

// 起動試行（attemptId）の帳簿と受領判定（issue #657。仕様は docs/specification-launch-attempts.md を正とする）。
//
// 設計の要点（崩さないこと）:
//   - 同じ attemptId が何度届いても Codex は 1 つしか起動しない。確認と登録は同期処理の中で続けて行い、
//     記録フォルダは排他作成（mkdir が EEXIST で失敗する）にする。ペインの作成時にも claimPane で照合し、
//     時間切れの後に画面側が遅れてペインを作ろうとしても弾く。
//   - 受け付けた後の失敗は HTTP エラーにせず phase で返す。retry の allowed / not-useful は phase が rejected のときだけ出す。
//   - 受領の判定は、起動ごとに新しく作る専用 CODEX_HOME の sessions 配下の rollout に、要約値（SHA-256）が一致する
//     利用者の発言があるかで行う。画面の文字列には依存しない。子の Codex（member/）の記録は見ない。
//   - 本文・ファイルパス・会話の中身は応答に含めない。本文は受領か最終状態で消し、要約値だけを残す。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveUid, isPrivateDirectory, readPrivateJson, writePrivateJson } = require('./privateFile');

const CONTRACT_VERSION = 1;
const SUPPORTED_AGENTS = Object.freeze(['codex']);
const RECEIPT_METHOD = 'codex-rollout-v1';
const MAX_PROMPT_BYTES = 64 * 1024;
const SUPPORTED_SHELLS = Object.freeze(['sh', 'bash', 'zsh']);
const RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LIVE_RECORDS = 1000;
const MAX_TOMBSTONES = 10000;
// 受け付けてからペインの作成（claimPane）までの上限。過ぎたら rejected にし、遅れて届いた作成要求を弾く。
const PANE_CREATION_TIMEOUT_MS = 30_000;
// 起動コマンドを書いてから受領を確認するまでの上限。過ぎたら unknown（自動再試行しない）。
const RECEIPT_TIMEOUT_MS = 180_000;
// rollout は先頭だけ読む（初期指示は先頭近くに記録される）。
const MAX_ROLLOUT_READ_BYTES = 16 * 1024 * 1024;
const RECORD_VERSION = 1;

const ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// 新規ペイン API と同じ起動オプションのうち、Codex の起動試行で意味のあるものだけを受け付ける。
const ALLOWED_FIELDS = Object.freeze(['attemptId', 'agent', 'cwd', 'prompt', 'codexPolicy', 'approvalPolicy', 'sandboxMode', 'model', 'stashed']);

const PHASES = Object.freeze({ REJECTED: 'rejected', AWAITING: 'awaiting-receipt', RECEIVED: 'received', UNKNOWN: 'unknown' });
const FINAL_PHASES = new Set([PHASES.REJECTED, PHASES.RECEIVED, PHASES.UNKNOWN]);

// 機械向けの固定コード → retry と既定の文言。HTTP の状態コードは呼び出し側（main.js）が決める。
const ERRORS = Object.freeze({
  INVALID_JSON: { retry: 'not-useful', message: 'request body is not valid JSON' },
  UNKNOWN_FIELD: { retry: 'not-useful', message: 'unknown field' },
  INVALID_ATTEMPT_ID: { retry: 'not-useful', message: 'attemptId must be a lowercase UUID v4' },
  UNSUPPORTED_AGENT: { retry: 'not-useful', message: 'agent must be "codex"' },
  INVALID_CWD: { retry: 'not-useful', message: 'cwd must be an existing absolute directory' },
  INVALID_PROMPT: { retry: 'not-useful', message: 'prompt must be a non-empty string without NUL' },
  PROMPT_TOO_LARGE: { retry: 'not-useful', message: `prompt exceeds ${MAX_PROMPT_BYTES} bytes (UTF-8)` },
  CODEX_POLICY_REQUIRED: { retry: 'not-useful', message: 'codexPolicy is required' },
  INVALID_LAUNCH_OPTIONS: { retry: 'not-useful', message: 'invalid launch options' },
  UNSUPPORTED_SHELL: { retry: 'not-useful', message: 'pane shell must be sh, bash or zsh' },
  ATTEMPT_CONFLICT: { retry: 'not-useful', message: 'attemptId was already used with a different request' },
  ATTEMPT_EXPIRED: { retry: 'not-useful', message: 'attemptId has expired' },
  FORBIDDEN_ORIGIN: { retry: 'not-useful', message: 'forbidden origin' },
  PAYLOAD_TOO_LARGE: { retry: 'not-useful', message: 'payload too large' },
  APP_SHUTTING_DOWN: { retry: 'allowed', message: 'app is shutting down' },
  WINDOW_UNAVAILABLE: { retry: 'allowed', message: 'window not available' },
  CODEX_POLICY_UNAVAILABLE: { retry: 'allowed', message: 'codex task policy is not available' },
  GITHUB_UNREACHABLE: { retry: 'allowed', message: 'GitHub is not reachable' },
  LEDGER_UNAVAILABLE: { retry: 'allowed', message: 'launch attempt ledger is not available' },
  LEDGER_FULL: { retry: 'allowed', message: 'launch attempt ledger is full' },
  // 受け付けた後、Codex を起動する前に止まったもの（帳簿に残るため、同じ attemptId では結果が変わらない）。
  PANE_CREATION_FAILED: { retry: 'not-useful', message: 'pane could not be created; Codex was not launched (use a new attemptId)' },
  PANE_CREATION_TIMEOUT: { retry: 'not-useful', message: 'pane was not created in time; Codex was not launched (use a new attemptId)' },
  LAUNCH_CANCELLED: { retry: 'not-useful', message: 'launch was cancelled before writing; Codex was not launched (use a new attemptId)' },
  LEDGER_WRITE_FAILED: { retry: 'not-useful', message: 'launch intent could not be saved; Codex was not launched (use a new attemptId)' },
  APP_RESTARTED_BEFORE_LAUNCH: { retry: 'not-useful', message: 'app restarted before launch; Codex was not launched (use a new attemptId)' },
  // 起動した可能性があるもの（自動で送り直してはいけない）。
  LAUNCH_WRITE_FAILED: { retry: 'forbidden', message: 'writing the launch command failed' },
  RECEIPT_TIMEOUT: { retry: 'forbidden', message: 'receipt was not confirmed in time' },
  PANE_CLOSED: { retry: 'forbidden', message: 'pane was closed before receipt' },
  PANE_REPLACED: { retry: 'forbidden', message: 'pane agent was replaced before receipt' },
  APP_RESTARTED: { retry: 'forbidden', message: 'app restarted before receipt' },
  AGENT_EXITED_EARLY: { retry: 'forbidden', message: 'agent exited right after launch without receipt' },
  ROLLOUT_UNREADABLE: { retry: 'forbidden', message: 'session record could not be read' },
  ROLLOUT_UNRECOGNIZED: { retry: 'forbidden', message: 'session record format is not recognized' },
  RECORD_UNREADABLE: { retry: 'forbidden', message: 'attempt record could not be read' },
  ATTEMPT_NOT_FOUND: { retry: 'forbidden', message: 'attempt not found in this ledger' },
  INTERNAL_ERROR: { retry: 'forbidden', message: 'internal server error' },
});

function makeError(code, message) {
  const known = ERRORS[code];
  return { code, retry: known ? known.retry : 'forbidden', message: message || (known ? known.message : code) };
}

function isValidAttemptId(value) {
  return typeof value === 'string' && ATTEMPT_ID_PATTERN.test(value);
}

/**
 * Codex へ渡す本文に正規化する。改行は LF にそろえ、前後の空白を除く。
 * シェルのコマンド置換（"$(cat …)"）は末尾の改行を落とすため、渡る本文と要約値の対象をここで一致させる。
 * @param {string} prompt
 * @returns {string}
 */
function normalizePrompt(prompt) {
  return prompt.replace(/\r\n?/g, '\n').trim();
}

/**
 * 本文の要約値（UTF-8 の SHA-256）。同じ本文かを確かめるための値で、本文そのものは復元できない。
 * @param {string} text 正規化済みの本文
 * @returns {string} "sha256:<16進64桁>"
 */
function computePromptDigest(text) {
  return `sha256:${crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * POST /api/launch-attempts の本文を検証する。値の妥当性だけを見て、環境（窓・シェル・ポリシー）は見ない。
 * @param {unknown} parsed JSON.parse 済みの本文
 * @param {object} deps
 * @param {(engine: string, options: object) => {ok: boolean, error?: string, approvalPolicy?: string, sandboxMode?: string, codexPolicy?: object}} deps.validateCodexLaunchOptions
 * @param {(engine: string, model: unknown) => boolean} deps.isValidModelForEngine
 * @param {(cwd: string) => boolean} deps.isDirectory
 * @returns {{ok: true, request: object} | {ok: false, error: object, attemptId?: string}}
 */
function validateLaunchAttemptRequest(parsed, deps) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: makeError('INVALID_JSON', 'request body must be a JSON object') };
  const attemptId = isValidAttemptId(parsed.attemptId) ? parsed.attemptId : undefined;
  const fail = (code, message) => ({ ok: false, error: makeError(code, message), ...(attemptId ? { attemptId } : {}) });
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_FIELDS.includes(key)) return fail('UNKNOWN_FIELD', `unknown field: ${key.slice(0, 64)}`);
  }
  if (!attemptId) return fail('INVALID_ATTEMPT_ID');
  if (!SUPPORTED_AGENTS.includes(parsed.agent)) return fail('UNSUPPORTED_AGENT');
  if (typeof parsed.cwd !== 'string' || !path.isAbsolute(parsed.cwd) || /[\x00-\x1f\x7f]/.test(parsed.cwd) || !deps.isDirectory(parsed.cwd)) return fail('INVALID_CWD');
  if (typeof parsed.prompt !== 'string' || parsed.prompt.includes('\0')) return fail('INVALID_PROMPT');
  const prompt = normalizePrompt(parsed.prompt);
  if (prompt === '') return fail('INVALID_PROMPT');
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) return fail('PROMPT_TOO_LARGE');
  if (parsed.codexPolicy === undefined) return fail('CODEX_POLICY_REQUIRED');
  const codexOptions = deps.validateCodexLaunchOptions('codex', parsed);
  if (!codexOptions.ok) return fail('INVALID_LAUNCH_OPTIONS', codexOptions.error);
  if (parsed.model !== undefined && !deps.isValidModelForEngine('codex', parsed.model)) return fail('INVALID_LAUNCH_OPTIONS', 'invalid model');
  if (parsed.stashed !== undefined && typeof parsed.stashed !== 'boolean') return fail('INVALID_LAUNCH_OPTIONS', 'stashed must be a boolean');
  const options = {
    cwd: parsed.cwd,
    codexPolicy: codexOptions.codexPolicy,
    ...(codexOptions.approvalPolicy !== undefined ? { approvalPolicy: codexOptions.approvalPolicy } : {}),
    ...(codexOptions.sandboxMode !== undefined ? { sandboxMode: codexOptions.sandboxMode } : {}),
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    ...(parsed.stashed !== undefined ? { stashed: parsed.stashed } : {}),
  };
  const promptDigest = computePromptDigest(prompt);
  const fingerprint = computePromptDigest(stableStringify({ agent: parsed.agent, ...options }));
  return { ok: true, request: { attemptId, agent: parsed.agent, prompt, promptDigest, fingerprint, options } };
}

/**
 * 起動するシェルが本文の受け渡し（"$(cat '<パス>')"）に対応するか。
 * @param {string} shellPath
 * @param {string} platform
 */
function isSupportedLaunchShell(shellPath, platform = process.platform) {
  if (platform === 'win32' || typeof shellPath !== 'string') return false;
  return SUPPORTED_SHELLS.includes(path.basename(shellPath));
}

/**
 * 起動コマンドの末尾に付ける、本文ファイルを起動引数として渡す断片。シェルに打ち込むのは短いパスだけ。
 * `--` の後ろに置き、"-" で始まる本文もオプションとして解釈させない。
 * @param {string} promptPath 本文ファイルの絶対パス
 * @returns {string}
 */
function buildPromptArgument(promptPath) {
  if (typeof promptPath !== 'string' || !path.isAbsolute(promptPath) || /['\x00-\x1f\x7f]/.test(promptPath)) {
    throw new Error('unsafe launch attempt prompt path');
  }
  return `-- "$(cat '${promptPath}')"`;
}

function userTextsOf(entry) {
  const payload = entry && typeof entry === 'object' ? entry.payload : null;
  if (!payload || typeof payload !== 'object') return [];
  const texts = [];
  const pushContent = (content, types) => {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (part && typeof part.text === 'string' && (!types || types.includes(part.type))) texts.push(part.text);
    }
  };
  // 新しい形式: response_item（role=user の message）と、event_msg の item_completed（item.type=UserMessage）。
  if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user') pushContent(payload.content, ['input_text']);
  if (entry.type === 'event_msg' && payload.type === 'item_completed' && payload.item && payload.item.type === 'UserMessage') pushContent(payload.item.content);
  // 古い形式: event_msg の user_message。
  if (entry.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') texts.push(payload.message);
  return texts;
}

/**
 * rollout（JSON Lines）の中に、要約値が一致する利用者の発言があるかを調べる。
 * 先頭は AGENTS.md などの文脈が入るため、「最初の発言」ではなく「一致する発言があるか」で判定する。
 * @param {string} text rollout の内容（途中までの場合、最後の行は書きかけとして扱う）
 * @param {string} promptDigest
 * @returns {{status: 'matched', sessionId: string} | {status: 'pending'} | {status: 'unrecognized'}}
 */
function findPromptReceiptInRollout(text, promptDigest) {
  const lines = text.split('\n');
  const complete = lines.slice(0, -1);
  const tail = lines[lines.length - 1];
  const entries = [];
  for (const line of complete) {
    if (line.trim() === '') continue;
    try { entries.push(JSON.parse(line)); } catch (_) { return { status: 'unrecognized' }; }
  }
  if (tail.trim() !== '') {
    try { entries.push(JSON.parse(tail)); } catch (_) { /* 書きかけの最後の行 */ }
  }
  if (entries.length === 0) return { status: 'pending' };
  const meta = entries[0];
  if (!meta || meta.type !== 'session_meta' || !meta.payload || typeof meta.payload.id !== 'string' || meta.payload.id === '') {
    return { status: 'unrecognized' };
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string') return { status: 'unrecognized' };
    for (const userText of userTextsOf(entry)) {
      if (computePromptDigest(userText) === promptDigest) return { status: 'matched', sessionId: meta.payload.id };
    }
  }
  return { status: 'pending' };
}

/**
 * 専用 CODEX_HOME の sessions 配下の rollout を調べる。子の Codex（member/）は別の CODEX_HOME なので対象外。
 * @returns {{status: 'matched', sessionId: string} | {status: 'pending'} | {status: 'unrecognized'} | {status: 'unreadable'}}
 */
function checkCodexHomeReceipt(codexHome, promptDigest, fsImpl = fs) {
  const sessionsDir = path.join(codexHome, 'sessions');
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch (error) {
      if (error.code === 'ENOENT' && dir === sessionsDir) return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
    }
  };
  try { walk(sessionsDir, 0); } catch (_) { return { status: 'unreadable' }; }
  let unrecognized = false;
  for (const file of files.sort()) {
    let text;
    try {
      const stat = fsImpl.lstatSync(file);
      if (!stat.isFile()) continue;
      const fd = fsImpl.openSync(file, fsImpl.constants.O_RDONLY | (fsImpl.constants.O_NOFOLLOW || 0));
      try {
        const size = Math.min(fsImpl.fstatSync(fd).size, MAX_ROLLOUT_READ_BYTES);
        const buffer = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          const read = fsImpl.readSync(fd, buffer, offset, size - offset, offset);
          if (read === 0) break;
          offset += read;
        }
        text = buffer.subarray(0, offset).toString('utf8');
      } finally { fsImpl.closeSync(fd); }
    } catch (_) { return { status: 'unreadable' }; }
    const result = findPromptReceiptInRollout(text, promptDigest);
    if (result.status === 'matched') return result;
    if (result.status === 'unrecognized') unrecognized = true;
  }
  return unrecognized ? { status: 'unrecognized' } : { status: 'pending' };
}

function toIso(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// 帳簿のルートの親フォルダ（~/.vk-terminals）が、本人所有の実フォルダで、他人が書き込めないか。
// 他人が書き込めると、ルートを消して差し替えられる。
function isSafeParentDirectory(directory, uid) {
  try {
    const stat = fs.lstatSync(directory);
    return !stat.isSymbolicLink() && stat.isDirectory() && (uid === undefined || stat.uid === uid) && (stat.mode & 0o022) === 0;
  } catch (_) { return false; }
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
// 保存済みの記録は外から書き換えられうるため、正規表現や添字に渡す前に型を確かめる。
// （RegExp#test や ERRORS[code] は値を暗黙に文字列へ変換するため、配列が素通りしたり、
// toString を持たないオブジェクトで TypeError になったりする。）
const isDigest = (value) => typeof value === 'string' && DIGEST_PATTERN.test(value);
const isKnownErrorCode = (value) => typeof value === 'string' && Object.prototype.hasOwnProperty.call(ERRORS, value);
const isTime = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isOptionalTime = (value) => value === null || isTime(value);
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOnlyKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
const RECORD_KEYS = Object.freeze(['version', 'attemptId', 'agent', 'promptDigest', 'fingerprint', 'phase', 'milestones', 'binding', 'requestAcceptedAt', 'launchIntentAt', 'earlyExitAt', 'codexHome', 'error', 'updatedAt', 'finalAt', 'recovered']);
const TOMBSTONE_KEYS = Object.freeze(['version', 'attemptId', 'tombstone', 'promptDigest', 'expiresAt']);
const RETRY_BY_PHASE = Object.freeze({ [PHASES.REJECTED]: ['allowed', 'not-useful'], [PHASES.UNKNOWN]: ['forbidden'] });

/**
 * 保存済みの記録（通常の記録・要約値だけの記録）が、必須項目・型・状態どうしの整合を満たすか。
 * 満たさない記録は、起動したかどうかを判断できないものとして扱う（呼び出し側が RECORD_UNREADABLE にする）。
 * @param {unknown} record
 * @param {string} attemptId フォルダ名
 * @returns {boolean}
 */
function isValidStoredRecord(record, attemptId) {
  if (!isPlainObject(record) || record.version !== RECORD_VERSION || record.attemptId !== attemptId) return false;
  if (record.tombstone !== undefined) {
    return record.tombstone === true && hasOnlyKeys(record, TOMBSTONE_KEYS) &&
      (record.promptDigest === null || isDigest(record.promptDigest)) && isTime(record.expiresAt);
  }
  if (!hasOnlyKeys(record, RECORD_KEYS)) return false;
  if (!SUPPORTED_AGENTS.includes(record.agent) || !isDigest(record.promptDigest) || !isDigest(record.fingerprint)) return false;
  if (!Object.values(PHASES).includes(record.phase)) return false;
  const { milestones, binding, error } = record;
  if (!isPlainObject(milestones) || !hasOnlyKeys(milestones, ['requestAccepted', 'launchWritten', 'receiptConfirmed'])) return false;
  if (!isTime(milestones.requestAccepted) || !isOptionalTime(milestones.launchWritten) || !isOptionalTime(milestones.receiptConfirmed)) return false;
  if (!isPlainObject(binding) || !hasOnlyKeys(binding, ['termId', 'paneGeneration', 'sessionId'])) return false;
  if (!(binding.termId === null || (typeof binding.termId === 'string' && binding.termId !== ''))) return false;
  if (!(binding.paneGeneration === null || (Number.isSafeInteger(binding.paneGeneration) && binding.paneGeneration >= 0))) return false;
  if (!(binding.sessionId === null || (typeof binding.sessionId === 'string' && binding.sessionId !== ''))) return false;
  if (record.requestAcceptedAt !== milestones.requestAccepted || !isTime(record.updatedAt)) return false;
  if (!isOptionalTime(record.launchIntentAt) || !isOptionalTime(record.earlyExitAt)) return false;
  if (record.finalAt !== undefined && !isTime(record.finalAt)) return false;
  if (record.recovered !== undefined && typeof record.recovered !== 'boolean') return false;
  if (!(record.codexHome === null || (typeof record.codexHome === 'string' && path.isAbsolute(record.codexHome)))) return false;
  if (error !== null) {
    if (!isPlainObject(error) || !hasOnlyKeys(error, ['code', 'retry', 'message']) || !isKnownErrorCode(error.code) || typeof error.message !== 'string') return false;
    if (error.retry !== ERRORS[error.code].retry) return false;
  }
  // 状態どうしの整合。起動コマンドを書いた記録には、書く意図とペインの結び付けが必ずある。
  const intent = record.launchIntentAt !== null;
  if (milestones.launchWritten !== null && !intent) return false;
  if (intent && (binding.termId === null || binding.paneGeneration === null)) return false;
  if (record.earlyExitAt !== null && milestones.launchWritten === null) return false;
  if ((milestones.receiptConfirmed !== null) !== (record.phase === PHASES.RECEIVED)) return false;
  if ((binding.sessionId !== null) !== (record.phase === PHASES.RECEIVED)) return false;
  switch (record.phase) {
    case PHASES.AWAITING:
      return error === null && record.finalAt === undefined;
    case PHASES.RECEIVED:
      return error === null && intent && isTime(record.finalAt);
    case PHASES.REJECTED:
      // 記録済みの rejected は Codex を起動していないものだけ（書く意図の記録より前に止まった）。
      return error !== null && RETRY_BY_PHASE[PHASES.REJECTED].includes(error.retry) && !intent && milestones.launchWritten === null && isTime(record.finalAt);
    case PHASES.UNKNOWN:
      return error !== null && RETRY_BY_PHASE[PHASES.UNKNOWN].includes(error.retry) && intent && isTime(record.finalAt);
    default:
      return false;
  }
}

/**
 * 起動試行の帳簿を作る。保存先は baseDir/<attemptId>/record.json（本文は同じフォルダの prompt.txt）。
 * 初期化に失敗したら例外にする（呼び出し側は LEDGER_UNAVAILABLE で拒否する）。
 * @param {object} params
 * @param {string} params.baseDir 帳簿の置き場（本人だけの 0700 フォルダにする）
 * @param {() => number} [params.now]
 * @param {() => string} [params.randomUUID]
 * @param {(message: string) => void} [params.log]
 * @param {object} [params.fs] テスト用の差し替え（rollout の読み取りにだけ使う）
 * @param {object} [params.hooks] テスト用。保存の失敗を再現する
 */
function createLaunchAttemptLedger({ baseDir, now = Date.now, randomUUID = crypto.randomUUID, log = () => {}, fs: fsImpl = fs, hooks = {} }) {
  const uid = resolveUid();
  if (!path.isAbsolute(baseDir) || /['\x00-\x1f\x7f]/.test(baseDir)) throw new Error('unsafe ledger directory');
  try { fs.mkdirSync(baseDir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!isPrivateDirectory(baseDir, uid) || !isSafeParentDirectory(path.dirname(baseDir), uid)) {
    throw new Error('ledger directory must be a private (0700) directory');
  }
  // 初期化時の帳簿のルートの実体。受付・保存（起動直前の意図の記録を含む）のたびに、同じ実体で、
  // まだ本人だけのフォルダかを確かめる（初期化の後に権限を変えられた・差し替えられた場合に書き込みと起動を止める）。
  const rootStat = fs.lstatSync(baseDir);
  const assertLedgerRoot = () => {
    let stat;
    try { stat = fs.lstatSync(baseDir); } catch (_) { throw new Error('ledger directory changed'); }
    if (stat.dev !== rootStat.dev || stat.ino !== rootStat.ino || !isPrivateDirectory(baseDir, uid) || !isSafeParentDirectory(path.dirname(baseDir), uid)) {
      throw new Error('ledger directory changed');
    }
  };
  // ledger.json が無いときだけ識別子を作る。あるのに読めない・識別子が欠けている・null・UUID でない場合は、
  // 作り直さずに利用不可にする（作り直すと ledgerId が変わり、照会側が帳簿の作り直しと取り違える）。
  let ledgerId;
  let identity;
  let identityMissing = false;
  try {
    identity = readPrivateJson(baseDir, 'ledger.json', uid);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    identityMissing = true;
  }
  if (identityMissing) {
    ledgerId = randomUUID();
    writePrivateJson(baseDir, 'ledger.json', { ledgerId, createdAt: toIso(now()) }, uid);
  } else {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity) || !isValidAttemptId(identity.ledgerId)) {
      throw new Error('ledger identity is unreadable');
    }
    ledgerId = identity.ledgerId;
  }

  // attemptId → { record, claimToken, listeners: Set<Function>, current: boolean }
  const entries = new Map();
  const attemptDir = (attemptId) => path.join(baseDir, attemptId);
  const promptPathOf = (attemptId) => path.join(attemptDir(attemptId), 'prompt.txt');

  const persist = (record) => {
    if (hooks.failPersist && hooks.failPersist(record)) throw new Error('simulated persist failure');
    assertLedgerRoot();
    writePrivateJson(attemptDir(record.attemptId), 'record.json', record, uid);
  };
  const persistQuietly = (record) => {
    try { persist(record); return true; } catch (error) {
      log(`launch attempt ${record.attemptId}: failed to save record (${error.message})`);
      return false;
    }
  };
  const removePrompt = (attemptId) => {
    try { fs.unlinkSync(promptPathOf(attemptId)); } catch (_) {}
  };
  const notify = (entry) => {
    for (const listener of [...entry.listeners]) {
      try { listener(entry.record); } catch (_) {}
    }
  };
  const update = (entry, changes) => {
    Object.assign(entry.record, changes, { updatedAt: now() });
    if (FINAL_PHASES.has(entry.record.phase)) {
      entry.record.finalAt = entry.record.finalAt || now();
      removePrompt(entry.record.attemptId);
    }
    persistQuietly(entry.record);
    notify(entry);
  };
  const finish = (entry, phase, code, message) => {
    update(entry, { phase, error: code ? makeError(code, message) : null });
  };

  // 前回の起動で残った記録を読み込み、再起動をまたいだものを整理する。
  const loadExisting = () => {
    let names = [];
    try { names = fs.readdirSync(baseDir); } catch (_) { names = []; }
    for (const name of names) {
      if (!isValidAttemptId(name)) continue;
      // 読み取りと検証を同じ try に置く。検証の途中で例外が出ても、その 1 件だけを隔離する。
      let record = null;
      let valid = false;
      try {
        record = readPrivateJson(attemptDir(name), 'record.json', uid);
        valid = isValidStoredRecord(record, name);
      } catch (_) { valid = false; }
      if (!valid) {
        // 読めない・壊れた・状態どうしが食い違う記録は、起動したかどうかを判断できない。
        // 「未起動・再依頼してよい」と誤って伝えないよう unknown（RECORD_UNREADABLE・forbidden）にし、
        // attemptId は使用済みとして扱って二重起動を防ぐ。
        entries.set(name, { record: { version: RECORD_VERSION, attemptId: name, agent: 'codex', phase: PHASES.UNKNOWN, unreadable: true, milestones: {}, binding: {}, error: makeError('RECORD_UNREADABLE'), requestAcceptedAt: now(), updatedAt: now(), finalAt: now() }, claimToken: null, listeners: new Set(), current: false });
        continue;
      }
      const entry = { record, claimToken: null, listeners: new Set(), current: false };
      entries.set(name, entry);
      if (record.tombstone) continue;
      if (record.phase === PHASES.AWAITING) {
        if (!record.launchIntentAt) {
          // 起動コマンドを書く前に止まった。Codex は一度も起動していない。
          finish(entry, PHASES.REJECTED, 'APP_RESTARTED_BEFORE_LAUNCH');
        } else {
          // 書いた後に止まった。受領を確認できれば received、ペインが生きていれば確認を続ける（refresh で判定）。
          record.recovered = true;
        }
      } else if (FINAL_PHASES.has(record.phase)) {
        removePrompt(name);
      }
    }
  };

  const liveCount = () => [...entries.values()].filter((entry) => !entry.record.tombstone).length;

  // 保持期間を過ぎた記録を要約値だけの記録にし、さらに期限を過ぎたものを消す。
  const prune = () => {
    const current = now();
    const tombstones = [];
    for (const [attemptId, entry] of entries) {
      const { record } = entry;
      if (record.tombstone) {
        if (current >= record.expiresAt) {
          entries.delete(attemptId);
          try { fs.rmSync(attemptDir(attemptId), { recursive: true, force: true }); } catch (_) {}
        } else tombstones.push(entry);
        continue;
      }
      if (FINAL_PHASES.has(record.phase) && current - (record.finalAt || record.updatedAt) >= RECORD_RETENTION_MS) {
        entry.record = {
          version: RECORD_VERSION,
          attemptId,
          tombstone: true,
          promptDigest: record.promptDigest || null,
          expiresAt: (record.requestAcceptedAt || current) + TOMBSTONE_RETENTION_MS,
        };
        removePrompt(attemptId);
        persistQuietly(entry.record);
        tombstones.push(entry);
      }
    }
    if (tombstones.length > MAX_TOMBSTONES) {
      tombstones.sort((a, b) => a.record.expiresAt - b.record.expiresAt);
      for (const entry of tombstones.slice(0, tombstones.length - MAX_TOMBSTONES)) {
        entries.delete(entry.record.attemptId);
        try { fs.rmSync(attemptDir(entry.record.attemptId), { recursive: true, force: true }); } catch (_) {}
      }
    }
  };

  loadExisting();
  prune();

  /**
   * 応答の本文（状態照会と同じ形）。本文・パス・会話の中身は含めない。
   */
  function toResponse(record) {
    if (!record) return null;
    if (record.tombstone) {
      // 照会では phase が unknown なので retry は forbidden（POST の 409 ATTEMPT_EXPIRED は処理前の拒否なので not-useful のまま）。
      return { attemptId: record.attemptId, ledgerId, phase: PHASES.UNKNOWN, reason: 'attempt-expired', error: { ...makeError('ATTEMPT_EXPIRED'), retry: 'forbidden' } };
    }
    const milestones = record.milestones || {};
    const binding = record.binding || {};
    return {
      attemptId: record.attemptId,
      agent: record.agent,
      ledgerId,
      contractVersion: CONTRACT_VERSION,
      phase: record.phase,
      milestones: {
        requestAccepted: toIso(milestones.requestAccepted),
        launchWritten: toIso(milestones.launchWritten),
        receiptConfirmed: toIso(milestones.receiptConfirmed),
      },
      binding: {
        termId: binding.termId || null,
        paneGeneration: Number.isSafeInteger(binding.paneGeneration) ? binding.paneGeneration : null,
        sessionId: binding.sessionId || null,
        promptDigest: record.promptDigest || null,
      },
      receipt: { method: RECEIPT_METHOD },
      ...(record.error ? { error: record.error } : {}),
    };
  }

  function notFoundResponse(attemptId) {
    return { attemptId, ledgerId, phase: PHASES.UNKNOWN, reason: 'attempt-not-found', error: makeError('ATTEMPT_NOT_FOUND') };
  }

  /**
   * 受け付ける前の照合。既存の記録があれば、その状態か衝突を返す。
   * @returns {{status: 'none'} | {status: 'existing', record: object} | {status: 'conflict'} | {status: 'expired'}}
   */
  function match(request) {
    // 同じ attemptId の送り直ししか来なくても保持期間を適用するため、照合の前に整理する。
    prune();
    const entry = entries.get(request.attemptId);
    if (!entry) return { status: 'none' };
    const { record } = entry;
    if (record.tombstone) return { status: 'expired' };
    if (record.unreadable || record.promptDigest !== request.promptDigest || record.fingerprint !== request.fingerprint) return { status: 'conflict' };
    return { status: 'existing', record };
  }

  /**
   * 受け付けて記録する。確認と登録の間に await を挟まない（同時に届いた 2 本目は必ず 1 本目の記録を見る）。
   * @returns {{status: 'accepted', record: object} | {status: 'existing', record: object} | {status: 'conflict'} | {status: 'expired'} | {status: 'full'} | {status: 'unavailable'}}
   */
  function accept(request) {
    const matched = match(request);
    if (matched.status !== 'none') return matched;
    if (liveCount() >= MAX_LIVE_RECORDS) return { status: 'full' };
    // 初期化の後に帳簿のルートの権限が変わった・差し替えられた場合は受け付けない（LEDGER_UNAVAILABLE）。
    try { assertLedgerRoot(); } catch (error) {
      log(`launch attempt ${request.attemptId}: ledger directory is not safe (${error.message})`);
      return { status: 'unavailable' };
    }
    const acceptedAt = now();
    const record = {
      version: RECORD_VERSION,
      attemptId: request.attemptId,
      agent: request.agent,
      promptDigest: request.promptDigest,
      fingerprint: request.fingerprint,
      phase: PHASES.AWAITING,
      milestones: { requestAccepted: acceptedAt, launchWritten: null, receiptConfirmed: null },
      binding: { termId: null, paneGeneration: null, sessionId: null },
      requestAcceptedAt: acceptedAt,
      launchIntentAt: null,
      earlyExitAt: null,
      codexHome: null,
      error: null,
      updatedAt: acceptedAt,
    };
    const entry = { record, claimToken: null, listeners: new Set(), current: true };
    // 1. メモリ上の帳簿へ登録する。
    entries.set(request.attemptId, entry);
    // 2. 受け付けの記録と本文を保存する。失敗したら登録を取り消す。
    let createdDir = false;
    try {
      fs.mkdirSync(attemptDir(request.attemptId), { mode: 0o700 });
      createdDir = true;
      fs.chmodSync(attemptDir(request.attemptId), 0o700);
      const fd = fs.openSync(promptPathOf(request.attemptId), 'wx', 0o600);
      try { fs.writeSync(fd, request.prompt); } finally { fs.closeSync(fd); }
      persist(record);
    } catch (error) {
      entries.delete(request.attemptId);
      if (createdDir) { try { fs.rmSync(attemptDir(request.attemptId), { recursive: true, force: true }); } catch (_) {} }
      log(`launch attempt ${request.attemptId}: failed to save acceptance (${error.message})`);
      return { status: 'unavailable' };
    }
    return { status: 'accepted', record };
  }

  /**
   * ペインの作成を 1 回だけ許可する。受け付け済みで未作成のものだけが通り、合言葉を返す。
   * 時間切れ・最終状態・作成済みの場合は例外にする（遅れて届いた作成要求で第二のペインを作らない）。
   */
  function claimPane(attemptId) {
    const entry = entries.get(attemptId);
    if (!entry || !entry.current) throw new Error('launch attempt is not pending');
    expirePaneCreation(entry);
    if (entry.record.phase !== PHASES.AWAITING || entry.claimToken !== null || entry.record.launchIntentAt) {
      throw new Error('launch attempt is not pending');
    }
    entry.claimToken = randomUUID();
    return { attemptId, token: entry.claimToken, promptPath: promptPathOf(attemptId) };
  }

  const claimedEntry = (claim) => {
    const entry = claim && entries.get(claim.attemptId);
    return entry && entry.claimToken === claim.token ? entry : null;
  };

  function bindPane(claim, { termId, paneGeneration, codexHome }) {
    const entry = claimedEntry(claim);
    if (!entry) return;
    update(entry, { binding: { ...entry.record.binding, termId: String(termId), paneGeneration }, codexHome: typeof codexHome === 'string' ? codexHome : null });
  }

  /**
   * 起動コマンドを書く直前に意図を記録する。保存できなければ false（書き込まない）。
   */
  function noteLaunchIntent(claim) {
    const entry = claimedEntry(claim);
    if (!entry || entry.record.phase !== PHASES.AWAITING || entry.record.launchIntentAt) return false;
    entry.record.launchIntentAt = now();
    entry.record.updatedAt = now();
    if (!persistQuietly(entry.record)) {
      entry.record.launchIntentAt = null;
      finish(entry, PHASES.REJECTED, 'LEDGER_WRITE_FAILED');
      return false;
    }
    return true;
  }

  function markLaunchWritten(claim) {
    const entry = claimedEntry(claim);
    if (!entry || entry.record.milestones.launchWritten) return;
    update(entry, { milestones: { ...entry.record.milestones, launchWritten: now() } });
  }

  function markLaunchWriteFailed(claim) {
    const entry = claimedEntry(claim);
    if (!entry || entry.record.phase !== PHASES.AWAITING) return;
    finish(entry, PHASES.UNKNOWN, 'LAUNCH_WRITE_FAILED');
  }

  /**
   * Codex を起動する前に止まったものを rejected にする。起動コマンドを書く意図を記録した後は対象外。
   * claim を渡したときはその合言葉の持ち主だけが、渡さないときは未作成（claim 前）のものだけが変えられる。
   */
  function markNotLaunched(attemptId, code, claim = null) {
    const entry = entries.get(attemptId);
    if (!entry || !entry.current || entry.record.phase !== PHASES.AWAITING || entry.record.launchIntentAt) return;
    if (claim ? entry.claimToken !== claim.token : entry.claimToken !== null) return;
    finish(entry, PHASES.REJECTED, code);
  }

  function markEarlyExit(claim) {
    const entry = claimedEntry(claim);
    if (!entry || entry.record.earlyExitAt) return;
    update(entry, { earlyExitAt: now() });
  }

  function expirePaneCreation(entry) {
    const { record } = entry;
    if (record.phase === PHASES.AWAITING && !record.launchIntentAt && entry.claimToken === null && now() - record.requestAcceptedAt >= PANE_CREATION_TIMEOUT_MS) {
      finish(entry, PHASES.REJECTED, 'PANE_CREATION_TIMEOUT');
    }
  }

  /**
   * 状態を 1 回だけ進める（受領の記録を 1 回確認する）。待ち合わせは呼び出し側で行う。
   * @param {string} attemptId
   * @param {{paneState: (termId: string, generation: number) => 'alive'|'closed'|'replaced'}} context
   * @returns {object|null} 記録（無ければ null）
   */
  function refresh(attemptId, { paneState }) {
    // 照会しか来なくても保持期間を適用するため、検索の前に整理する。
    prune();
    const entry = entries.get(attemptId);
    if (!entry) return null;
    const { record } = entry;
    if (record.tombstone || record.phase !== PHASES.AWAITING) return record;
    expirePaneCreation(entry);
    if (record.phase !== PHASES.AWAITING || !record.launchIntentAt) return record;
    if (record.codexHome) {
      const receipt = checkCodexHomeReceipt(record.codexHome, record.promptDigest, fsImpl);
      if (receipt.status === 'matched') {
        update(entry, {
          phase: PHASES.RECEIVED,
          error: null,
          binding: { ...record.binding, sessionId: receipt.sessionId },
          milestones: { ...record.milestones, receiptConfirmed: now() },
        });
        return entry.record;
      }
      if (receipt.status === 'unreadable') { finish(entry, PHASES.UNKNOWN, 'ROLLOUT_UNREADABLE'); return entry.record; }
      if (receipt.status === 'unrecognized') { finish(entry, PHASES.UNKNOWN, 'ROLLOUT_UNRECOGNIZED'); return entry.record; }
    }
    const state = record.binding.termId ? paneState(record.binding.termId, record.binding.paneGeneration) : 'closed';
    if (record.recovered && state !== 'alive') finish(entry, PHASES.UNKNOWN, 'APP_RESTARTED');
    else if (record.earlyExitAt) finish(entry, PHASES.UNKNOWN, 'AGENT_EXITED_EARLY');
    else if (state === 'closed') finish(entry, PHASES.UNKNOWN, 'PANE_CLOSED');
    else if (state === 'replaced') finish(entry, PHASES.UNKNOWN, 'PANE_REPLACED');
    else if (now() - (record.milestones.launchWritten || record.launchIntentAt) >= RECEIPT_TIMEOUT_MS) finish(entry, PHASES.UNKNOWN, 'RECEIPT_TIMEOUT');
    return entry.record;
  }

  /**
   * 「起動コマンドを書いた」か「最終状態になった」まで待つ。時間切れなら false。
   */
  function waitForLaunchOutcome(attemptId, timeoutMs, setTimer = setTimeout, clearTimer = clearTimeout) {
    const entry = entries.get(attemptId);
    const settled = (record) => !record || record.tombstone || FINAL_PHASES.has(record.phase) || Boolean(record.milestones && record.milestones.launchWritten);
    if (!entry || settled(entry.record)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = null;
      const listener = (record) => {
        if (!settled(record)) return;
        clearTimer(timer);
        entry.listeners.delete(listener);
        resolve(true);
      };
      timer = setTimer(() => { entry.listeners.delete(listener); resolve(false); }, timeoutMs);
      entry.listeners.add(listener);
    });
  }

  function get(attemptId) {
    const entry = entries.get(attemptId);
    return entry ? entry.record : null;
  }

  return {
    ledgerId,
    baseDir,
    toResponse,
    notFoundResponse,
    match,
    accept,
    claimPane,
    bindPane,
    noteLaunchIntent,
    markLaunchWritten,
    markLaunchWriteFailed,
    markNotLaunched,
    markEarlyExit,
    refresh,
    waitForLaunchOutcome,
    get,
    isLaunchWritten: (attemptId) => Boolean(get(attemptId)?.milestones?.launchWritten),
    isFinal: (attemptId) => { const record = get(attemptId); return Boolean(record && (record.tombstone || FINAL_PHASES.has(record.phase))); },
  };
}

/**
 * 対応機能の告知（GET /api/codex-task-capabilities の launchAttempts）。
 */
function describeLaunchAttemptCapability(ledger) {
  if (!ledger) return { available: false, reason: 'launch attempt ledger is not available' };
  return {
    available: true,
    contractVersion: CONTRACT_VERSION,
    agents: [...SUPPORTED_AGENTS],
    maxPromptBytes: MAX_PROMPT_BYTES,
    receiptMethods: [RECEIPT_METHOD],
    ledgerId: ledger.ledgerId,
  };
}

module.exports = {
  CONTRACT_VERSION,
  SUPPORTED_AGENTS,
  RECEIPT_METHOD,
  MAX_PROMPT_BYTES,
  RECORD_RETENTION_MS,
  TOMBSTONE_RETENTION_MS,
  MAX_LIVE_RECORDS,
  PANE_CREATION_TIMEOUT_MS,
  RECEIPT_TIMEOUT_MS,
  PHASES,
  ERRORS,
  makeError,
  isValidAttemptId,
  normalizePrompt,
  computePromptDigest,
  validateLaunchAttemptRequest,
  isSupportedLaunchShell,
  buildPromptArgument,
  findPromptReceiptInRollout,
  checkCodexHomeReceipt,
  createLaunchAttemptLedger,
  describeLaunchAttemptCapability,
};
