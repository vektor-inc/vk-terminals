// tests/e2e/helpers/boot-budget.js の単体テスト（issue #347）。
//
// e2e を全件実行しないと踏めない負荷依存の不具合だったため、ここでは実際の負荷を
// 再現するのではなく、「起動シーケンス全体の絶対予算」という仕組み自体が
// 持つべき性質を、擬似クロック（now を注入）で決定的に確認する。
// Electron を一切起動しないため実行は瞬時で、全件実行の時間を増やさない
// （npm test 側。npm run test:e2e 側の待ち時間は増えない）。
//
// このファイルは tests/*.test.js（他 39 本と同じ camelCase 命名）に置く。
// tests/e2e/ 配下には置かない — playwright.config.js の testDir と既定の
// testMatch に一致してしまい、node:test の TAP 出力が e2e のログに混入し、
// unit テストが落ちても Playwright の終了コードには影響しないため気付けない
// （レビュー指摘。実際にログで確認済み）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { BootStageError, createBootBudget, runStage } = require('./e2e/helpers/boot-budget');
const { launchApp, launchAppAndWait } = require('./e2e/helpers/electron-app');

test('createBootBudget: 予算内では enter() が残り時間を正しく返す', () => {
  let clock = 0;
  const budget = createBootBudget(10_000, { now: () => clock });

  const remaining1 = budget.enter('stage-a');
  assert.equal(remaining1, 10_000);

  clock += 3_000;
  const remaining2 = budget.enter('stage-b');
  assert.equal(remaining2, 7_000);
});

test('createBootBudget: 段に入る前に予算を使い切っていると、その段の処理を試みずに即座に BootStageError を投げる', () => {
  let clock = 0;
  const budget = createBootBudget(10_000, { now: () => clock });

  budget.enter('stage-a');
  // stage-a と stage-b の「間」（=このヘルパーの管理外）で想定より時間を使った状況を
  // 再現する。実際の electron-app.js では mkdtempSync() 等がここに当たる。
  clock = 11_000;

  assert.throws(
    () => budget.enter('stage-b'),
    (error) => {
      assert.ok(error instanceof BootStageError);
      // どの段に入ろうとして尽きたのかが分かる。
      assert.equal(error.stage, 'stage-b');
      assert.equal(error.elapsedMs, 11_000);
      assert.equal(error.budgetMs, 10_000);
      // 予算切れによる失敗だと確実に分かる（MEDIUM-5）。
      assert.equal(error.timedOut, true);
      // それまでの経路（stage-a を通ったこと。enter() 時点の経過時間で記録される）も
      // メッセージに残る。
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

  assert.ok(wrapped instanceof BootStageError);
  assert.equal(wrapped.stage, 'stage-a');
  assert.equal(wrapped.elapsedMs, 4_000);
  assert.equal(wrapped.cause, original);
  // 原因が判別できない失敗は timedOut を立てない（既定 false）。
  assert.equal(wrapped.timedOut, false);
  assert.match(wrapped.message, /stage-a/);
  assert.match(wrapped.message, /4000ms/);
  assert.match(wrapped.message, /Timeout 5000ms exceeded\./);
});

test('runStage: fn が成功すれば、その段の残り時間から安全網の分を引いた timeout を渡した上で結果をそのまま返す', async () => {
  const budget = createBootBudget(10_000);
  const result = await runStage(budget, 'stage-a', async (fnTimeoutMs) => {
    assert.ok(fnTimeoutMs > 0 && fnTimeoutMs <= 10_000);
    return 'ok';
  });
  assert.equal(result, 'ok');
});

test('runStage: fn が失敗した場合、段名と経過時間を乗せたエラーへラップして再送する（timedOut は立たない）', async () => {
  const budget = createBootBudget(10_000);
  await assert.rejects(
    runStage(budget, 'electron-launch', async () => {
      throw new Error('boom');
    }),
    (error) => {
      assert.ok(error instanceof BootStageError);
      assert.equal(error.stage, 'electron-launch');
      assert.equal(error.timedOut, false);
      assert.match(error.message, /electron-launch/);
      assert.match(error.message, /boom/);
      assert.equal(error.cause.message, 'boom');
      return true;
    },
  );
});

// ── HIGH-1 の回帰テスト ──
//
// 以前は runStage のガードタイマーが fn へ渡す timeout と同値で登録されていた。
// Node のタイマーは同一期限なら登録順に発火するため、先に登録されるガードが
// 必ず fn 側より先に勝ち、fn 自身の詳しい失敗（Playwright の Call log 等）が
// 丸ごと捨てられていた。ガードには GUARD_SLACK_MS 分長い期限を与えることで、
// fn が自分の timeout（fnTimeoutMs）を守っている限り、常に fn 側の失敗が
// 先に伝わることを確かめる。
test('runStage: fn が自分の timeout（fnTimeoutMs）を守って先に失敗すれば、ガードに横取りされず fn 側の失敗がそのまま伝わる', async () => {
  const budget = createBootBudget(1_000); // 実時間 1000ms
  const seenFnTimeoutMs = [];
  await assert.rejects(
    runStage(budget, 'electron-launch', (fnTimeoutMs) => {
      seenFnTimeoutMs.push(fnTimeoutMs);
      // fn 自身が、渡された fnTimeoutMs 以内に詳しい情報（Call log 相当）を持つ
      // 失敗を返す状況を模す（Playwright の _electron.launch 等の実際の挙動）。
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error(`Timeout ${fnTimeoutMs}ms exceeded. Call log: ...`)), 10);
      });
    }),
    (error) => {
      assert.ok(error instanceof BootStageError);
      // ガードは発火していない（fn 側の失敗だと確実には言えないため false のまま）。
      assert.equal(error.timedOut, false);
      // fn 側の詳しい情報（Call log 相当）が消えずに残っている。
      assert.match(error.message, /Call log: \.\.\./);
      return true;
    },
  );
  assert.equal(seenFnTimeoutMs.length, 1);
  // fn には budget の残り時間そのもの（≒1000ms）ではなく、安全網の分（2000ms）を
  // 引いた値が渡っている。
  assert.ok(seenFnTimeoutMs[0] < 1_000);
});

test('runStage: fn が remainingMs 以内に終わらない場合（fn 自身の timeout が機能していない）、ガードが timedOut 付きで安全に止める', async () => {
  const budget = createBootBudget(30, { now: Date.now }); // 実時間 30ms
  await assert.rejects(
    runStage(budget, 'first-window', () => new Promise(() => {
      // 何も resolve/reject しない。fn 自身に timeout 実装が無い（あるいは
      // 壊れている）ケースの安全網（ガード）を確かめる。
    })),
    (error) => {
      assert.ok(error instanceof BootStageError);
      assert.equal(error.stage, 'first-window');
      // ガードが発火したことによる失敗だと確実に分かる。
      assert.equal(error.timedOut, true);
      return true;
    },
  );
});

// ── issue #347 の核心: 相対時間 vs 絶対時間の非対称性の縮小再現 ──
//
// 「各段は自分の持ち時間には収まっているのに、段の外側で想定外に時間を使うと、
// 外側のフック/テストタイムアウトが内側より先に発火して診断情報が失われる」
// という現象を、擬似クロックで決定的に再現する。この予算方式で直った、と
// 主張したい 2 つの性質:
//   1. 内側の検知が構造的に必ず外側より先に発火する
//      （＝総予算の残りが尽きた時点で、この場で即座に失敗する。外側の
//        タイムアウトの発火を待つ必要が無い）
//   2. その失敗が「どの段で・それまでに何 ms 使ったか」を含む
//
// 前提: この性質が成り立つのは createBootBudget() が呼ばれた「以降」の話であり、
// それより前に使った時間（getFreePort 等）は対象外（下の「境界」テスト参照）。
test('縮小再現: budget 作成後、段の外側で想定外に時間を使っても、次の段へ入る前に即座に検知し、段と経過時間を報告する', () => {
  let clock = 0;
  // electron-app.js の実運用値ではなく、性質そのものを確かめるための値。
  const TOTAL_BUDGET_MS = 60_000;
  const budget = createBootBudget(TOTAL_BUDGET_MS, { now: () => clock });

  // 1 段目（例: electron-launch）は budget 内で正常に完了。
  // enter() はその段に入った時点（ここでは clock=0）の経過時間を経路に記録する。
  budget.enter('electron-launch');
  clock += 5_000;

  // 段の外側の想定外の待ちが総予算をほぼ食い尽くす。旧設計（各段が独立した
  // 固定 35 秒の相対タイマー）では、次の段は「自分の 35 秒」をまるごと新たに
  // 得てしまい、この時点では何も検知できなかった。
  clock += 56_000; // 合計 61,000ms > 60,000ms（総予算超過）

  let caught;
  try {
    budget.enter('first-window');
    assert.fail('総予算を超えているのに enter() が例外を投げなかった');
  } catch (error) {
    caught = error;
  }

  // 性質 1: 外側（beforeAll/テストの 120 秒）の発火を待たず、この場で即座に検知する。
  assert.ok(caught instanceof BootStageError);
  assert.equal(caught.timedOut, true);
  // 性質 2: どの段で・それまでに何 ms 使ったかがエラーから読み取れる。
  assert.equal(caught.stage, 'first-window');
  assert.equal(caught.elapsedMs, 61_000);
  assert.match(caught.message, /first-window/);
  assert.match(caught.message, /61000ms/);
  assert.match(caught.message, /electron-launch@0ms/);
});

// ── 境界: budget の時計が「いつから」動くか（MEDIUM-3） ──
test('createBootBudget: 作成より前に経過した時間（getFreePort 相当）は budget の管理外のまま残る', () => {
  // getFreePort() は launchApp / launchAppAndWait を呼ぶ前に spec 側が呼ぶため、
  // createBootBudget() が作られる前に起きる。budget の時計は作成時点から
  // 動き出すため、作成前にどれだけ時間を使っていても elapsedMs には反映されない。
  // つまり「段の外側でどれだけ時間を食っても構造的に外側より先に発火する」という
  // 言い切りは成立せず、実際の不変条件は「createBootBudget() 呼び出し以降、
  // 3 段の合計は必ず totalMs 以下に収まる」に留まる。
  const budget = createBootBudget(10_000); // ここが「作成」の瞬間
  assert.ok(budget.elapsedMs() < 10); // 作成直前の待ちは一切反映されない
});

test('createBootBudget: budget 作成後・段に入る前の実処理時間（mkdtempSync 等に相当）は elapsedMs へ正しく反映される', async () => {
  // (a) launchApp 冒頭の mkdtempSync + 設定ファイル書き込みのように、budget
  // 作成後・最初の enter() より前に起きる実処理は budget の管理「内」にある
  // （(b) の getFreePort とは境界が異なる）。
  const budget = createBootBudget(10_000);
  await new Promise((r) => setTimeout(r, 50)); // mkdtempSync 等に相当する実処理時間の代わり
  const remaining = budget.enter('electron-launch');
  assert.ok(budget.elapsedMs() >= 50);
  assert.ok(remaining <= 10_000 - 50);
});

// ── MEDIUM-6: launchApp / launchAppAndWait への budget の受け渡しそのものの検証 ──
//
// Electron を実際に起動する統合確認は tests/e2e/*.smoke.spec.js 側で行っている。
// ここでは「渡された budget が既に尽きていれば、Electron を起動する API を
// 一切呼ばず、一時ディレクトリも残さない」という本番コードパス上の不変条件を、
// 安く・決定的に確認する。
test('launchApp: 渡された budget が尽きていれば Electron を起動せず、一時ディレクトリも残さない', async () => {
  let clock = 0;
  const budget = createBootBudget(1_000, { now: () => clock });
  clock = 2_000; // 段に入る前に予算切れ
  const prefix = 'vk-terminals-unit-budget-';
  const countTmpDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(prefix)).length;
  const before = countTmpDirs();
  await assert.rejects(
    launchApp({ port: 0, prefix, budget }),
    (error) => {
      assert.ok(error instanceof BootStageError);
      assert.equal(error.stage, 'electron-launch');
      assert.equal(error.elapsedMs, 2_000);
      assert.equal(error.timedOut, true);
      return true;
    },
  );
  // launchApp が作った一時ディレクトリ（mkdtempSync）は catch 節で必ず削除される。
  assert.equal(countTmpDirs(), before);
});

test('launchAppAndWait: options.budget を渡すとその budget がそのまま使われる（黙って新しい budget へ差し替えられない）', async () => {
  let clock = 0;
  const budget = createBootBudget(1_000, { now: () => clock });
  clock = 2_000; // 段に入る前に予算切れ
  const prefix = 'vk-terminals-unit-budget-waitforall-';
  await assert.rejects(
    launchAppAndWait({ port: 0, prefix, budget }),
    (error) => {
      // options.budget が捨てられて新しい（尽きていない）budget に差し替えられて
      // いたら、この時点では即座に失敗せず実際に Electron の起動を試みてしまう。
      assert.equal(error.stage, 'electron-launch');
      assert.equal(error.elapsedMs, 2_000);
      return true;
    },
  );
});

// ── 実際の設定値との整合性チェック ──
//
// electron-app.js が使う総予算が、playwright.config.js の外側タイムアウト
// （beforeAll/テストの持ち時間）に対して十分な余裕を残していることを固定する。
// ここが崩れると、上の「内側が構造的に必ず外側より先に発火する」という
// 保証そのものが成り立たなくなる。
test('electron-app.js の起動シーケンス総予算は、playwright.config.js のテストタイムアウトに対して十分な余裕を残す', () => {
  const { BOOT_TOTAL_BUDGET_MS } = require('./e2e/helpers/electron-app');
  const playwrightConfig = require(path.resolve(__dirname, '..', 'playwright.config.js'));
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
