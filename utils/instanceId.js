'use strict';

const INSTANCE_ID_ENV_KEY = 'VK_TERMINALS_INSTANCE_ID';
const MAX_INSTANCE_ID_LENGTH = 512;

/**
 * 起動元から渡されたインスタンス識別子を解決する。
 * 未設定・空白のみは従来互換のため null として扱い、health レスポンスへ含めない。
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 * @returns {string|null}
 */
function resolveInstanceId(env = process.env) {
  const raw = env?.[INSTANCE_ID_ENV_KEY];
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  return trimmed.slice(0, MAX_INSTANCE_ID_LENGTH);
}

/**
 * GET /api/health のレスポンスペイロードを生成する。
 * @param {string|null} instanceId 起動時に解決済みのインスタンス識別子
 * @returns {{ ok: true, instanceId?: string }}
 */
function buildHealthResponse(instanceId) {
  const response = { ok: true };
  if (typeof instanceId === 'string' && instanceId) {
    response.instanceId = instanceId;
  }
  return response;
}

module.exports = {
  INSTANCE_ID_ENV_KEY,
  MAX_INSTANCE_ID_LENGTH,
  resolveInstanceId,
  buildHealthResponse,
};
