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
// 実際にこの現象を縮小再現したものが tests/e2e/helpers/boot-budget.test.js にある
// （段の管理外の待ちを先に挟み、擬似クロックで「フック開始からの累積が総予算を
// 超えた」状態を作ると、電子アプリを起動する前段に入ろうとした時点で即座に
// BootTimeoutError が投げられ、どの段で・それまでに何 ms 使ったかがメッセージに
// 残ることを確認している）。
//
// 対策: 各段に固定・相対的なタイマーを与えるのではなく、起動シーケンス全体で
// 単一の絶対デッドラインを 1 回だけ計算し、各段には「そこからの残り」を渡す。
// 残りが尽きている場合は Playwright の API を一切呼ばず、この場でエラーを投げる。
// これにより、内側の検知が構造的に必ず外側（beforeAll/テストの 120 秒）より先に
// 発火するようになる。

'use strict';

class BootTimeoutError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'BootTimeoutError';
    Object.assign(this, details);
  }
}

// totalMs: この予算全体で使ってよい合計時間（ms）。
// now: テスト用に注入できる時計（既定は Date.now）。
function createBootBudget(totalMs, { now = Date.now } = {}) {
  if (!(Number.isFinite(totalMs) && totalMs > 0)) {
    throw new Error('createBootBudget: totalMs must be a positive number');
  }
  const startedAt = now();
  const path = [];

  function elapsedMs() {
    return now() - startedAt;
  }

  function describePath() {
    return path.length ? path.map((e) => `${e.stage}@${e.atMs}ms`).join(' -> ') : '(まだ何も無い)';
  }

  // 次の段に入るための残り時間を返す。総予算を既に使い切っている場合は、
  // その段の処理（Electron の起動 API 呼び出し等）を一切実行せず、ここで
  // 即座に BootTimeoutError を投げる。「詰まった段」ではなく「入る前に
  // 予算が尽きていた段」であることが分かるよう、メッセージにその区別を残す。
  function enter(stage) {
    const usedMs = elapsedMs();
    path.push({ stage, atMs: usedMs });
    const remainingMs = totalMs - usedMs;
    if (remainingMs <= 0) {
      throw new BootTimeoutError(
        `起動シーケンスの総予算 ${totalMs}ms を "${stage}" に入る前に使い切った`
          + `（経路: ${describePath()}）。`,
        { stage, elapsedMs: usedMs, budgetMs: totalMs, path: path.slice() },
      );
    }
    return remainingMs;
  }

  // 段の実行中に起きた失敗（Playwright 自身のタイムアウトも含む）を、
  // 「どの段で・それまでに何 ms 使ったか」を含む形にラップする。
  function wrapStageError(stage, error) {
    const usedMs = elapsedMs();
    const wrapped = new BootTimeoutError(
      `起動シーケンスが "${stage}" で失敗（開始から ${usedMs}ms / 総予算 ${totalMs}ms、`
        + `経路: ${describePath()}）: ${error.message}`,
      { stage, elapsedMs: usedMs, budgetMs: totalMs, path: path.slice() },
    );
    wrapped.cause = error;
    return wrapped;
  }

  return {
    enter,
    wrapStageError,
    elapsedMs,
    get totalMs() { return totalMs; },
  };
}

// 1 段分の処理を実行する。budget.enter(stage) で残り時間を取り、
// fn(remainingMs) を呼ぶ（fn は remainingMs を Playwright の timeout オプション等に
// そのまま渡すことを想定）。fn が失敗した場合は wrapStageError で段の情報を
// 乗せて再送する。fn 自身が timeout を守る保証が無い場合（例: 素の Node API）に
// 備え、remainingMs 経過時点で必ず失敗するガードも重ねて掛ける。
async function runStage(budget, stage, fn) {
  const remainingMs = budget.enter(stage);
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`残り ${remainingMs}ms 以内に完了しなかった`));
    }, remainingMs);
  });
  try {
    return await Promise.race([fn(remainingMs), guard]);
  } catch (error) {
    if (error instanceof BootTimeoutError) throw error;
    throw budget.wrapStageError(stage, error);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { BootTimeoutError, createBootBudget, runStage };
