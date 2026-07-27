'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WAITING_QUIESCENCE_MS,
  WAITING_STUCK_RECHECK_MS,
  isWaitingCwdExcluded,
  matchesWaiting,
  nextWaitingStateOnOutput,
  nextWaitingStateOnQuiescence,
  normalizeWaitingExcludeCwdPatterns,
  waitingCheckDelayMs,
} = require('../renderer/waitingState');

// ─── 静止（quiescence）時点の再評価 ──────────────────────────────────────────
// issue vektor-inc/vk-orchestrator#212:
//   旧実装は「出力再評価では waiting を解除しない」スティッキー設計で、解除経路が
//   ユーザー入力（markPaneInput）しか無かったため、一度誤検知すると AI が動き続けても
//   「入力待ち」が張り付いたままになっていた。
//   本 PR では判定タイミングを「出力が静止した時点」に変え、静止時点では prev に
//   引きずられず素直に再評価する。ただし即解除はせず、リサイズ再描画で確認文が
//   折り返して一時的にマッチしなくなったケース（下の matchesWaiting のテスト参照）で
//   本物の確認待ちを取りこぼさないよう「出力が再開したら解除する」予約に留める。

test('nextWaitingStateOnQuiescence: 静止時点でマッチしたら入力待ちになる', () => {
  assert.deepEqual(
    nextWaitingStateOnQuiescence({ prev: false, matches: true }),
    { waiting: true, clearArmed: false },
  );
});

test('nextWaitingStateOnQuiescence: 静止時点でマッチしなければ非待機のまま', () => {
  assert.deepEqual(
    nextWaitingStateOnQuiescence({ prev: false, matches: false }),
    { waiting: false, clearArmed: false },
  );
});

test('nextWaitingStateOnQuiescence: 入力待ち中にマッチし続けたら入力待ちのまま', () => {
  assert.deepEqual(
    nextWaitingStateOnQuiescence({ prev: true, matches: true }),
    { waiting: true, clearArmed: false },
  );
});

test('nextWaitingStateOnQuiescence: 入力待ち中に非マッチでも即解除せず解除予約にとどめる', () => {
  // 静止した＝相手が止まっている状態なので、ここで解除すると本物の確認待ち
  // （リサイズ再描画で文言が折り返しマッチしなくなっただけ）を取りこぼす。
  assert.deepEqual(
    nextWaitingStateOnQuiescence({ prev: true, matches: false }),
    { waiting: true, clearArmed: true },
  );
});

test('nextWaitingStateOnQuiescence: 除外対象 cwd ではマッチしても入力待ちにならない', () => {
  const excluded = isWaitingCwdExcluded('/work/vk-orchestrator/tasks', ['vk-orchestrator']);

  assert.equal(excluded, true);
  assert.deepEqual(
    nextWaitingStateOnQuiescence({ prev: false, matches: true, excluded }),
    { waiting: false, clearArmed: false },
  );
});

test('nextWaitingStateOnQuiescence: 除外対象 cwd では既存の入力待ちも解除する', () => {
  const excluded = isWaitingCwdExcluded('/work/vk-orchestrator/tasks', ['vk-orchestrator']);

  assert.deepEqual(
    nextWaitingStateOnQuiescence({ prev: true, matches: true, excluded }),
    { waiting: false, clearArmed: false },
  );
});

test('nextWaitingStateOnQuiescence: 除外パターンに一致しない cwd では従来どおり入力待ちになる', () => {
  const excluded = isWaitingCwdExcluded('/work/vk-terminals', ['vk-orchestrator']);

  assert.equal(excluded, false);
  assert.deepEqual(
    nextWaitingStateOnQuiescence({ prev: false, matches: true, excluded }),
    { waiting: true, clearArmed: false },
  );
});

// ─── 出力再開時の解除 ────────────────────────────────────────────────────────

test('nextWaitingStateOnOutput: 解除予約が無ければ出力が来ても入力待ちを保持する', () => {
  assert.deepEqual(
    nextWaitingStateOnOutput({ prev: true, clearArmed: false }),
    { waiting: true, clearArmed: false },
  );
});

test('nextWaitingStateOnOutput: 解除予約済みなら出力再開で入力待ちを解除する', () => {
  // 出力が再開した＝相手は入力を待たずに動いている、という強い根拠。
  assert.deepEqual(
    nextWaitingStateOnOutput({ prev: true, clearArmed: true }),
    { waiting: false, clearArmed: false },
  );
});

test('nextWaitingStateOnOutput: 非待機のときは何も変えない', () => {
  assert.deepEqual(
    nextWaitingStateOnOutput({ prev: false, clearArmed: false }),
    { waiting: false, clearArmed: false },
  );
});

test('nextWaitingStateOnOutput: 除外対象 cwd では入力待ちも解除予約も落とす', () => {
  assert.deepEqual(
    nextWaitingStateOnOutput({ prev: true, clearArmed: false, excluded: true }),
    { waiting: false, clearArmed: false },
  );
});

// ─── 判定タイミング（静止ゲート） ────────────────────────────────────────────

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

test('waitingCheckDelayMs: 入力待ち中に出力が鳴り止まないときは上限時間で再判定する', () => {
  // 誤検知で入力待ちになったまま出力が延々と流れる（スピナー）と静止が訪れず、
  // 再評価の機会が永久に来ない。入力待ち中だけは上限を設けて必ず再評価する。
  const pendingSince = 10_000;
  const now = pendingSince + WAITING_STUCK_RECHECK_MS - 300;
  assert.equal(
    waitingCheckDelayMs({ now, lastOutputTime: now, pendingSince, waiting: true }),
    300,
  );
});

test('waitingCheckDelayMs: 非待機のときは上限を適用せず静止まで待つ', () => {
  const pendingSince = 10_000;
  const now = pendingSince + WAITING_STUCK_RECHECK_MS + 10_000;
  assert.equal(
    waitingCheckDelayMs({ now, lastOutputTime: now, pendingSince, waiting: false }),
    WAITING_QUIESCENCE_MS,
  );
});

test('waitingCheckDelayMs: 負の待ち時間は 0 に丸める', () => {
  const now = 10_000;
  assert.equal(waitingCheckDelayMs({ now, lastOutputTime: now - 60_000, pendingSince: now - 60_000 }), 0);
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
  assert.equal(matchesWaiting('麗美の分は受領済みです。和田の修正を待っています。'), false);
  assert.equal(matchesWaiting('CI の完了を待っています。'), false);
  assert.equal(matchesWaiting('サブエージェントの応答を待っています'), false);
});

test('matchesWaiting: ユーザー宛ての待ち文言は従来どおり検知する', () => {
  assert.equal(matchesWaiting('マージするかどうかのご判断をお待ちしています。'), true);
  assert.equal(matchesWaiting('※ recap: 承認待ちです。'), true);
  assert.equal(matchesWaiting('ご指示をお待ちしています。'), true);
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
