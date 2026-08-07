// boot-budget.js の単体テスト（issue #347）。
//
// e2e を全件実行しないと踏めない負荷依存の不具合だったため、ここでは実際の負荷を
// 再現するのではなく、「起動シーケンス全体の絶対予算」という仕組み自体が
// 持つべき性質を、擬似クロック（now を注入）で決定的に確認する。
// Electron を一切起動しないため実行は瞬時で、全件実行の時間を増やさない
// （npm test 側。npm run test:e2e 側の待ち時間は増えない）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { BootTimeoutError, createBootBudget, runStage } = require('./boot-budget');

test('createBootBudget: 予算内では enter() が残り時間を正しく返す', () => {
  let clock = 0;
  const budget = createBootBudget(10_000, { now: () => clock });

  const remaining1 = budget.enter('stage-a');
  assert.equal(remaining1, 10_000);

  clock += 3_000;
  const remaining2 = budget.enter('stage-b');
  assert.equal(remaining2, 7_000);
});

test('createBootBudget: 段に入る前に予算を使い切っていると、その段の処理を試みずに即座に BootTimeoutError を投げる', () => {
  let clock = 0;
  const budget = createBootBudget(10_000, { now: () => clock });

  budget.enter('stage-a');
  // stage-a と stage-b の「間」（=このヘルパーの管理外）で想定より時間を使った状況を
  // 再現する。実際の electron-app.js では getFreePort() / mkdtempSync() 等がここに当たる。
  clock = 11_000;

  assert.throws(
    () => budget.enter('stage-b'),
    (error) => {
      assert.ok(error instanceof BootTimeoutError);
      // どの段に入ろうとして尽きたのかが分かる。
      assert.equal(error.stage, 'stage-b');
      assert.equal(error.elapsedMs, 11_000);
      assert.equal(error.budgetMs, 10_000);
      // それまでの経路（stage-a を通ったこと）もメッセージに残る。
      assert.match(error.message, /stage-b/);
      assert.match(error.message, /stage-a@0ms/);
      return true;
    },
  );
});

test('createBootBudget.wrapStageError: 元のエラーを cause に保持しつつ、段名と経過時間をメッセージに載せる', () => {
  let clock = 0;
  const budget = createBootBudget(10_000, { now: () => clock });
  budget.enter('stage-a');
  clock = 4_000;

  const original = new Error('Timeout 5000ms exceeded.');
  const wrapped = budget.wrapStageError('stage-a', original);

  assert.ok(wrapped instanceof BootTimeoutError);
  assert.equal(wrapped.stage, 'stage-a');
  assert.equal(wrapped.elapsedMs, 4_000);
  assert.equal(wrapped.cause, original);
  assert.match(wrapped.message, /stage-a/);
  assert.match(wrapped.message, /4000ms/);
  assert.match(wrapped.message, /Timeout 5000ms exceeded\./);
});

test('runStage: fn が成功すれば、その段の残り時間を渡した上で結果をそのまま返す', async () => {
  const budget = createBootBudget(10_000);
  const result = await runStage(budget, 'stage-a', async (remainingMs) => {
    assert.ok(remainingMs > 0 && remainingMs <= 10_000);
    return 'ok';
  });
  assert.equal(result, 'ok');
});

test('runStage: fn が失敗した場合、段名と経過時間を乗せたエラーへラップして再送する', async () => {
  const budget = createBootBudget(10_000);
  await assert.rejects(
    runStage(budget, 'electron-launch', async () => {
      throw new Error('boom');
    }),
    (error) => {
      assert.ok(error instanceof BootTimeoutError);
      assert.equal(error.stage, 'electron-launch');
      assert.match(error.message, /electron-launch/);
      assert.match(error.message, /boom/);
      assert.equal(error.cause.message, 'boom');
      return true;
    },
  );
});

test('runStage: fn が remainingMs 以内に終わらない場合、fn 自身のタイムアウト有無に関わらず段名付きで失敗する', async () => {
  const budget = createBootBudget(30, { now: Date.now }); // 実時間 30ms
  await assert.rejects(
    runStage(budget, 'first-window', () => new Promise(() => {
      // 何も resolve/reject しない。fn 自身に timeout 実装が無い（あるいは
      // 壊れている）ケースの安全網（Promise.race のガード）を確かめる。
    })),
    (error) => {
      assert.ok(error instanceof BootTimeoutError);
      assert.equal(error.stage, 'first-window');
      return true;
    },
  );
});

// ── issue #347 の核心: 相対時間 vs 絶対時間の非対称性の縮小再現 ──
//
// 「各段は自分の持ち時間には収まっているのに、段の外側（getFreePort 等）で
// 想定外に時間を使うと、外側のフック/テストタイムアウトが内側より先に発火して
// 診断情報が失われる」という現象を、擬似クロックで決定的に再現する。
// この予算方式で直った、と主張したい 2 つの性質:
//   1. 内側の検知が構造的に必ず外側より先に発火する
//      （＝総予算の残りが尽きた時点で、この場で即座に失敗する。外側の
//        タイムアウトの発火を待つ必要が無い）
//   2. その失敗が「どの段で・それまでに何 ms 使ったか」を含む
test('縮小再現: 段の外側で想定外に時間を使っても、次の段へ入る前に即座に検知し、段と経過時間を報告する', () => {
  let clock = 0;
  // electron-app.js の実運用値ではなく、性質そのものを確かめるための値。
  const TOTAL_BUDGET_MS = 60_000;
  const budget = createBootBudget(TOTAL_BUDGET_MS, { now: () => clock });

  // 1 段目（例: electron-launch）は budget 内で正常に完了。
  // enter() はその段に入った時点（ここでは clock=0）の経過時間を経路に記録する。
  budget.enter('electron-launch');
  clock += 5_000;

  // 段の外側の想定外の待ち（例: 高負荷下の getFreePort / mkdtempSync）が
  // 総予算をほぼ食い尽くす。旧設計（各段が独立した固定 35 秒の相対タイマー）
  // では、次の段は「自分の 35 秒」をまるごと新たに得てしまい、この時点では
  // 何も検知できなかった。
  clock += 56_000; // 合計 61,000ms > 60,000ms（総予算超過）

  let caught;
  try {
    budget.enter('first-window');
    assert.fail('総予算を超えているのに enter() が例外を投げなかった');
  } catch (error) {
    caught = error;
  }

  // 性質 1: 外側（beforeAll/テストの 120 秒）の発火を待たず、この場で即座に検知する。
  assert.ok(caught instanceof BootTimeoutError);
  // 性質 2: どの段で・それまでに何 ms 使ったかがエラーから読み取れる。
  assert.equal(caught.stage, 'first-window');
  assert.equal(caught.elapsedMs, 61_000);
  assert.match(caught.message, /first-window/);
  assert.match(caught.message, /61000ms/);
  assert.match(caught.message, /electron-launch@0ms/);
});

// ── 実際の設定値との整合性チェック ──
//
// electron-app.js が使う総予算が、playwright.config.js の外側タイムアウト
// （beforeAll/テストの持ち時間）に対して十分な余裕を残していることを固定する。
// ここが崩れると、上の「内側が構造的に必ず外側より先に発火する」という
// 保証そのものが成り立たなくなる。
test('electron-app.js の起動シーケンス総予算は、playwright.config.js のテストタイムアウトに対して十分な余裕を残す', () => {
  const { BOOT_TOTAL_BUDGET_MS } = require('./electron-app');
  const playwrightConfig = require(path.join('..', '..', '..', 'playwright.config.js'));
  const projectTimeoutMs = playwrightConfig.timeout ?? playwrightConfig.projects?.[0]?.timeout;

  assert.ok(Number.isFinite(projectTimeoutMs), 'playwright.config.js から timeout を読み取れない');
  assert.ok(Number.isFinite(BOOT_TOTAL_BUDGET_MS));

  // 起動シーケンス自体の予算は、外側のテストタイムアウトの半分以下に収め、
  // 「起動以外に使う待ち（/api/states 応答待ち・表示確認等）」の分もこの外側の
  // 枠に確実に残るようにする。
  assert.ok(
    BOOT_TOTAL_BUDGET_MS <= projectTimeoutMs / 2,
    `BOOT_TOTAL_BUDGET_MS(${BOOT_TOTAL_BUDGET_MS}) が外側のテストタイムアウト`
      + `(${projectTimeoutMs}) の半分を超えている`,
  );
});
