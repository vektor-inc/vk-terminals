'use strict';
// Claude の公式 usage API（GET https://api.anthropic.com/api/oauth/usage）から
// 使用状況（現在のセッション% / 週間制限% / 各リセット時刻）を取得する（issue #73）。
//
// 設計方針:
//   - usageTracker.js と同じく、純粋関数コア（レスポンスの正規化・認証情報のパース）と
//     IO 層（Keychain / 認証ファイル読み取り・fetch）を分離する。純粋関数は now を
//     引数で受け取り、node --test で時刻固定のテストができる。
//   - このモジュールは **main プロセス専用**。OAuth トークン（accessToken）はこの
//     モジュールの外に出さない。renderer・モバイル HTTP API・IPC・ログ・設定ファイル・
//     エラーメッセージへ渡してよいのは正規化済みの数値（% とリセット時刻 ms、source
//     種別）のみ。
//   - 認証情報は読み取り専用で参照する。refreshToken は使わない・触らない。
//     accessToken の期限切れ（expiresAt <= now）なら API を叩かず null を返す。
//   - 失敗（未ログイン・オフライン・Keychain 拒否・API 仕様変更等）はすべて静かに
//     null を返し、呼び出し側（main.js）がトランスクリプト集計へフォールバックする。
//   - API は非公開仕様のため将来予告なく変わりうる。構造が想定と違う場合も null。
//
// レスポンス構造（実測確認済み・2026-07 時点）:
//   five_hour: { utilization, resets_at }   … 現在のセッション（5時間ブロック）
//   seven_day: { utilization, resets_at }   … 週間制限（すべてのモデル）
//   limits[]:  { kind: 'session'|'weekly_all'|'weekly_scoped', percent, severity,
//                resets_at, is_active, ... }
//   主データは limits[] を使い、無ければ five_hour / seven_day で代替する。
//   ※ utilization / percent は 0..1 ではなく **百分率の浮動小数**（17.0 = 17%）。
//   ※ resets_at は TZ 付き ISO8601 文字列。

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createTtlMemo } = require('./usageTracker');

// macOS Keychain 上のサービス名（Claude Code が保存する認証情報）。
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
// Keychain に無い場合のフォールバック（Linux 等）。
const CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const FETCH_TIMEOUT_MS = 8000;    // API 応答待ちの上限（仕様: 5〜10 秒）
const KEYCHAIN_TIMEOUT_MS = 5000; // security コマンドの応答待ち上限
const USAGE_TTL_MS = 60 * 1000;   // main 側キャッシュ TTL（API 問い合わせの抑制）
// 公式取得が一時失敗しても、直近成功値をこの時間だけ出し続けて
// トランスクリプト集計への切替（パタパタ）を防ぐ。
const STICKY_MAX_MS = 15 * 60 * 1000;

// ─── 純粋関数コア（node --test 対象）────────────────────────────────────────────

/**
 * 認証情報（Keychain / ~/.claude/.credentials.json の中身）をパースする。
 * JSON 構造は { claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes, ... } }。
 * expiresAt は epoch ミリ秒。refreshToken には触れない（返り値にも含めない）。
 * @param {string|object|null} raw JSON 文字列またはパース済みオブジェクト
 * @returns {null | { accessToken: string, expiresAtMs: number|null }}
 */
function parseCredentials(raw) {
  if (raw == null) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch (_e) {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const oauth = obj.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') return null;
  const accessToken = (typeof oauth.accessToken === 'string' && oauth.accessToken) ? oauth.accessToken : null;
  if (!accessToken) return null;
  const expiresAtMs = (typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt))
    ? oauth.expiresAt
    : null;
  return { accessToken, expiresAtMs };
}

/**
 * トークンが利用可能か（期限内か）を判定する（純粋）。
 * expiresAt が欠けている・期限切れ（expiresAt <= now）の場合は false
 * （API を叩かずフォールバックさせる。refresh は自前で行わない）。
 * @param {ReturnType<typeof parseCredentials>} cred
 * @param {number} nowMs
 * @returns {boolean}
 */
function isTokenUsable(cred, nowMs) {
  return !!(cred
    && cred.accessToken
    && Number.isFinite(cred.expiresAtMs)
    && cred.expiresAtMs > nowMs);
}

/**
 * percent / utilization を表示用に正規化する（純粋）。
 * API の値は百分率の浮動小数（17.0 = 17%）。0..100 にクランプし、数値でなければ null。
 * ※ 0..1 の比率と誤解して 100 倍したり 1/100 したりしないこと。
 * @param {*} v
 * @returns {number|null}
 */
function normalizePercent(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(100, Math.max(0, v));
}

/** TZ 付き ISO8601 文字列を epoch ミリ秒にする。不正なら null。 */
function parseResetAt(v) {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * usage API のレスポンス JSON を統一構造へ正規化する（純粋）。
 *   - 主データは limits[]（kind: 'session' → セッション / 'weekly_all' → 週間）。
 *     'weekly_scoped'（特定モデルの週間枠）は表示対象外なので無視する。
 *   - limits に無い項目は five_hour / seven_day で代替する。
 *   - percent が数値として取れない項目は採用しない（データが無いものを 0% で見せない）。
 *   - セッション・週間のどちらも取れなければ null（呼び出し側がフォールバック）。
 * @param {*} json API レスポンス（パース済み）
 * @param {number} nowMs
 * @returns {null | {
 *   source: 'oauth',
 *   session: null | { percent: number, resetAtMs: number|null },
 *   weekly:  null | { percent: number, resetAtMs: number|null },
 *   fetchedAtMs: number,
 * }}
 */
function parseUsageResponse(json, nowMs) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;

  let session = null;
  let weekly = null;

  if (Array.isArray(json.limits)) {
    for (const l of json.limits) {
      if (!l || typeof l !== 'object') continue;
      const percent = normalizePercent(l.percent);
      if (percent === null) continue;
      const entry = { percent, resetAtMs: parseResetAt(l.resets_at) };
      if (l.kind === 'session' && !session) session = entry;
      else if (l.kind === 'weekly_all' && !weekly) weekly = entry;
      // 'weekly_scoped' は無視（週間表示は「すべてのモデル」のみ）
    }
  }

  // limits[] に無い場合の代替（five_hour / seven_day）。
  if (!session && json.five_hour && typeof json.five_hour === 'object') {
    const percent = normalizePercent(json.five_hour.utilization);
    if (percent !== null) {
      session = { percent, resetAtMs: parseResetAt(json.five_hour.resets_at) };
    }
  }
  if (!weekly && json.seven_day && typeof json.seven_day === 'object') {
    const percent = normalizePercent(json.seven_day.utilization);
    if (percent !== null) {
      weekly = { percent, resetAtMs: parseResetAt(json.seven_day.resets_at) };
    }
  }

  if (!session && !weekly) return null;
  return { source: 'oauth', session, weekly, fetchedAtMs: nowMs };
}

/**
 * 直近成功した公式 usage スナップショットを表示継続してよいか判定する（純粋）。
 * source: 'oauth' かつ fetchedAtMs を持つ値だけを対象にし、未来時刻や期限超過は使わない。
 * @param {*} snapshot 直近成功した正規化済み usage スナップショット
 * @param {number} nowMs 現在時刻（epoch ms）
 * @param {number} maxMs スティッキー表示を許容する最大時間（ms）
 * @returns {boolean}
 */
function isStickyUsable(snapshot, nowMs, maxMs) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.source !== 'oauth') return false;
  if (!Number.isFinite(snapshot.fetchedAtMs)) return false;
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxMs)) return false;
  const elapsed = nowMs - snapshot.fetchedAtMs;
  return elapsed >= 0 && elapsed <= maxMs;
}

// ─── IO 層（main プロセス専用・トークンはこの層の外に出さない）──────────────────

/**
 * macOS Keychain から認証情報（JSON 文字列）を読む。失敗は null（ログにも出さない）。
 * 未署名 Electron アプリのため初回アクセス時に許可ダイアログが出る。拒否されたら
 * エラー終了コードになるので null → ファイル / フォールバックへ。
 * @returns {Promise<string|null>}
 */
function readKeychainCredentials() {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        // err の内容はログに出さない（環境情報の混入を避ける。トークン自体は含まれないが静粛化）。
        resolve(err ? null : String(stdout).trim());
      },
    );
  });
}

/** ~/.claude/.credentials.json を読む。無い・読めないときは null。 */
function readCredentialsFileRaw(filePath = CREDENTIALS_FILE) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    return null;
  }
}

/**
 * Keychain（macOS）→ 認証ファイルの順で認証情報を読み、パースして返す。
 * @returns {Promise<ReturnType<typeof parseCredentials>>}
 */
async function loadCredentials() {
  if (process.platform === 'darwin') {
    const cred = parseCredentials(await readKeychainCredentials());
    if (cred) return cred;
  }
  return parseCredentials(readCredentialsFileRaw());
}

/**
 * usage API を叩いて JSON を返す。失敗（HTTP エラー・タイムアウト・ネットワーク）は null。
 * accessToken は Authorization ヘッダにのみ使い、エラー経路にも一切出さない。
 * @param {string} accessToken
 * @returns {Promise<object|null>}
 */
async function fetchUsageJson(accessToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(USAGE_API_URL, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_e) {
    return null; // オフライン・タイムアウト等は静かにフォールバック
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 認証情報の取得 → 期限チェック → API 取得 → 正規化 を 1 回分行う。
 * どこかで失敗したら null（トランスクリプト集計へのフォールバックは呼び出し側）。
 * @returns {Promise<ReturnType<typeof parseUsageResponse>>}
 */
async function loadUsageSnapshot() {
  try {
    const cred = await loadCredentials();
    if (!isTokenUsable(cred, Date.now())) return null;
    const json = await fetchUsageJson(cred.accessToken);
    if (!json) return null;
    return parseUsageResponse(json, Date.now());
  } catch (_e) {
    return null; // 想定外の例外も静かに null（アプリ本体へ影響させない）
  }
}

/**
 * 公式 usage API のプロバイダ。60 秒 TTL キャッシュ（createTtlMemo 流用）で
 * Keychain / API への問い合わせを抑制する。取得失敗（null）も TTL の間はキャッシュし、
 * 失敗のたびに Keychain へアクセスして許可ダイアログを乱発しないようにする。
 * main プロセスから 1 個だけ生成して使う。
 * @param {{ ttlMs?: number, stickyMaxMs?: number, clock?: () => number, load?: () => Promise<any> }} [options]
 * @returns {{ get: () => Promise<ReturnType<typeof parseUsageResponse>> }}
 */
function createOauthUsageProvider(options = {}) {
  const ttlMs = options.ttlMs != null ? options.ttlMs : USAGE_TTL_MS;
  const stickyMaxMs = options.stickyMaxMs != null ? options.stickyMaxMs : STICKY_MAX_MS;
  const clock = options.clock || Date.now;
  const load = typeof options.load === 'function' ? options.load : loadUsageSnapshot;
  let lastGood = null;
  // memo は API / Keychain 問い合わせを 60s に抑えるスロットル。
  // createTtlMemo は Promise をそのままメモ化する。同時呼び出しは同じ Promise を共有し、
  // reject は load 側で握りつぶして null 解決にしているため rejection は漏れない。
  const memo = createTtlMemo(() => Promise.resolve(load()).catch(() => null), ttlMs, clock);
  return {
    get: async () => {
      const fresh = await memo();
      if (fresh) {
        lastGood = fresh;
        return fresh;
      }
      // lastGood は表示安定化用の直近成功スナップショット。
      if (isStickyUsable(lastGood, clock(), stickyMaxMs)) {
        return { ...lastGood, stale: true };
      }
      return null;
    },
  };
}

module.exports = {
  // 純粋関数コア（テスト対象）
  parseCredentials,
  isTokenUsable,
  normalizePercent,
  parseResetAt,
  parseUsageResponse,
  isStickyUsable,
  // IO 層
  // NOTE: readCredentialsFileRaw は refreshToken を含む生 JSON を返すため export しない
  //       （モジュール内部専用。トークンをこのモジュールの外に出さない設計の徹底）。
  loadUsageSnapshot,
  createOauthUsageProvider,
  // 定数
  USAGE_TTL_MS,
  STICKY_MAX_MS,
  FETCH_TIMEOUT_MS,
};
