'use strict';
// セットアップ状況の確認（issue #456）: 上限時間・同時 1 本・失敗時にセットアップ済みへ倒さないこと。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSetupStatusChecker, DEFAULT_TIMEOUT_MS } = require('../utils/setupStatusCheck');

const VALID = {
  requirements: [{ id: 'claude', label: 'Claude Code', required: true, ok: false, current: '', hint: '', target: 'external' }],
  summary: { allRequiredOk: false },
};

test('既定の待ち時間の上限は 20 秒', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 20000);
});

test('成功: 正規化済みの status と確認時刻を返す', async () => {
  const checker = createSetupStatusChecker({ getSetupStatus: async () => VALID, now: () => 1000 });
  const result = await checker.check();
  assert.equal(result.ok, true);
  assert.equal(result.checkedAt, 1000);
  assert.equal(result.status.summary.allRequiredOk, false);
});

test('形が不正な結果は invalid（セットアップ済みの扱いにしない）', async () => {
  const checker = createSetupStatusChecker({ getSetupStatus: async () => ({ requirements: 'nope', summary: { allRequiredOk: true } }) });
  const result = await checker.check();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid');
});

test('例外は error。詳細には理由と時刻だけが入り、長いメッセージは切り詰める', async () => {
  const checker = createSetupStatusChecker({
    getSetupStatus: async () => { throw new Error(`spawn failed\n${'x'.repeat(1000)}`); },
    now: () => 0,
  });
  const result = await checker.check();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'error');
  assert.match(result.detail, /^reason: error\nmessage: spawn failed x+…\nchecked at: 1970-01-01T00:00:00.000Z$/);
  assert.ok(result.detail.length < 500);
});

test('同期的に投げる関数も error として扱う', async () => {
  const checker = createSetupStatusChecker({ getSetupStatus: () => { throw new Error('boom'); } });
  const result = await checker.check();
  assert.equal(result.reason, 'error');
});

test('時間切れ: 上限で待つのをやめ、中断を知らせる（signal が abort される）', async () => {
  let receivedSignal = null;
  const checker = createSetupStatusChecker({
    getSetupStatus: ({ signal }) => { receivedSignal = signal; return new Promise(() => {}); },
    timeoutMs: 30,
  });
  const result = await checker.check();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(receivedSignal.aborted, true);
});

test('時間切れのあと、元の処理が終わるまでは新しい確認を始めず、時間切れとして返す', async () => {
  let calls = 0;
  let settleFirst;
  const checker = createSetupStatusChecker({
    getSetupStatus: () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { settleFirst = () => resolve(VALID); });
      return Promise.resolve(VALID);
    },
    timeoutMs: 20,
  });
  assert.equal((await checker.check()).reason, 'timeout');
  // 元の処理がまだ動いているので「実行中」のまま。新しい確認は始めない。
  assert.equal(checker.isRunning(), true);
  const blocked = await checker.check();
  assert.equal(blocked.reason, 'timeout');
  assert.equal(calls, 1);
  // 元の処理が終わったら、次の確認を新しく始められる。
  settleFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checker.isRunning(), false);
  assert.equal((await checker.check()).ok, true);
  assert.equal(calls, 2);
});

test('時間切れで abort された処理が止まれば（reject すれば）、次の確認を始められる', async () => {
  let calls = 0;
  const checker = createSetupStatusChecker({
    getSetupStatus: ({ signal }) => {
      calls += 1;
      if (calls > 1) return Promise.resolve(VALID);
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    },
    timeoutMs: 20,
  });
  assert.equal((await checker.check()).reason, 'timeout');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await checker.check()).ok, true);
});

test('同時 1 本: 実行中に呼ばれたら新しく始めず、同じ結果を共有する', async () => {
  let calls = 0;
  let release;
  const checker = createSetupStatusChecker({
    getSetupStatus: () => { calls += 1; return new Promise((resolve) => { release = () => resolve(VALID); }); },
  });
  const first = checker.check();
  const second = checker.check();
  assert.equal(checker.isRunning(), true);
  // getSetupStatus は次のマイクロタスクで呼ばれるため、呼ばれたあとに解放する。
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(checker.isRunning(), false);
});
