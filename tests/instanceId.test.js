'use strict';
// GET /api/health に含める起動インスタンス識別子の純粋関数テスト。
// main.js は Electron を require するため、env 解決とレスポンス生成だけを utils 側で検証する。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  INSTANCE_ID_ENV_KEY,
  MAX_INSTANCE_ID_LENGTH,
  resolveInstanceId,
  buildHealthResponse,
} = require('../utils/instanceId');

test('resolveInstanceId: env 未設定なら null', () => {
  assert.equal(resolveInstanceId({}), null);
});

test('resolveInstanceId: env 設定値を trim して返す', () => {
  assert.equal(resolveInstanceId({ [INSTANCE_ID_ENV_KEY]: '  instance-abc  ' }), 'instance-abc');
});

test('resolveInstanceId: 空文字・空白のみは null', () => {
  assert.equal(resolveInstanceId({ [INSTANCE_ID_ENV_KEY]: '' }), null);
  assert.equal(resolveInstanceId({ [INSTANCE_ID_ENV_KEY]: '   \t\n  ' }), null);
});

test('resolveInstanceId: 極端に長い値は最大長で切る', () => {
  const value = 'x'.repeat(MAX_INSTANCE_ID_LENGTH + 20);
  assert.equal(resolveInstanceId({ [INSTANCE_ID_ENV_KEY]: value }), 'x'.repeat(MAX_INSTANCE_ID_LENGTH));
});

test('buildHealthResponse: instanceId が null なら従来どおり { ok: true }', () => {
  assert.deepEqual(buildHealthResponse(null), { ok: true });
  assert.equal(Object.prototype.hasOwnProperty.call(buildHealthResponse(null), 'instanceId'), false);
});

test('buildHealthResponse: instanceId が空文字ならフィールドを含めない', () => {
  assert.deepEqual(buildHealthResponse(''), { ok: true });
});

test('buildHealthResponse: instanceId があれば additive に含める', () => {
  assert.deepEqual(buildHealthResponse('instance-abc'), { ok: true, instanceId: 'instance-abc' });
});

test('GET /api/health payload: env 未設定・空白・設定済みの期待形', () => {
  assert.deepEqual(buildHealthResponse(resolveInstanceId({})), { ok: true });
  assert.deepEqual(buildHealthResponse(resolveInstanceId({ [INSTANCE_ID_ENV_KEY]: '   ' })), { ok: true });
  assert.deepEqual(
    buildHealthResponse(resolveInstanceId({ [INSTANCE_ID_ENV_KEY]: '  vk-123  ' })),
    { ok: true, instanceId: 'vk-123' },
  );
});
