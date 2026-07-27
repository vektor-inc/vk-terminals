'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WAITING_BEEP_COOLDOWN_MS,
  WAITING_MAX_EVAL_INTERVAL_MS,
  WAITING_QUIESCENCE_MS,
  isOutputQuiescent,
  isWaitingCwdExcluded,
  matchesWaiting,
  nextWaitingState,
  normalizeWaitingExcludeCwdPatterns,
  shouldBeepForWaiting,
  waitingCheckDelayMs,
} = require('../renderer/waitingState');
const { deriveStatus } = require('../renderer/statusState');

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
