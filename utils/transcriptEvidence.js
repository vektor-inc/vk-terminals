'use strict';

// ─── 会話記録（Claude Code の transcript jsonl）による「指示文の到達」確認（issue #417）──
// GET /api/transcript-evidence の照合ロジック。main.js に直書きせず、fs・home・環境変数を
// 差し替えられるようにして単体テストできる形で切り出している（Electron 非依存）。
//
// 背景: vk-orchestrator は指示文を送った後、画面の読み取りだけでは「届いたか」を判定
// できないことがある（実際には届いているのに未達と誤判定して二重送信になった）。
// 指示文に埋め込んだ識別子（UUID）が、ペインの作業ディレクトリに対応する Claude Code の
// 会話記録（`~/.claude/projects/<変換名>/*.jsonl`）へ「利用者の発話」として現れたかを
// 1 回だけ走査して答える。待ち合わせ（ポーリング）は呼び出し側（vk-orchestrator）が行う。
// 照合規則は vk-orchestrator の src/engine/transcript-evidence.js に合わせている。
//
// 会話記録の中身・ファイルパス・一致した行は呼び出し元へ返さず、ログにも出さない
// （返すのは「届いた／まだ／判定できない」の区別と理由コードだけ）。
//
// 【ファイルの mtime 絞り込みだけでは不十分な理由】
// セッションローテーションは同じ識別子を次のセッションへ引き継ぐため、古い識別子の行が
// 会話記録の先頭付近に残ったまま、別の追記で mtime だけ更新されることがある。そのため
// mtime によるファイル絞り込み（高速化）に加え、行自身の timestamp が since 以降かも確認する。

const nodeFs = require('fs');
const nodeOs = require('os');
const nodePath = require('path');

// 一般的な UUID（バージョン 1〜5）の形。外部から来た値を文字列一致に使う前に形だけ確かめる。
// 小文字のみ受け付ける（/i を付けない）。照合（line.includes）は大文字小文字を区別するため、
// 大文字を通すと「届いているのに pending のまま」になる。形式確認と照合の規則を揃えるため 400 にする。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// termId は main.js が採番する 1 以上の整数文字列（`String(nextId++)`）。
const TERM_ID_RE = /^[1-9][0-9]{0,8}$/;
// since はエポックミリ秒の整数（桁数の上限は現実的な時刻より十分大きい 16 桁）。
const SINCE_RE = /^[0-9]{1,16}$/;

// 1 回の走査で見る最大ファイル数（更新時刻が新しい順）。
const DEFAULT_MAX_FILES_SCANNED = 20;
// 1 ファイルあたり読む総バイト数の上限（8MiB）。これを超えるファイルは末尾の 8MiB だけを読む
// （長い会話に後から追記した指示文は末尾にあるため。issue #417 レビュー HIGH）。
const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024;
// 1 回の読み取り単位。
const DEFAULT_READ_CHUNK_BYTES = 64 * 1024;
// since からの許容余裕（mtime 粒度・時計のわずかなずれを吸収する）。
const DEFAULT_SINCE_GRACE_MS = 5000;

// since の受け付け範囲（issue #417 安藤レビュー MEDIUM-1）。since=0 のような古い値を許すと
// 1 回の要求で全ファイル・全バイト（最大 20 ファイル × 8MiB）を読ませる手段になるため、
// 「今より 24 時間以内」に絞る。呼び出し側は指示文を送った直後の時刻を渡すので十分な余裕がある。
const SINCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// 未来側は、呼び出し元との時計のずれを吸収する分だけ許す（1 分）。
const SINCE_FUTURE_TOLERANCE_MS = 60 * 1000;

// 応答の result 値と reason 値（綴りはここを正とする）。
const RESULT = Object.freeze({ DELIVERED: 'delivered', PENDING: 'pending', UNKNOWN: 'unknown' });
const REASON = Object.freeze({
  ENGINE_CODEX: 'engine-codex',
  CWD_UNKNOWN: 'cwd-unknown',
  TRANSCRIPT_UNREADABLE: 'transcript-unreadable',
  // 存在しないペイン。404 は呼び出し側（vk-orchestrator）が「この API を持たない古い版」と
  // みなす約束のため使わず、200 の unknown で返す。
  PANE_NOT_FOUND: 'pane-not-found',
  // 同じペインの照合が進行中。待たせず即答する。
  BUSY: 'busy',
});

function isValidTranscriptToken(token) {
  return typeof token === 'string' && UUID_RE.test(token);
}

/**
 * クエリ（URLSearchParams）の形式検証。不正なら { ok:false, error }（呼び出し側が 400 にする）。
 * @param {URLSearchParams} searchParams
 * @param {number} [now] 現在時刻（テスト用に差し替え可能）
 * @returns {{ ok: true, termId: string, token: string, sinceTimeMs: number } | { ok: false, error: string }}
 */
function parseTranscriptEvidenceQuery(searchParams, now = Date.now()) {
  const termId = searchParams.get('termId');
  const token = searchParams.get('token');
  const since = searchParams.get('since');
  if (termId === null || !TERM_ID_RE.test(termId)) {
    return { ok: false, error: 'invalid termId' };
  }
  if (!isValidTranscriptToken(token)) {
    return { ok: false, error: 'invalid token (UUID required)' };
  }
  if (since === null || !SINCE_RE.test(since)) {
    return { ok: false, error: 'invalid since (epoch milliseconds integer required)' };
  }
  const sinceTimeMs = Number(since);
  if (!Number.isSafeInteger(sinceTimeMs)) {
    return { ok: false, error: 'invalid since (epoch milliseconds integer required)' };
  }
  if (sinceTimeMs < now - SINCE_MAX_AGE_MS || sinceTimeMs > now + SINCE_FUTURE_TOLERANCE_MS) {
    return { ok: false, error: 'invalid since (must be within the last 24 hours)' };
  }
  return { ok: true, termId, token, sinceTimeMs };
}

/**
 * Claude Code が会話記録を保存する `projects` ディレクトリの根。
 * `CLAUDE_CONFIG_DIR` が設定されていればそれ（設定ディレクトリそのものの差し替え）を、
 * 無ければ `~/.claude` を使う。ここで読む環境変数は VK Terminals 本体プロセスのもので、
 * ペイン内の Claude Code の環境変数とは別（通常は同じ値）。
 */
function resolveClaudeProjectsRoot({ homeDir = nodeOs.homedir(), env = process.env } = {}) {
  const override = env && env.CLAUDE_CONFIG_DIR;
  const base = typeof override === 'string' && override.trim() !== ''
    ? override
    : nodePath.join(homeDir, '.claude');
  return nodePath.join(base, 'projects');
}

/** 作業ディレクトリの絶対パスを、Claude Code のプロジェクトディレクトリ名へ変換する（[A-Za-z0-9] 以外を `-` に）。 */
function encodeClaudeProjectDirName(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

function resolveClaudeProjectTranscriptDir(cwd, options = {}) {
  return nodePath.join(resolveClaudeProjectsRoot(options), encodeClaudeProjectDirName(cwd));
}

function isRealUserPromptLine(parsed) {
  if (!parsed || parsed.type !== 'user') return false;
  // ツール実行結果も type:"user" で記録されるが、利用者が打った指示文ではないので除外する。
  if (parsed.toolUseResult !== undefined) return false;
  const content = parsed.message && parsed.message.content;
  if (Array.isArray(content) && content.some((part) => part && part.type === 'tool_result')) return false;
  return true;
}

function lineTimestampIsAtOrAfter(parsed, sinceTimeMs) {
  const raw = parsed && parsed.timestamp;
  if (typeof raw !== 'string') return false;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return false;
  return ms >= sinceTimeMs;
}

/**
 * jsonl の 1 行が「token を含む実際のユーザー発話で、行自身の timestamp が sinceTimeMs 以降」か。
 * JSON.parse できない行（途中で切れた行など）は無害に false。timestamp が無い行も不一致（安全側）。
 */
function transcriptLineMatchesUserToken(line, token, sinceTimeMs) {
  if (!line || !line.includes(token)) return false;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (_e) {
    return false;
  }
  if (!isRealUserPromptLine(parsed)) return false;
  return lineTimestampIsAtOrAfter(parsed, sinceTimeMs);
}

// lstat 後の symlink 差し替え（TOCTOU）対策として open にも O_NOFOLLOW を付ける。
function createDefaultFsApi() {
  const flags = nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW || 0);
  return {
    readdir: (dir) => nodeFs.promises.readdir(dir, { withFileTypes: true }),
    lstat: (p) => nodeFs.promises.lstat(p),
    open: (p) => nodeFs.promises.open(p, flags),
    realpath: (p) => nodeFs.promises.realpath(p),
  };
}

// ファイルサイズが maxBytes 以下なら先頭から全部、超えるなら末尾の maxBytes だけをチャンク単位で読み、
// 一致する行が現れた時点で true。サイズは開いたファイルディスクリプタの fstat（handle.stat）で取る
// （lstat とのあいだにファイルが伸びても、読む範囲は open 後のサイズで決まる）。
// 読み始め位置が 0 でないとき、最初の改行までは「途中から切れた 1 行」なので判定に使わず捨てる。
// チャンク境界をまたぐ行は断片の配列（pending）にためておき、改行が見つかったときに 1 回だけ連結する。
// 改行の無い長い行でも、読み進めるたびにそれまでの分をコピーし直さない（issue #417 LOW-2）。
async function scanFileForToken(handle, token, { maxBytes, chunkSize, sinceTimeMs }) {
  const { size } = await handle.stat();
  const startPosition = size > maxBytes ? size - maxBytes : 0;
  const endPosition = startPosition + maxBytes;
  let position = startPosition;
  let skippingPartialLine = startPosition > 0;
  let pending = [];
  let hitEof = false;

  while (position < endPosition) {
    const toRead = Math.min(chunkSize, endPosition - position);
    const chunkBuffer = Buffer.alloc(toRead);
    const { bytesRead } = await handle.read(chunkBuffer, 0, toRead, position);
    position += bytesRead;

    if (bytesRead > 0) {
      const chunk = chunkBuffer.subarray(0, bytesRead);
      let start = 0;
      if (skippingPartialLine) {
        const firstNewline = chunk.indexOf(0x0a);
        if (firstNewline === -1) start = chunk.length;
        else {
          start = firstNewline + 1;
          skippingPartialLine = false;
        }
      }
      for (; start < chunk.length;) {
        const newlineIndex = chunk.indexOf(0x0a, start);
        if (newlineIndex === -1) {
          pending.push(chunk.subarray(start));
          break;
        }
        pending.push(chunk.subarray(start, newlineIndex));
        const lineText = (pending.length === 1 ? pending[0] : Buffer.concat(pending)).toString('utf8');
        pending = [];
        start = newlineIndex + 1;
        if (transcriptLineMatchesUserToken(lineText, token, sinceTimeMs)) return true;
      }
    }

    if (bytesRead < toRead) {
      hitEof = true;
      break;
    }
  }

  // 上限で切れた途中の断片は捨てる。EOF の最終行（改行なし）は判定する。
  // 途中から切れた先頭行を読み飛ばしている最中に EOF に達した場合、pending は空なので判定しない。
  return hitEof && pending.length > 0
    && transcriptLineMatchesUserToken(Buffer.concat(pending).toString('utf8'), token, sinceTimeMs);
}

// ディレクトリを 1 回だけ走査する。ENOENT（まだ書かれていない）は false、それ以外の I/O エラーは投げる。
async function scanTranscriptDirOnce(dir, token, { sinceTimeMs, maxFiles, maxReadBytes, readChunkBytes, fsApi }) {
  let entries;
  try {
    entries = await fsApi.readdir(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }

  const candidates = [];
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name;
    const looksLikeFile = typeof entry === 'string' ? true : entry.isFile();
    if (!looksLikeFile || !name.endsWith('.jsonl')) continue;

    const filePath = nodePath.join(dir, name);
    let stat;
    try {
      stat = await fsApi.lstat(filePath);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }
    if (stat.isSymbolicLink()) continue;
    // mtime が since より古いファイルは中身を見ない。
    if (stat.mtimeMs >= sinceTimeMs) candidates.push({ filePath, mtimeMs: stat.mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { filePath } of candidates.slice(0, maxFiles)) {
    let handle;
    try {
      handle = await fsApi.open(filePath);
    } catch (err) {
      // ENOENT: 走査中に消えた。ELOOP: symlink へ差し替えられ O_NOFOLLOW に弾かれた。
      if (err && (err.code === 'ENOENT' || err.code === 'ELOOP')) continue;
      throw err;
    }
    try {
      if (await scanFileForToken(handle, token, { maxBytes: maxReadBytes, chunkSize: readChunkBytes, sinceTimeMs })) {
        return true;
      }
    } finally {
      await handle.close();
    }
  }
  return false;
}

/**
 * 会話記録から「token を含む指示文が since 以降に届いたか」を 1 回だけ確認する。
 * 例外は投げない。戻り値は { result, reason? } のみ（会話記録の中身・パスは含めない）。
 *
 *   - engine === 'codex'                → unknown / engine-codex（保存形式が未確認で対象外）
 *   - cwd 未指定・空                     → unknown / cwd-unknown
 *   - 会話記録ディレクトリが無い（ENOENT） → pending（まだ書かれていないだけの可能性）
 *   - 上記以外の読み取りエラー            → unknown / transcript-unreadable
 *
 * @param {object} params
 * @param {string} params.cwd           ペインの実際の作業ディレクトリ
 * @param {string} params.token         UUID（形式検証済みであること。ここでも再確認する）
 * @param {number} params.sinceTimeMs   送信開始時刻（エポックミリ秒）
 * @param {string} [params.engine]
 * @param {object} [params.fsApi]       { readdir, lstat, open, realpath } の一部・全部を差し替え可能
 * @param {string} [params.homeDir]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @returns {Promise<{ result: 'delivered'|'pending'|'unknown', reason?: string }>}
 */
async function checkTranscriptEvidence({
  cwd,
  token,
  sinceTimeMs,
  engine,
  fsApi = {},
  homeDir = nodeOs.homedir(),
  env = process.env,
  maxFiles = DEFAULT_MAX_FILES_SCANNED,
  maxReadBytes = DEFAULT_MAX_READ_BYTES,
  readChunkBytes = DEFAULT_READ_CHUNK_BYTES,
  graceMs = DEFAULT_SINCE_GRACE_MS,
} = {}) {
  if (engine === 'codex') {
    return { result: RESULT.UNKNOWN, reason: REASON.ENGINE_CODEX };
  }
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    return { result: RESULT.UNKNOWN, reason: REASON.CWD_UNKNOWN };
  }
  if (!isValidTranscriptToken(token) || !Number.isSafeInteger(sinceTimeMs)) {
    // 呼び出し側（HTTP ハンドラ）が先に 400 にする想定。ここに来るのは内部の取り違えのみ。
    return { result: RESULT.UNKNOWN, reason: REASON.TRANSCRIPT_UNREADABLE };
  }

  const mergedFsApi = { ...createDefaultFsApi(), ...fsApi };

  // Claude Code 側は実体パスの cwd で記録することが多いため、可能なら realpath で解決する
  // （解決できなければ元の文字列のまま。ディレクトリ不在なら ENOENT として pending になる）。
  let resolvedCwd = cwd;
  try {
    resolvedCwd = await mergedFsApi.realpath(cwd);
  } catch (_e) {
    // 元の cwd のまま続行
  }

  const dir = resolveClaudeProjectTranscriptDir(resolvedCwd, { homeDir, env });
  try {
    const found = await scanTranscriptDirOnce(dir, token, {
      sinceTimeMs: sinceTimeMs - graceMs,
      maxFiles,
      maxReadBytes,
      readChunkBytes,
      fsApi: mergedFsApi,
    });
    return { result: found ? RESULT.DELIVERED : RESULT.PENDING };
  } catch (_e) {
    // エラーメッセージにはパスが含まれうるため、返さない・ログにも出さない。
    return { result: RESULT.UNKNOWN, reason: REASON.TRANSCRIPT_UNREADABLE };
  }
}

// 照合中の termId（同じペインの同時実行を 1 件に絞る。issue #417 MEDIUM-1）。
const defaultInFlight = new Set();

/**
 * GET /api/transcript-evidence の応答（HTTP ステータスと本文）を組み立てる。main.js の
 * ハンドラはこの戻り値をそのまま書き出すだけにして、分岐をここでテストできるようにする。
 *
 *   - クエリの形式不正（since が 24 時間より前・未来を含む） → 400 { error }
 *   - 存在しない termId               → 200 { result: 'unknown', reason: 'pane-not-found' }
 *     （404 は呼び出し側が「この API を持たない古い版」とみなす約束のため使わない）
 *   - 同じ termId の照合が進行中        → 200 { result: 'unknown', reason: 'busy' }（待たせない）
 *   - それ以外                          → 200 { result, reason? }
 *
 * @param {object} params
 * @param {URLSearchParams} params.searchParams
 * @param {(termId: string) => boolean} params.paneExists   ペイン（pty）が存在するか
 * @param {(termId: string) => ({ cwd?: string, engine?: string } | undefined)} params.getPaneState
 *        renderer が報告した、そのペインの実際の作業ディレクトリ・エンジン
 * @param {object} [params.checkOptions]  checkTranscriptEvidence へ渡す差し替え（テスト用）
 * @param {() => number} [params.now]     現在時刻（テスト用）
 * @param {Set<string>} [params.inFlight] 照合中 termId の集合（テスト用に差し替え可能）
 * @returns {Promise<{ status: number, body: object }>}
 */
async function buildTranscriptEvidenceResponse({
  searchParams,
  paneExists,
  getPaneState,
  checkOptions = {},
  now = () => Date.now(),
  inFlight = defaultInFlight,
}) {
  const parsed = parseTranscriptEvidenceQuery(searchParams, now());
  if (!parsed.ok) {
    return { status: 400, body: { error: parsed.error } };
  }
  if (!paneExists(parsed.termId)) {
    return { status: 200, body: { result: RESULT.UNKNOWN, reason: REASON.PANE_NOT_FOUND } };
  }
  if (inFlight.has(parsed.termId)) {
    return { status: 200, body: { result: RESULT.UNKNOWN, reason: REASON.BUSY } };
  }
  inFlight.add(parsed.termId);
  try {
    const state = getPaneState(parsed.termId) || {};
    const outcome = await checkTranscriptEvidence({
      ...checkOptions,
      cwd: state.cwd,
      engine: state.engine,
      token: parsed.token,
      sinceTimeMs: parsed.sinceTimeMs,
    });
    return { status: 200, body: outcome };
  } finally {
    inFlight.delete(parsed.termId);
  }
}

module.exports = {
  buildTranscriptEvidenceResponse,
  RESULT,
  REASON,
  DEFAULT_SINCE_GRACE_MS,
  isValidTranscriptToken,
  parseTranscriptEvidenceQuery,
  resolveClaudeProjectsRoot,
  encodeClaudeProjectDirName,
  resolveClaudeProjectTranscriptDir,
  transcriptLineMatchesUserToken,
  checkTranscriptEvidence,
};
