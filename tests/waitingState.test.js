'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WAITING_BEEP_COOLDOWN_MS,
  WAITING_MAX_EVAL_INTERVAL_MS,
  WAITING_QUIESCENCE_MS,
  detectBackgroundAgents,
  isOutputQuiescent,
  isWaitingCwdExcluded,
  matchesWaiting,
  nextWaitingState,
  normalizeWaitingExcludeCwdPatterns,
  selectWaitingBuffer,
  shouldBeepForWaiting,
  waitingCheckDelayMs,
} = require('../renderer/waitingState');
const { deriveStatus } = require('../renderer/statusState');
const { stripAnsiForDisplay } = require('../utils/stripAnsi');

// ─── waiting 判定（静止ゲート） ──────────────────────────────────────────────
// issue vektor-inc/vk-orchestrator#212:
//   旧実装は PTY 出力のたびに判定し、かつ「出力再評価では waiting を解除しない」
//   スティッキー設計で、解除経路がユーザー入力（markPaneInput）しか無かったため、
//   一度誤検知すると AI が動き続けても「入力待ち」が張り付いたままになっていた。
//   本 PR では判定タイミングを「出力が静止した時点（＋上限間隔ごと）」に変え、
//   解除の根拠を「判定時点で出力が流れている＝相手は入力を待たずに動いている」に
//   一本化する。静止時点の非マッチでは解除しない（リサイズ再描画で確認文が折り返し、
//   本物の確認待ちでも一時的に非マッチになるため。下の matchesWaiting のテスト参照）。

test('nextWaitingState: 静止時点でマッチしたら入力待ちになる', () => {
  assert.equal(nextWaitingState({ prev: false, matches: true, quiescent: true }), true);
});

test('nextWaitingState: 静止時点でマッチしなければ非待機のまま', () => {
  assert.equal(nextWaitingState({ prev: false, matches: false, quiescent: true }), false);
});

test('nextWaitingState: 入力待ち中にマッチし続けたら入力待ちのまま', () => {
  assert.equal(nextWaitingState({ prev: true, matches: true, quiescent: true }), true);
});

test('nextWaitingState: 静止時点の非マッチでは入力待ちを解除しない', () => {
  // 静止した＝相手が止まっている。ここで解除すると、リサイズ再描画で文言が
  // 折り返してマッチしなくなっただけの本物の確認待ちを取りこぼす。
  assert.equal(nextWaitingState({ prev: true, matches: false, quiescent: true }), true);
});

test('nextWaitingState: 出力が流れている最中の非マッチで入力待ちを解除する', () => {
  // 上限間隔で強制的に呼ばれた評価。出力が流れている＝相手は入力を待たずに
  // 動いている、が解除の根拠。張り付きからの唯一の自動復帰経路。
  assert.equal(nextWaitingState({ prev: true, matches: false, quiescent: false }), false);
});

test('nextWaitingState: 出力が流れていてもマッチしていれば入力待ちのまま', () => {
  assert.equal(nextWaitingState({ prev: true, matches: true, quiescent: false }), true);
});

test('nextWaitingState: 除外対象 cwd ではマッチしても入力待ちにならない', () => {
  const excluded = isWaitingCwdExcluded('/work/vk-orchestrator/tasks', ['vk-orchestrator']);

  assert.equal(excluded, true);
  assert.equal(nextWaitingState({ prev: false, matches: true, excluded, quiescent: true }), false);
});

test('nextWaitingState: 除外対象 cwd では既存の入力待ちも解除する', () => {
  const excluded = isWaitingCwdExcluded('/work/vk-orchestrator/tasks', ['vk-orchestrator']);

  assert.equal(nextWaitingState({ prev: true, matches: true, excluded, quiescent: true }), false);
});

test('nextWaitingState: 除外パターンに一致しない cwd では従来どおり入力待ちになる', () => {
  const excluded = isWaitingCwdExcluded('/work/vk-terminals', ['vk-orchestrator']);

  assert.equal(excluded, false);
  assert.equal(nextWaitingState({ prev: false, matches: true, excluded, quiescent: true }), true);
});

test('nextWaitingState: 出力が流れている最中の解除直後は idle を経由せず running になる', () => {
  // 解除は「出力が流れている」ときだけ起きるので、deriveStatus の recentOutput が真になり
  // status は running に落ち着く。バッジが一瞬 idle にちらつかないことの確認。
  const now = 100_000;
  const lastOutputTime = now - 200; // 出力が流れている
  assert.equal(nextWaitingState({ prev: true, matches: false, quiescent: false }), false);
  assert.equal(
    deriveStatus({
      localWaiting: false,
      externalWaiting: false,
      now,
      lastOutputTime,
      lastInputTime: 0,
      runningIdleTimeoutMs: 1500,
      runningInputGuardMs: 200,
    }),
    'running',
  );
});

// ─── 判定に使うバッファの選択 ────────────────────────────────────────────────

test('selectWaitingBuffer: 静止評価では直近ウィンドウ全体を見る', () => {
  // 画面に残っているダイアログを拾う必要があるため。
  assert.equal(
    selectWaitingBuffer({ quiescent: true, fullBuffer: 'Proceed?\nline 1', recentBuffer: 'line 1' }),
    'Proceed?\nline 1',
  );
});

test('selectWaitingBuffer: 上限評価では前回の評価以降の出力だけを見る', () => {
  // ウィンドウ全体を見ると、点灯のもとになった文言が 80 行バッファから押し出される
  // まで一致し続け、解除までの時間が出力の行数レートに依存してしまう。
  assert.equal(
    selectWaitingBuffer({ quiescent: false, fullBuffer: 'Proceed?\nline 1', recentBuffer: 'line 1' }),
    'line 1',
  );
});

test('selectWaitingBuffer: 上限評価は直近出力のみを見るので、古い確認文言では解除を妨げない', () => {
  // 「点灯のもとになった Proceed? がまだウィンドウに残っている / 直近の出力には
  // 待ち文言が無い」状況で、解除まで到達できることを判定側とつないで確認する。
  const fullBuffer = ['Proceed?', ...Array.from({ length: 40 }, (_v, i) => `line ${i}`)].join('\n');
  const recentBuffer = Array.from({ length: 20 }, (_v, i) => `line ${i + 40}`).join('\n');

  // 出力が流れている最中（上限評価）
  const streaming = selectWaitingBuffer({ quiescent: false, fullBuffer, recentBuffer });
  assert.equal(matchesWaiting(streaming), false);
  assert.equal(nextWaitingState({ prev: true, matches: false, quiescent: false }), false);

  // 出力が止まれば全体を見直すので、画面に残っている確認文言で再点灯する（自己修復）
  const quiesced = selectWaitingBuffer({ quiescent: true, fullBuffer, recentBuffer });
  assert.equal(matchesWaiting(quiesced), true);
  assert.equal(nextWaitingState({ prev: false, matches: true, quiescent: true }), true);
});

test('selectWaitingBuffer: バッファ未設定でも空文字を返す', () => {
  assert.equal(selectWaitingBuffer({ quiescent: false, fullBuffer: 'x' }), '');
  assert.equal(selectWaitingBuffer({ quiescent: true }), '');
});

test('isOutputQuiescent: 静止時間の到達で切り替わる', () => {
  const now = 10_000;
  assert.equal(isOutputQuiescent({ now, lastOutputTime: now - WAITING_QUIESCENCE_MS }), true);
  assert.equal(isOutputQuiescent({ now, lastOutputTime: now - WAITING_QUIESCENCE_MS + 1 }), false);
});

// ─── 判定タイミング ──────────────────────────────────────────────────────────

test('waitingCheckDelayMs: 出力が続いている間は判定を先送りする', () => {
  const now = 10_000;
  // 直前に出力があった → 静止まで丸々 WAITING_QUIESCENCE_MS 待つ
  assert.equal(
    waitingCheckDelayMs({ now, lastOutputTime: now, pendingSince: now }),
    WAITING_QUIESCENCE_MS,
  );
  // 出力から 500ms 経過 → 残り
  assert.equal(
    waitingCheckDelayMs({ now, lastOutputTime: now - 500, pendingSince: now - 500 }),
    WAITING_QUIESCENCE_MS - 500,
  );
});

test('waitingCheckDelayMs: 静止時間を満たしていれば即座に判定する', () => {
  const now = 10_000;
  assert.equal(
    waitingCheckDelayMs({
      now,
      lastOutputTime: now - WAITING_QUIESCENCE_MS,
      pendingSince: now - WAITING_QUIESCENCE_MS,
    }),
    0,
  );
});

test('waitingCheckDelayMs: 出力が鳴り止まなくても上限間隔で必ず判定する（入力待ちでなくても）', () => {
  // 上限が無いと、出力が静止時間未満の間隔で流れ続ける限り一度も判定されず、
  // その間に本物のプロンプトが出ても検知もビープもされない。状態によらず適用する。
  const pendingSince = 10_000;
  const now = pendingSince + WAITING_MAX_EVAL_INTERVAL_MS - 300;
  assert.equal(waitingCheckDelayMs({ now, lastOutputTime: now, pendingSince }), 300);
});

test('waitingCheckDelayMs: 上限を過ぎていれば即座に判定する', () => {
  const pendingSince = 10_000;
  const now = pendingSince + WAITING_MAX_EVAL_INTERVAL_MS + 10_000;
  assert.equal(waitingCheckDelayMs({ now, lastOutputTime: now, pendingSince }), 0);
});

test('waitingCheckDelayMs: 上限は静止までの残り時間より長くならない', () => {
  // 出力が 1 回だけ来て止まった直後（pendingSince = lastOutputTime）は静止側が先に来る。
  const now = 10_000;
  assert.equal(
    waitingCheckDelayMs({ now, lastOutputTime: now, pendingSince: now }),
    WAITING_QUIESCENCE_MS,
  );
});

test('waitingCheckDelayMs: 非静止で評価した直後に張り直すと、次は必ず静止評価になる', () => {
  // 不変条件「バーストの最後の評価は必ず静止評価になる」の担保
  // （checkWaiting() は quiescent === false のとき scheduleWaitingCheck() を張り直す）。
  // 上限で評価した直後は pendingSince がリセットされるので、その状態で張り直したときの
  // 着地点を確かめる。
  const lastOutputTime = 10_000;
  const now = lastOutputTime + 400; // 出力が流れている最中に上限で評価された直後
  assert.equal(isOutputQuiescent({ now, lastOutputTime }), false);

  const delay = waitingCheckDelayMs({ now, lastOutputTime, pendingSince: now });

  // 張り直しの待ち時間は必ず正（0 で即再入して無限ループにならない）。
  assert.ok(delay > 0, `delay must be positive: ${delay}`);
  // これ以上出力が来なければ、着地時点はちょうど静止到達時点になる。
  const nextEvalAt = now + delay;
  assert.equal(nextEvalAt, lastOutputTime + WAITING_QUIESCENCE_MS);
  assert.equal(isOutputQuiescent({ now: nextEvalAt, lastOutputTime }), true);
});

test('waitingCheckDelayMs: 負の待ち時間は 0 に丸める', () => {
  const now = 10_000;
  assert.equal(waitingCheckDelayMs({ now, lastOutputTime: now - 60_000, pendingSince: now - 60_000 }), 0);
});

// ─── ビープのクールダウン ────────────────────────────────────────────────────

test('shouldBeepForWaiting: 初回は鳴らす', () => {
  assert.equal(shouldBeepForWaiting({ now: 10_000, lastBeepAt: 0 }), true);
});

test('shouldBeepForWaiting: クールダウン中の再検知では鳴らさない', () => {
  const lastBeepAt = 10_000;
  assert.equal(
    shouldBeepForWaiting({ now: lastBeepAt + WAITING_BEEP_COOLDOWN_MS - 1, lastBeepAt }),
    false,
  );
});

test('shouldBeepForWaiting: クールダウンを過ぎれば再び鳴らす', () => {
  const lastBeepAt = 10_000;
  assert.equal(
    shouldBeepForWaiting({ now: lastBeepAt + WAITING_BEEP_COOLDOWN_MS, lastBeepAt }),
    true,
  );
});

test('normalizeWaitingExcludeCwdPatterns: 文字列以外・空白のみの値を除外する', () => {
  assert.deepEqual(
    normalizeWaitingExcludeCwdPatterns([' vk-orchestrator ', '', '  ', 42, null, '/tmp/task']),
    ['vk-orchestrator', '/tmp/task'],
  );
});

// ─── 文言パターン ────────────────────────────────────────────────────────────

test('matchesWaiting: 日本語の確認待ち文言を検知する', () => {
  assert.equal(matchesWaiting('作業が完了しました。ご確認をお願いします。'), true);
});

test('matchesWaiting: リサイズ再描画で確認文が折り返された非マッチ例は false', () => {
  const resizedRedraw = [
    '作業が完了しました。ご確認',
    'をお願いします。',
    '✻ Worked for 2m 14s',
  ].join('\n');
  assert.equal(matchesWaiting(resizedRedraw), false);
});

test('matchesWaiting: 第三者の作業を待つ進捗ナレーションは入力待ちにしない', () => {
  // issue vektor-inc/vk-orchestrator#212: サブエージェントの完了待ちを伝える
  // 進捗報告であって、ユーザーへの確認要求ではない。
  const cases = [
    '麗美の分は受領済みです。和田の修正を待っています。',
    'CI の完了を待っています。',
    'サブエージェントの応答を待っています',
    '司の指示を待っています',
    '他チームの対応を待っています',
  ];
  for (const sample of cases) {
    assert.equal(matchesWaiting(sample), false, `誤検知している: ${sample}`);
  }
});

test('matchesWaiting: ユーザー宛ての待ち文言は検知する', () => {
  // 待つ対象の名詞が「ユーザーが差し出すもの」の許可リストに載っていれば検知する。
  const cases = [
    '入力をお待ちしています。',
    '選択をお待ちしています。',
    'ご対応をお待ちしています。',
    'マージするかどうかのご判断をお待ちしています。',
    '※ recap: 承認待ちです。',
    'ご指示をお待ちしています。',
    'ご確認を待っています。',
    'ご返信をお待ちしております。',
  ];
  for (const sample of cases) {
    assert.equal(matchesWaiting(sample), true, `検知できていない: ${sample}`);
  }
});

test('matchesWaiting: 本物の確認待ち UI は従来どおり検知する（回帰防止）', () => {
  const cases = [
    'Do you want to proceed? [y/N]',
    '❯ 1. Yes, allow this time',
    'Enter to select · Esc to cancel',
    '↑/↓ to navigate',
    'この内容で進めてよろしいでしょうか？',
    '実装が完了しました。ご確認をお願いします。',
    '続行しますか',
    'Press Enter to continue',
    '❯ Yes',
  ];
  for (const sample of cases) {
    assert.equal(matchesWaiting(sample), true, `検知できていない: ${sample}`);
  }
});

// ─── detectBackgroundAgents（バックグラウンドサブエージェント数の検知） ───────────
// issue vektor-inc/vk-terminals#340:
//   司令塔（vk-orchestrator）は lastOutputTime（最後の画面出力時刻）が直近かどうかで
//   ペインの稼働を判定している。Claude Code のメイン応答が終わりサブエージェントだけが
//   バックグラウンドで走っている間は画面の再描画が止まるため、司令塔が「作業終了」と
//   誤認してしまう（2026-08-06 に実際発生）。この誤認を防ぐため、画面末尾のフッター表示
//   から実行中のサブエージェント数を読み取る。
//
// 呼び出し側（renderer/app.js）は、累積バッファ（lastLines）ではなく xterm の
// term.buffer.active から読んだ「現在画面のスナップショット」を渡す想定。このテストでは
// その前提を、複数形・入力ボックス行など実機の画面出力を模した文字列で検証する。

test('detectBackgroundAgents: 「← 2 agents · ↓ to manage」を含む画面は 2 を返す', () => {
  // issue #340 記載の実例（Claude Code の画面末尾）を模したもの。
  const screen = [
    '✻ Brewed for 21m 15s · 2 shells still running',
    '───────────────────────────────────────────────',
    '❯ 修正が終わったらそのまま PR まで進めて',
    '───────────────────────────────────────────────',
    '  bypass permissions on (shift+tab to cycle) · esc to interrupt',
    '                              ← 2 agents · ↓ to manage',
  ].join('\n');
  assert.equal(detectBackgroundAgents(screen), 2);
});

test('detectBackgroundAgents: 10 以上の 2 桁の数値も読み取れる', () => {
  const screen = [
    '❯ ',
    '  ? for shortcuts',
    '                              ← 12 agents · ↓ to manage',
  ].join('\n');
  assert.equal(detectBackgroundAgents(screen), 12);
});

test('detectBackgroundAgents: 単数形「← 1 agent」も読み取れる', () => {
  const screen = [
    '❯ ',
    '  accept edits on (shift+tab to cycle)',
    '                              ← 1 agent · ↓ to manage',
  ].join('\n');
  assert.equal(detectBackgroundAgents(screen), 1);
});

test('detectBackgroundAgents: フッターは読めるが agents 表示が無ければ 0', () => {
  const screen = [
    '⏺ 実装が完了しました。',
    '❯ ',
    '  ? for shortcuts',
  ].join('\n');
  assert.equal(detectBackgroundAgents(screen), 0);
});

test('detectBackgroundAgents: 空文字は不明（null）', () => {
  assert.equal(detectBackgroundAgents(''), null);
});

test('detectBackgroundAgents: 未定義・非文字列は不明（null）', () => {
  assert.equal(detectBackgroundAgents(undefined), null);
  assert.equal(detectBackgroundAgents(null), null);
});

test('detectBackgroundAgents: Claude Code 以外の出力（フッターの目印が無い）は不明（null）', () => {
  const screen = [
    '$ npm test',
    '2007 pass / 0 fail',
    '← 2 agents · ↓ to manage', // フッターの目印が無いのでこの文字列自体は判定材料にしない
    '$ ',
  ].join('\n');
  assert.equal(detectBackgroundAgents(screen), null);
});

test('detectBackgroundAgents: サブエージェント終了後は 0 へ戻る（累積バッファ方式の退行防止）', () => {
  // renderer/app.js は t.lastLines（累積バッファ）ではなく、xterm の
  // term.buffer.active から読んだ「現在画面のスナップショット」を都度渡す設計にした。
  // ここでは「サブエージェント稼働中の画面」→「終了後の画面」という 2 回の
  // 独立した呼び出しで検証する。もし実装が累積バッファをそのまま渡す方式（案 B の
  // 素朴な走査や、単純な「最後の一致を採る」方式）だった場合、1 回目の
  // 「← 2 agents」の描画が古い出力として残り続け、2 回目も 2 を返してしまう
  // （完了条件「サブエージェントが終わると 0 に戻ること」を満たせない）。
  const runningScreen = [
    '✻ Brewed for 21m 15s · 2 shells still running',
    '❯ ',
    '  bypass permissions on (shift+tab to cycle)',
    '                              ← 2 agents · ↓ to manage',
  ].join('\n');
  assert.equal(detectBackgroundAgents(runningScreen), 2, 'サブエージェント稼働中は 2 を検知できる必要がある');

  // サブエージェントが終わった直後の画面（現在の画面には agents ヒントがもう無い）。
  const finishedScreen = [
    '⏺ サブエージェントが完了しました。',
    '❯ ',
    '  bypass permissions on (shift+tab to cycle)',
  ].join('\n');
  assert.equal(detectBackgroundAgents(finishedScreen), 0, 'サブエージェント終了後は 0 に戻る必要がある');
});

test('detectBackgroundAgents: ANSI 制御コードが混ざっていても stripAnsiForDisplay 適用後なら判定できる', () => {
  // checkWaiting() と同じ流儀（呼び出し側で stripAnsiForDisplay を通してから渡す）に合わせる。
  const raw = '\x1b[2m✻ Brewed for 21m 15s\x1b[0m\n\x1b[1m❯\x1b[0m \n' +
    '  \x1b[32mbypass permissions on (shift+tab to cycle)\x1b[0m\n' +
    '\x1b[90m                              ← 2 agents · ↓ to manage\x1b[0m';
  const clean = stripAnsiForDisplay(raw);
  assert.equal(detectBackgroundAgents(clean), 2);
});
