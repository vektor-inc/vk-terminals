// 起動シーケンス全体の「総予算」を単一の絶対時刻で管理する（issue #347）。
//
// 旧来の electron-app.js は起動の各段（プロセス起動 / firstWindow 取得 /
// #sidebar 描画待ち）に「その段が始まった時点からの」固定 35 秒を独立に与えていた。
// この設計は「3 段の合計（35s×3=105s）が beforeAll / テストの持ち時間（120s。
// playwright.config.js の timeout）を超えない」ことを根拠にしていたが、根拠が
// 崩れる抜け穴があった: getFreePort() や mkdtempSync() のような、どの段にも
// 属さない「未計測の待ち」がフック開始からの時間を先に食うと、各段は
// 「自分の 35 秒」には収まっているのに、フック開始からの累積は 120 秒を超えてしまう。
// このとき Playwright は beforeAll/テストの絶対デッドライン（120 秒）を先に発火させ、
// まだ「時間内」のまま実行中だった段の Promise チェーンは打ち切られる（内側の
// タイムアウトエラーは一度も生成されない）。結果として「どの段で詰まったか」という
// このヘルパーが残そうとしていた情報が失われ、外側の汎用的な
// `"beforeAll" hook timeout of 120000ms exceeded.` だけが残る。
//
// 実際にこの現象を縮小再現したものが tests/bootBudget.test.js にある（段の管理外の
// 待ちを先に挟み、擬似クロックで「累積が総予算を超えた」状態を作ると、次の段に
// 入ろうとした時点で即座に BootStageError が投げられ、どの段で・それまでに何 ms
// 使ったかがメッセージに残ることを確認している）。
//
// 対策: 各段に固定・相対的なタイマーを与えるのではなく、起動シーケンス全体で
// 単一の絶対デッドラインを 1 回だけ計算し、各段には「そこからの残り」を渡す。
// 残りが尽きている場合は Playwright の API を一切呼ばず、この場でエラーを投げる。
//
// この予算の時計は createBootBudget() が呼ばれた瞬間から動き出す。呼び出し元
// （spec の getFreePort() など）がそれより前に使った時間は一切見えない。
// 実際に保証できる不変条件は「createBootBudget() 呼び出し以降、この予算の
// 3 段合計は必ず totalMs 以下に収まる」であり、「段の外側でどれだけ時間を
// 食っても構造的に外側（120 秒）より先に発火する」という言い切りではない
// （createBootBudget() を呼ぶ前の待ちが長引けば、その分だけ外側の絶対デッドラインに
// 近づく）。electron-app.js の BOOT_TOTAL_BUDGET_MS を外側の持ち時間の半分以下に
// 抑えているのは、この呼び出し前の待ち（getFreePort 等）にも現実的な余裕を残すため。

'use strict';

class BootStageError extends Error {
  constructor(message, { stage, elapsedMs, budgetMs, stagePath, timedOut, cause }) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'BootStageError';
    this.stage = stage;
    this.elapsedMs = elapsedMs;
    this.budgetMs = budgetMs;
    this.stagePath = stagePath;
    // 予算切れ（enter() での事前チェック、または runStage のガード発火）による
    // 失敗だけ true。fn 自身が投げた失敗（Playwright 自身のタイムアウト・
    // Electron のクラッシュ・設定不備など）は原因を判別できないため false のまま
    // 扱う（MEDIUM-5: 名前が「タイムアウトである」と確実に言える場合だけ立てる）。
    this.timedOut = Boolean(timedOut);
  }
}

// タイマーの安全網（後述 runStage）が、fn 自身の timeout より先に勝つ余地を
// 無くすための余白。fn には remainingMs から GUARD_SLACK_MS を引いた値を渡し、
// ガード自身は remainingMs のフルを使う。これにより fn 自身の timeout が
// 常にガードより先に発火する（HIGH-1 の指摘: 同値だと Node のタイマーは登録順で
// 走るため、先に登録されるガードが必ず勝ってしまう）。
const GUARD_SLACK_MS = 2_000;

// 段の所要時間がこれを超えたら、完了を待たずに標準エラー出力（stderr）へ 1 行書く。
// 外側（beforeAll/テストの 120 秒）に打ち切られた場合、この段の Promise チェーンは
// 結果を返す前に放棄され、エラーオブジェクトへ情報を積む通常の経路（wrapStageError）
// は一度も走らない。そのケースでも「どこまで進んで、どこで止まったか」をログに
// 残すための保険（issue #347）。正常時（大多数）は閾値に届かず出力されないため、
// ログは汚れない。
const STAGE_LOG_THRESHOLD_MS = 10_000;

// totalMs: この予算全体で使ってよい合計時間（ms）。
// now: テスト用に注入できる時計（既定は Date.now）。
function createBootBudget(totalMs, { now = Date.now } = {}) {
  if (!(Number.isFinite(totalMs) && totalMs > 0)) {
    throw new Error('createBootBudget: totalMs must be a positive number');
  }
  const startedAt = now();
  const stagePath = [];

  function elapsedMs() {
    return now() - startedAt;
  }

  function describePath() {
    return stagePath.map((e) => `${e.stage}@${e.atMs}ms`).join(' -> ');
  }

  // 次の段に入るための残り時間を返す。総予算を既に使い切っている場合は、
  // その段の処理（Electron の起動 API 呼び出し等）を一切実行せず、ここで
  // 即座に BootStageError を投げる。「詰まった段」ではなく「入る前に
  // 予算が尽きていた段」であることが分かるよう、メッセージにその区別を残す。
  function enter(stage) {
    const usedMs = elapsedMs();
    stagePath.push({ stage, atMs: usedMs });
    const remainingMs = totalMs - usedMs;
    if (remainingMs <= 0) {
      throw new BootStageError(
        `起動シーケンスの総予算 ${totalMs}ms を "${stage}" に入る前に使い切った`
          + `（経路: ${describePath()}）。`,
        { stage, elapsedMs: usedMs, budgetMs: totalMs, stagePath: stagePath.slice(), timedOut: true },
      );
    }
    return remainingMs;
  }

  // 段の実行中に起きた失敗を、「どの段で・それまでに何 ms 使ったか」を含む形に
  // ラップする。timedOut は呼び出し側（runStage）が、予算切れによる失敗だと
  // 確実に分かっている場合だけ true を渡す。
  function wrapStageError(stage, error, { timedOut = false } = {}) {
    const usedMs = elapsedMs();
    return new BootStageError(
      `起動シーケンスが "${stage}" で失敗（開始から ${usedMs}ms / 総予算 ${totalMs}ms、`
        + `経路: ${describePath()}）: ${error.message}`,
      { stage, elapsedMs: usedMs, budgetMs: totalMs, stagePath: stagePath.slice(), timedOut, cause: error },
    );
  }

  return {
    enter,
    wrapStageError,
    elapsedMs,
    get totalMs() { return totalMs; },
  };
}

// 1 段分の処理を実行する。budget.enter(stage) で残り時間を取り、
// fn(fnTimeoutMs) を呼ぶ（fn は fnTimeoutMs を Playwright の timeout オプション等に
// そのまま渡すことを想定）。fn が失敗した場合は wrapStageError で段の情報を
// 乗せて再送する（Playwright 自身の Call log やエラーメッセージは error.message /
// cause として保持されるため失われない）。
//
// fn には remainingMs そのものではなく、そこから guardSlackMs（既定 GUARD_SLACK_MS）
// を引いた fnTimeoutMs を渡す。ガード自身は remainingMs のフルで発火するため、fn が
// 自分の timeout を正しく守っている限りガードより先に fn 側のタイムアウトが
// 発火し、Playwright 自身の詳しいエラー（Call log・プロセス終了処理込み）が
// そのまま得られる。ガードは「fn が自分の timeout を守らなかったとき」だけの
// 安全網であり、素の Node API（timeout オプションを持たない処理）を安全に
// 扱うためのものではない設計に変更した（HIGH-1: 以前はガードと fn の timeout が
// 同値だったため、Node のタイマーが登録順に発火する仕様上ガードが常に勝ち、
// fn 側のエラー情報が丸ごと捨てられていた）。
//
// remainingMs が guardSlackMs 以下しか残っていない場合、fn へ渡す timeout が
// 意味のある正の値を取れない（0 以下になる、または極小になる）。この境地では
// fn を一切呼ばず、この場で予算切れとして打ち切る（MEDIUM-A: 以前は
// Math.max(1, ...) で 1ms に丸めて fn を呼んでいたため、最も確実に「予算切れ」と
// 言える境界でだけ fn 側の失敗として処理され、timedOut が false になっていた）。
//
// guardSlackMs は既定値のまま使うのが通常で、テストで極小予算を使う場合にだけ
// 明示的に小さくする口を残している（第 4 引数）。
async function runStage(budget, stage, fn, { guardSlackMs = GUARD_SLACK_MS, stageLogThresholdMs = STAGE_LOG_THRESHOLD_MS } = {}) {
  const remainingMs = budget.enter(stage);
  if (remainingMs <= guardSlackMs) {
    throw budget.wrapStageError(
      stage,
      new Error(`残り ${remainingMs}ms しかなく、この段に意味のある待ち時間を割り当てられない（余白 ${guardSlackMs}ms 以下）`),
      { timedOut: true },
    );
  }
  // guardSlackMs 分を引いた後も必ず正の値になることは上のチェックで保証されている。
  // それでも Math.max(1, ...) を残しているのは、Playwright の timeout オプションは
  // 0 を「無制限」として扱うため、万一 0 以下の値が渡ると、まさにこの予算切れの
  // 段でだけ Playwright 自身の上限が無効化され、HIGH-1 で直したはずのプロセス
  // 取り残しが復活してしまうため（安藤の指摘: 一番効いている 1 文字）。
  const fnTimeoutMs = Math.max(1, remainingMs - guardSlackMs);
  let timer;
  let guardFired = false;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      guardFired = true;
      reject(new Error(`残り ${remainingMs}ms 以内に完了しなかった（fn 側の timeout が機能していない）`));
    }, remainingMs);
  });
  // stageLogThresholdMs で固定して張る（fnTimeoutMs との Math.min は取らない）。
  // fnTimeoutMs の方が短い場合、段は閾値へ到達する前に fn 自身の失敗で先に終わり、
  // finally の clearTimeout がこのログを取り消す。それが正しい挙動であり、
  // Math.min を取って「閾値より早く発火したのに、メッセージには元の閾値を
  // 埋め込む」形にすると、段が失敗するのとほぼ同じ瞬間に「まだ進行中」という
  // 食い違ったログが出る（安藤の実測）。
  const logTimer = setTimeout(() => {
    process.stderr.write(
      `[boot] "${stage}" が ${stageLogThresholdMs}ms を超えてまだ進行中`
        + `（総予算 ${budget.totalMs}ms、開始からの経過 ${budget.elapsedMs()}ms）\n`,
    );
  }, stageLogThresholdMs);
  try {
    return await Promise.race([fn(fnTimeoutMs), guard]);
  } catch (error) {
    if (error instanceof BootStageError) throw error;
    throw budget.wrapStageError(stage, error, { timedOut: guardFired });
  } finally {
    clearTimeout(timer);
    clearTimeout(logTimer);
  }
}

module.exports = { BootStageError, createBootBudget, runStage };
