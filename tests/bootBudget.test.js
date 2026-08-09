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
//
// tests/e2e/helpers/electron-app.js は @playwright/test に依存する。ここでは
// モジュール先頭で require せず、実際に使うテストの中で遅延 require する
// （npm ci --omit=dev のような devDependencies 抜きの環境で、このファイル全体が
// 落ちるのを防ぐ。レビュー指摘）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { BootStageError, createBootBudget, runStage } = require('./e2e/helpers/boot-budget');

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

// ── MEDIUM-A の回帰テスト ──
//
// 残りが安全網の余白（guardSlackMs）以下しか無い場合、fn を一切呼ばずにその場で
// 予算切れとして打ち切る。以前は Math.max(1, ...) で 1ms に丸めて fn を呼んでいた
// ため、最も確実に「予算切れ」と言える境界でだけ fn 側の失敗として処理され、
// timedOut が false になっていた（安藤の実測）。
test('runStage: 残りが安全網の余白以下しかない場合、fn を呼ばずに timedOut 付きで即座に打ち切る', async () => {
  const budget = createBootBudget(1_500); // guardSlackMs 既定 2_000ms より小さい総予算。
  let fnCalled = false;
  await assert.rejects(
    runStage(budget, 'first-window', () => {
      fnCalled = true;
      return Promise.resolve();
    }),
    (error) => {
      assert.ok(error instanceof BootStageError);
      assert.equal(error.stage, 'first-window');
      // 予算切れによる失敗だと確実に分かる。
      assert.equal(error.timedOut, true);
      return true;
    },
  );
  // fn（Electron 起動 API 等）を一切呼んでいない。
  assert.equal(fnCalled, false);
});

// ── HIGH-1 の回帰テスト ──
//
// 以前は runStage のガードタイマーが fn へ渡す timeout と同値で登録されていた。
// Node のタイマーは同一期限なら登録順に発火するため、先に登録されるガードが
// 必ず fn 側より先に勝ち、fn 自身の詳しい失敗（Playwright の Call log 等）が
// 丸ごと捨てられていた。
//
// レビュー指摘（MEDIUM-B）: 以前のこのテストは fn が渡された fnTimeoutMs と
// 無関係に固定 10ms で reject していたため、元のバグ条件（ガードと fn の timeout が
// 同値）から最も遠い配置になっており、GUARD_SLACK_MS を 0 に戻しても
// Call log / timedOut の assertion は落ちなかった（数値の assertion だけが落ちる）。
// fn 自身に fnTimeoutMs ちょうどで失敗させることで、GUARD_SLACK_MS を 0 に戻すと
// 狙った理由（ガードに横取りされる）で確実に落ちるテストにする。
test('runStage: fn が fnTimeoutMs ちょうどで失敗しても、ガードに横取りされず fn 側の失敗が伝わる', async () => {
  const budget = createBootBudget(2_100); // guardSlackMs 既定 2_000ms より 100ms だけ大きい。
  await assert.rejects(
    runStage(budget, 'sidebar-ready', (fnTimeoutMs) => new Promise((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`Timeout ${fnTimeoutMs}ms exceeded.\nCall log:\n  - waiting for locator('#sidebar')`)),
        fnTimeoutMs,
      );
    })),
    (error) => {
      assert.equal(error.timedOut, false, 'ガードが横取りしている');
      assert.match(error.message, /Call log/);
      return true;
    },
  );
});

test('runStage: fn が remainingMs 以内に終わらない場合（fn 自身の timeout が機能していない）、ガードが timedOut 付きで安全に止める', async () => {
  // guardSlackMs を小さくして、総予算が小さいままガードの性質（早期打ち切りではなく
  // 実際にガードのタイマーが発火する経路）を踏む。
  const budget = createBootBudget(30, { now: Date.now }); // 実時間 30ms
  await assert.rejects(
    runStage(budget, 'first-window', () => new Promise(() => {
      // 何も resolve/reject しない。fn 自身に timeout 実装が無い（あるいは
      // 壊れている）ケースの安全網（ガード）を確かめる。
    }), { guardSlackMs: 10 }),
    (error) => {
      assert.ok(error instanceof BootStageError);
      assert.equal(error.stage, 'first-window');
      // ガードが発火したことによる失敗だと確実に分かる。
      assert.equal(error.timedOut, true);
      return true;
    },
  );
});

test('runStage: 段の所要時間が閾値を超えたら、完了を待たずに標準エラー出力へ 1 行書く', async () => {
  // 外側（beforeAll/テストの 120 秒）に打ち切られた場合、この段の Promise チェーンは
  // 結果を返す前に放棄され、通常のエラー経路（wrapStageError）は一度も走らない。
  // stageLogThresholdMs を小さくして、この「完了前に書く」ログが実際に機能することを
  // 決定的に（実時間を長く待たずに）確かめる。
  const budget = createBootBudget(1_000);
  const originalWrite = process.stderr.write;
  const written = [];
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    await runStage(budget, 'first-window', () => new Promise((resolve) => {
      setTimeout(resolve, 40); // ログ閾値（20ms）より後、fn 自体は最終的に成功する。
    }), { guardSlackMs: 100, stageLogThresholdMs: 20 });
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.ok(
    written.some((line) => line.includes('first-window') && line.includes('20ms')),
    `段の進行ログが出力されていない: ${JSON.stringify(written)}`,
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
//
// レビュー指摘: 以前は `budget.elapsedMs() < 10` しか見ておらず、作りたての
// budget は常にそうなるため落ちようがなかった（将来 budget 作成のタイミングを
// getFreePort より前へ動かす改善が入ってもパスしてしまう、意味の無い assertion）。
// 注入した「世界時計」を作成前に大きく進めておき、budget の内部時計が
// 作成時点を基準にしていることを、作成タイミングに依存せず決定的に確かめる。
test('createBootBudget: 作成より前に経過した時間（getFreePort 相当）は budget の管理外のまま残る', () => {
  let worldClock = 50_000; // getFreePort 相当の待ちで、既に 50 秒経過した想定。
  const budget = createBootBudget(10_000, { now: () => worldClock });
  // budget の内部時計は作成時点（= startedAt）を基準にするため、作成前に世界時計が
  // どれだけ進んでいても、作成直後の elapsedMs は 0 のまま
  // （＝「段の外側でどれだけ時間を食っても構造的に外側より先に発火する」という
  // 言い切りは成立せず、実際の不変条件は「createBootBudget() 呼び出し以降、
  // 3 段の合計は必ず totalMs 以下に収まる」に留まる）。
  assert.equal(budget.elapsedMs(), 0);
  worldClock += 5_000;
  assert.equal(budget.elapsedMs(), 5_000);
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

// ── MEDIUM-6 / MEDIUM-B: launchApp / launchAppAndWait / waitForAppReady への
//    budget の受け渡しそのものの検証 ──
//
// Electron を実際に起動する統合確認は tests/e2e/*.smoke.spec.js 側で行っている。
// ここでは「渡された budget が既に尽きていれば、Electron を起動する API を
// 一切呼ばず、一時ディレクトリも残さない」「3 段が 1 つの budget を共有し、
// 経路も引き継ぐ」という本番コードパス上の不変条件を、安く・決定的に確認する。
test('launchApp: 渡された budget が尽きていれば Electron を起動せず、一時ディレクトリも残さない', async () => {
  const { launchApp } = require('./e2e/helpers/electron-app');
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
  const { launchAppAndWait } = require('./e2e/helpers/electron-app');
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

test('waitForAppReady: 渡された budget をそのまま使い、経路も引き継ぐ', async () => {
  const { waitForAppReady } = require('./e2e/helpers/electron-app');
  let clock = 0;
  const budget = createBootBudget(1_000, { now: () => clock });
  budget.enter('electron-launch');
  clock = 2_000; // sidebar-ready に入る前に予算切れ
  const win = { waitForSelector: () => assert.fail('予算切れなのに waitForSelector が呼ばれた') };
  await assert.rejects(
    waitForAppReady({ win, budget }),
    (error) => {
      assert.equal(error.stage, 'sidebar-ready');
      assert.equal(error.timedOut, true);
      // launchApp 側で通った electron-launch の経路を引き継いでいる。
      assert.match(error.message, /electron-launch@0ms/);
      return true;
    },
  );
});

test('waitForAppReady: win を渡さずに呼ぶと分かりやすいメッセージで落ちる（旧形式の呼び方の取り違え対策）', async () => {
  const { waitForAppReady } = require('./e2e/helpers/electron-app');
  await assert.rejects(
    waitForAppReady(),
    /waitForAppReady: \{ win \} が必要です/,
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
