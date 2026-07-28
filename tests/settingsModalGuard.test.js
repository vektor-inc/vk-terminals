'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createSingleOpenGuard } = require('../renderer/settingsModalGuard');

// 設定パネルの生成開始から閉じるまで、同時に 1 つだけ開ける状態を管理する。
// DOM に依存しないロックの寿命だけを検証し、描画途中の例外でも次回の表示を妨げない
// ことを押さえる。

test('acquire: 1 回目は取得でき、解放前の 2 回目は取得できない', () => {
  const guard = createSingleOpenGuard();
  const release = guard.acquire();

  assert.equal(typeof release, 'function');
  assert.equal(guard.acquire(), null);
});

// 描画処理が途中で失敗しても例外を呼び出し側へ伝えたままロックだけは解放し、
// 設定パネルを開き直せる状態へ戻す。
test('protect: 処理が例外を投げても次回は取得できる', async () => {
  const guard = createSingleOpenGuard();
  const error = new Error('描画に失敗');
  let cleaned = false;

  await assert.rejects(
    guard.protect(async ({ setFailureCleanup }) => {
      setFailureCleanup(() => { cleaned = true; });
      throw error;
    }),
    error
  );

  assert.equal(cleaned, true);
  assert.equal(typeof guard.acquire(), 'function');
});

// 例外時の後片付け自体が失敗しても、設定パネルを開き直せる状態へ戻しつつ、
// 呼び出し側には後片付けではなく描画処理で発生した元の例外を伝える。
test('protect: 後片付けが例外を投げても元の例外を伝えて次回は取得できる', async () => {
  const guard = createSingleOpenGuard();
  const originalError = new Error('描画に失敗');
  const cleanupError = new Error('後片付けに失敗');
  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => { loggedErrors.push(args); };

  try {
    await assert.rejects(
      guard.protect(async ({ setFailureCleanup }) => {
        setFailureCleanup(() => {
          throw cleanupError;
        });
        throw originalError;
      }),
      (error) => error === originalError
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(loggedErrors, [
    ['設定パネルの例外時の後片付けに失敗しました', cleanupError],
  ]);
  assert.equal(typeof guard.acquire(), 'function');
});

// 設定項目が無い場合も、空のパネル自体は開いたままになる。正常な早期 return を
// 失敗扱いして解放すると二重オープンできてしまうため、明示的に閉じるまで維持する。
test('protect: 正常終了では明示的に解放するまでロックを維持する', async () => {
  const guard = createSingleOpenGuard();
  let release;

  assert.equal(await guard.protect(async (context) => {
    release = context.release;
  }), true);
  assert.equal(guard.acquire(), null);

  assert.equal(release(), true);
  assert.equal(typeof guard.acquire(), 'function');
});

test('release: 明示的に解放すると次回は取得できる', () => {
  const guard = createSingleOpenGuard();
  const release = guard.acquire();

  assert.equal(release(), true);
  assert.equal(typeof guard.acquire(), 'function');
});

// 閉じたパネルの遅延処理が古い release を再実行しても、後から開いたパネルのロックを
// 巻き戻さないこと。close() を複数回呼べる既存の冪等性をここでも維持する。
test('release: 複数回呼んでも後から取得したロックを解放しない', () => {
  const guard = createSingleOpenGuard();
  const firstRelease = guard.acquire();

  assert.equal(firstRelease(), true);
  const secondRelease = guard.acquire();
  assert.equal(typeof secondRelease, 'function');

  assert.equal(firstRelease(), false);
  assert.equal(guard.acquire(), null);
  assert.equal(secondRelease(), true);
});
