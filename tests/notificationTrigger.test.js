'use strict';
// Web Push 通知（issue #396）の送信契機（状態が変わった瞬間の検知）と通知文面の
// 組み立てに関する純粋関数のテスト。main.js（Electron 依存）を経由せず、
// utils/notificationTrigger.js 単体で検証する。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  derivePaneNotificationState,
  computeNotificationEvents,
  buildNotificationPayload,
  truncateNotificationTitle,
  MAX_NOTIFICATION_TITLE_LENGTH,
  MAX_NOTIFICATION_TITLE_BYTES,
  TITLE_TRUNCATION_SUFFIX,
} = require('../utils/notificationTrigger');

function pane(overrides) {
  return {
    termId: '1',
    cwd: '/Users/dev/project',
    status: 'idle',
    apiWaitingMerge: false,
    displayTitle: '',
    apiTitle: '',
    taskTitle: '',
    ...overrides,
  };
}

test('derivePaneNotificationState: status が waiting なら waiting: true', () => {
  const result = derivePaneNotificationState(pane({ status: 'waiting' }), []);
  assert.equal(result.waiting, true);
  assert.equal(result.waitingMerge, false);
});

test('derivePaneNotificationState: apiWaitingMerge が true なら waitingMerge: true', () => {
  const result = derivePaneNotificationState(pane({ apiWaitingMerge: true }), []);
  assert.equal(result.waitingMerge, true);
});

test('derivePaneNotificationState: waitingExcludeCwdPatterns に一致する cwd は waiting も waitingMerge も false になる（externalWaiting 経由でも除外する）', () => {
  const result = derivePaneNotificationState(
    pane({ cwd: '/Users/dev/orchestrator-worktree', status: 'waiting', apiWaitingMerge: true }),
    ['orchestrator-worktree']
  );
  assert.equal(result.waiting, false);
  assert.equal(result.waitingMerge, false);
});

test('derivePaneNotificationState: 除外パターンに一致しない cwd は通常どおり判定する', () => {
  const result = derivePaneNotificationState(
    pane({ cwd: '/Users/dev/other-project', status: 'waiting' }),
    ['orchestrator-worktree']
  );
  assert.equal(result.waiting, true);
});

test('computeNotificationEvents: 入力待ちでない→入力待ちの遷移だけがイベントになる', () => {
  const states = { 'pane-1': pane({ termId: '1', status: 'waiting' }) };
  const { events } = computeNotificationEvents({ prevSnapshot: {}, states, excludePatterns: [] });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'waiting');
  assert.equal(events[0].termId, '1');
});

test('computeNotificationEvents: 既に waiting だったペインが waiting のままなら再通知しない（連発防止）', () => {
  const states = { 'pane-1': pane({ termId: '1', status: 'waiting' }) };
  const prevSnapshot = { '1': { waiting: true, waitingMerge: false } };
  const { events } = computeNotificationEvents({ prevSnapshot, states, excludePatterns: [] });
  assert.equal(events.length, 0);
});

test('computeNotificationEvents: waiting → 非waiting → waiting と再度変化すれば、その都度イベントになる', () => {
  const excludePatterns = [];
  let snapshot = {};
  const step1 = computeNotificationEvents({
    prevSnapshot: snapshot,
    states: { 'pane-1': pane({ termId: '1', status: 'waiting' }) },
    excludePatterns,
  });
  snapshot = step1.nextSnapshot;
  assert.equal(step1.events.length, 1);

  const step2 = computeNotificationEvents({
    prevSnapshot: snapshot,
    states: { 'pane-1': pane({ termId: '1', status: 'idle' }) },
    excludePatterns,
  });
  snapshot = step2.nextSnapshot;
  assert.equal(step2.events.length, 0); // 解除は通知しない

  const step3 = computeNotificationEvents({
    prevSnapshot: snapshot,
    states: { 'pane-1': pane({ termId: '1', status: 'waiting' }) },
    excludePatterns,
  });
  assert.equal(step3.events.length, 1); // 再度 waiting になったら再通知する
});

test('computeNotificationEvents: マージ待ちでない→マージ待ちの遷移もイベントになる（waiting とは独立。ただしプロセス起動後に初めて観測した true は基準記録のみ・司の指摘・A-10）', () => {
  // apiWaitingMerge は完全に外部由来のため、空の prevSnapshot からの最初の true は
  // A-10 により基準記録のみで通知されない。いったん false を経てから true になった
  // 2回目の遷移は通常どおり通知される（waiting とは独立に判定されることも併せて確認）。
  const excludePatterns = [];
  const baseline = computeNotificationEvents({
    prevSnapshot: {},
    states: { 'pane-1': pane({ termId: '1', status: 'idle', apiWaitingMerge: true }) },
    excludePatterns,
  });
  assert.equal(baseline.events.length, 0);

  const cleared = computeNotificationEvents({
    prevSnapshot: baseline.nextSnapshot,
    states: { 'pane-1': pane({ termId: '1', status: 'idle', apiWaitingMerge: false }) },
    excludePatterns,
  });
  assert.equal(cleared.events.length, 0);

  const second = computeNotificationEvents({
    prevSnapshot: cleared.nextSnapshot,
    states: { 'pane-1': pane({ termId: '1', status: 'idle', apiWaitingMerge: true }) },
    excludePatterns,
  });
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].kind, 'merge');
});

test('computeNotificationEvents: 同一ペインで waiting（内部判定）と merge（外部由来）の“本当の”遷移が同時に起きれば2件のイベントになる（waiting と merge が独立に判定されることの確認。司の指摘・A-10）', () => {
  const excludePatterns = [];
  // 1回目（isFirstReport）: idle・マージ待ちでない。基準を記録するだけ。
  const step1 = computeNotificationEvents({
    prevSnapshot: {},
    states: { 'pane-1': pane({ termId: '1', status: 'idle', apiWaitingMerge: false }) },
    excludePatterns,
    isFirstReport: true,
  });
  assert.equal(step1.events.length, 0);

  // 2回目: マージ待ちだけ true になる。外部由来の初回 true のため A-10 により
  // 基準記録のみ（通知しない）。
  const step2 = computeNotificationEvents({
    prevSnapshot: step1.nextSnapshot,
    states: { 'pane-1': pane({ termId: '1', status: 'idle', apiWaitingMerge: true }) },
    excludePatterns,
    isFirstReport: false,
  });
  assert.equal(step2.events.length, 0);

  // 3回目: マージ待ちがいったん false に戻る（waiting はまだ idle）。
  const step3 = computeNotificationEvents({
    prevSnapshot: step2.nextSnapshot,
    states: { 'pane-1': pane({ termId: '1', status: 'idle', apiWaitingMerge: false }) },
    excludePatterns,
    isFirstReport: false,
  });
  assert.equal(step3.events.length, 0);

  // 4回目: 内部判定の入力待ち（waiting）が新規に true になるのと同時に、
  // マージ待ち（既に基準は記録済み）も false→true の“本当の”遷移として true になる。
  // waiting・merge それぞれ独立に判定され、2件のイベントになる。
  const step4 = computeNotificationEvents({
    prevSnapshot: step3.nextSnapshot,
    states: { 'pane-1': pane({ termId: '1', status: 'waiting', apiWaitingMerge: true }) },
    excludePatterns,
    isFirstReport: false,
  });
  assert.equal(step4.events.length, 2);
  const kinds = step4.events.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['merge', 'waiting']);
});

test('computeNotificationEvents: 除外パターンに一致するペインは waiting になってもイベントを出さない', () => {
  const states = { 'pane-1': pane({ termId: '1', cwd: '/x/orchestrator', status: 'waiting' }) };
  const { events } = computeNotificationEvents({ prevSnapshot: {}, states, excludePatterns: ['orchestrator'] });
  assert.equal(events.length, 0);
});

test('computeNotificationEvents: states から消えた termId は nextSnapshot からも消える（ペインを閉じた場合の GC）', () => {
  const step1 = computeNotificationEvents({
    prevSnapshot: {},
    states: { 'pane-1': pane({ termId: '1', status: 'waiting' }) },
    excludePatterns: [],
  });
  assert.ok('1' in step1.nextSnapshot);
  const step2 = computeNotificationEvents({
    prevSnapshot: step1.nextSnapshot,
    states: {},
    excludePatterns: [],
  });
  assert.deepEqual(step2.nextSnapshot, {});
});

test('computeNotificationEvents: isFirstReport が true の最初の報告では、入力待ち・マージ待ちのペインが含まれていても events は0件（司の指摘・W-2）', () => {
  const states = {
    'pane-1': pane({ termId: '1', status: 'waiting' }),
    'pane-2': pane({ termId: '2', status: 'idle', apiWaitingMerge: true }),
  };
  const { events, nextSnapshot } = computeNotificationEvents({
    prevSnapshot: {},
    states,
    excludePatterns: [],
    isFirstReport: true,
  });
  assert.equal(events.length, 0);
  // events は抑制されるが、次回比較の基準となる nextSnapshot は通常どおり計算される。
  assert.deepEqual(nextSnapshot, {
    '1': {
      waiting: true, waitingMerge: false, waitingExternalBaselineSeen: false, waitingMergeBaselineSeen: false,
    },
    '2': {
      waiting: false, waitingMerge: true, waitingExternalBaselineSeen: false, waitingMergeBaselineSeen: true,
    },
  });
});

test('computeNotificationEvents: 2回目の報告（isFirstReport: false）では、最初の報告から状態が変わったペインだけ通知される（司の指摘・W-2）', () => {
  const excludePatterns = [];
  const firstStates = {
    'pane-1': pane({ termId: '1', status: 'waiting' }), // 起動時点で既に入力待ち
    'pane-2': pane({ termId: '2', status: 'idle' }),
  };
  const first = computeNotificationEvents({
    prevSnapshot: {},
    states: firstStates,
    excludePatterns,
    isFirstReport: true,
  });
  assert.equal(first.events.length, 0);

  // 2回目: pane-2 が新たに waiting になった（pane-1 は waiting のまま = 変化なし）。
  const secondStates = {
    'pane-1': pane({ termId: '1', status: 'waiting' }),
    'pane-2': pane({ termId: '2', status: 'waiting' }),
  };
  const second = computeNotificationEvents({
    prevSnapshot: first.nextSnapshot,
    states: secondStates,
    excludePatterns,
    isFirstReport: false,
  });
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].termId, '2');
  assert.equal(second.events[0].kind, 'waiting');
});

test('computeNotificationEvents: 2回目の報告で最初の報告から状態が変わっていないペインには通知されない（司の指摘・W-2）', () => {
  const excludePatterns = [];
  const firstStates = {
    'pane-1': pane({ termId: '1', status: 'waiting', apiWaitingMerge: true }), // 起動時点で既に両方
  };
  const first = computeNotificationEvents({
    prevSnapshot: {},
    states: firstStates,
    excludePatterns,
    isFirstReport: true,
  });
  assert.equal(first.events.length, 0);

  // 2回目: pane-1 は入力待ち・マージ待ちのまま何も変わっていない。
  const second = computeNotificationEvents({
    prevSnapshot: first.nextSnapshot,
    states: firstStates,
    excludePatterns,
    isFirstReport: false,
  });
  assert.equal(second.events.length, 0);
});

test('computeNotificationEvents: 外部由来のマージ待ちが false→true になった最初の1回は通知されず、基準として記録される（司の指摘・A-10）', () => {
  const excludePatterns = [];
  const first = computeNotificationEvents({
    prevSnapshot: {},
    states: { 'pane-1': pane({ termId: '1', status: 'idle', apiWaitingMerge: true }) },
    excludePatterns,
    isFirstReport: false, // 起動後最初の報告そのものではない（＝ isFirstReport による一律抑制とは別の経路であることを確認する）
  });
  assert.equal(first.events.length, 0);
  assert.equal(first.nextSnapshot['1'].waitingMergeBaselineSeen, true);
});

test('computeNotificationEvents: 同じペインで外部由来のマージ待ちが true → false → true と戻った場合、2回目の true では通知される（司の指摘・A-10）', () => {
  const excludePatterns = [];
  const first = computeNotificationEvents({
    prevSnapshot: {},
    states: { 'pane-1': pane({ termId: '1', status: 'idle', apiWaitingMerge: true }) },
    excludePatterns,
  });
  assert.equal(first.events.length, 0); // 最初の true は基準記録のみ

  const cleared = computeNotificationEvents({
    prevSnapshot: first.nextSnapshot,
    states: { 'pane-1': pane({ termId: '1', status: 'idle', apiWaitingMerge: false }) },
    excludePatterns,
  });
  assert.equal(cleared.events.length, 0);

  const second = computeNotificationEvents({
    prevSnapshot: cleared.nextSnapshot,
    states: { 'pane-1': pane({ termId: '1', status: 'idle', apiWaitingMerge: true }) },
    excludePatterns,
  });
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].kind, 'merge');
  assert.equal(second.events[0].termId, '1');
});

test('computeNotificationEvents: 別のペインの外部由来 true も、そのペインにとって最初の1回は通知されない（基準はペインごとに独立。司の指摘・A-10）', () => {
  const excludePatterns = [];
  // pane-1 は既に基準を記録済み（1回 true を観測済み）にしておく。
  const seeded = computeNotificationEvents({
    prevSnapshot: {},
    states: { 'pane-1': pane({ termId: '1', status: 'idle', apiWaitingMerge: true }) },
    excludePatterns,
  });
  assert.equal(seeded.events.length, 0);

  // pane-2 は初登場で、今回初めて apiWaitingMerge が true になる。
  const withNewPane = computeNotificationEvents({
    prevSnapshot: seeded.nextSnapshot,
    states: {
      'pane-1': pane({ termId: '1', status: 'idle', apiWaitingMerge: true }), // 変化なし
      'pane-2': pane({ termId: '2', status: 'idle', apiWaitingMerge: true }), // 新規ペインの最初の true
    },
    excludePatterns,
  });
  // pane-1 は既に基準記録済みだが値自体は変わっていないため通知されない。
  // pane-2 は今回が最初の観測のため、pane-1 の基準とは独立に抑制される。
  assert.equal(withNewPane.events.length, 0);
  assert.equal(withNewPane.nextSnapshot['2'].waitingMergeBaselineSeen, true);
});

test('computeNotificationEvents: 内部判定の入力待ちには A-10 の抑制が適用されず、2回目以降の報告で false→true になれば通知される（W-2 の既存挙動の確認。司の指摘・A-10）', () => {
  const excludePatterns = [];
  // 1回目（プロセス起動後最初の報告）: idle。
  const first = computeNotificationEvents({
    prevSnapshot: {},
    states: { 'pane-1': pane({ termId: '1', waiting: false, status: 'idle' }) },
    excludePatterns,
    isFirstReport: true,
  });
  assert.equal(first.events.length, 0);

  // 2回目: 内部判定で新たに waiting: true になった（externalWaiting は伴わない）。
  // isFirstReport ではないため、A-10 の「最初の観測は基準のみ」を内部判定へ広げていなければ、
  // ここで通常どおり通知されるはず。
  const second = computeNotificationEvents({
    prevSnapshot: first.nextSnapshot,
    states: { 'pane-1': pane({ termId: '1', waiting: true, status: 'waiting' }) },
    excludePatterns,
    isFirstReport: false,
  });
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].kind, 'waiting');
  assert.equal(second.events[0].termId, '1');
});

test('computeNotificationEvents: paneLabel は displayTitle を優先し、無ければ既定名 "Terminal <termId>"', () => {
  const withTitle = computeNotificationEvents({
    prevSnapshot: {},
    states: { 'pane-1': pane({ termId: '3', status: 'waiting', displayTitle: 'PR #123 の対応' }) },
    excludePatterns: [],
  });
  assert.equal(withTitle.events[0].paneLabel, 'PR #123 の対応');

  const withoutTitle = computeNotificationEvents({
    prevSnapshot: {},
    states: { 'pane-1': pane({ termId: '3', status: 'waiting' }) },
    excludePatterns: [],
  });
  assert.equal(withoutTitle.events[0].paneLabel, 'Terminal 3');
});

test('buildNotificationPayload: waiting イベントの本文は「入力待ちになりました。」', () => {
  const payload = buildNotificationPayload({ termId: '1', kind: 'waiting', paneLabel: 'My Pane' });
  assert.equal(payload.title, 'My Pane');
  assert.equal(payload.body, '入力待ちになりました。');
  assert.equal(payload.tag, 'vkt-1-waiting');
});

test('buildNotificationPayload: merge イベントの本文は「マージ待ちになりました。」', () => {
  const payload = buildNotificationPayload({ termId: '2', kind: 'merge', paneLabel: 'My Pane' });
  assert.equal(payload.body, 'マージ待ちになりました。');
  assert.equal(payload.tag, 'vkt-2-merge');
});

test('buildNotificationPayload: tag は termId と種別の組み合わせで、別ペイン・別種別なら異なる（上書きが混線しない）', () => {
  const a = buildNotificationPayload({ termId: '1', kind: 'waiting', paneLabel: 'A' });
  const b = buildNotificationPayload({ termId: '1', kind: 'merge', paneLabel: 'A' });
  const c = buildNotificationPayload({ termId: '2', kind: 'waiting', paneLabel: 'B' });
  assert.notEqual(a.tag, b.tag);
  assert.notEqual(a.tag, c.tag);
});

test('buildNotificationPayload: 同じペイン・同じ種別なら常に同じ tag（同一通知は上書きされる）', () => {
  const first = buildNotificationPayload({ termId: '1', kind: 'waiting', paneLabel: 'A' });
  const second = buildNotificationPayload({ termId: '1', kind: 'waiting', paneLabel: 'A（更新後）' });
  assert.equal(first.tag, second.tag);
});

test('buildNotificationPayload: タイトルが上限を超えると切り詰め、末尾に省略記号を付ける（安藤のセキュリティレビュー指摘・LOW-6、植草の UX レビュー再指摘・U-2）', () => {
  const longLabel = 'あ'.repeat(MAX_NOTIFICATION_TITLE_LENGTH + 50);
  const payload = buildNotificationPayload({ termId: '1', kind: 'waiting', paneLabel: longLabel });
  // 省略記号を含めた合計が上限を超えないこと。
  assert.equal(payload.title.length, MAX_NOTIFICATION_TITLE_LENGTH);
  assert.ok(payload.title.endsWith(TITLE_TRUNCATION_SUFFIX), '切り詰めが発生したことが分かるよう末尾に省略記号が付くこと');
  assert.equal(payload.title, 'あ'.repeat(MAX_NOTIFICATION_TITLE_LENGTH - TITLE_TRUNCATION_SUFFIX.length) + TITLE_TRUNCATION_SUFFIX);
});

test('buildNotificationPayload: タイトルが上限以内ならそのまま（省略記号は付かない）', () => {
  const payload = buildNotificationPayload({ termId: '1', kind: 'waiting', paneLabel: 'ちょうどいい長さのペイン名' });
  assert.equal(payload.title, 'ちょうどいい長さのペイン名');
});

test('truncateNotificationTitle: ZWJ結合絵文字（サロゲートペア4つを連結した1書記素）の組を割らずに切り詰める（安藤のセキュリティレビュー再指摘・A-5）', () => {
  // 家族の絵文字（👨‍👩‍👧‍👦）は4つのコードポイント（サロゲートペア）を ZWJ で連結した
  // 1書記素。単純な文字列 slice()（UTF-16 コード単位基準）だと途中で割れて、
  // 壊れた表示（片割れの絵文字・置換文字）になりうる。
  const familyEmoji = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';

  // ちょうど上限（グラフェム数100）なら絵文字を含めて切り詰めなし。
  const exactLabel = 'x'.repeat(MAX_NOTIFICATION_TITLE_LENGTH - 1) + familyEmoji;
  assert.equal(truncateNotificationTitle(exactLabel, MAX_NOTIFICATION_TITLE_LENGTH), exactLabel);

  // 上限を1書記素超える（絵文字の直後にもう1文字ある）と切り詰めが発生する。
  const overLabel = 'x'.repeat(MAX_NOTIFICATION_TITLE_LENGTH - 1) + familyEmoji + 'y';
  const truncated = truncateNotificationTitle(overLabel, MAX_NOTIFICATION_TITLE_LENGTH);
  // ZWJ（結合子）を含む断片が残っていないこと＝絵文字が割れていないことの直接的な確認。
  assert.ok(!truncated.includes('‍'), 'ZWJ 結合絵文字が途中で割れて断片が残っている');
  // 絵文字の先頭コードポイントだけが残っている（片割れ）ことが無いこと。
  // 含むなら必ず完全な形（familyEmoji 全体）で含まれる。
  if (truncated.includes('\u{1F468}')) {
    assert.ok(truncated.includes(familyEmoji), '絵文字が丸ごとではなく断片で含まれている');
  }
});

test('truncateNotificationTitle: 上限以内なら省略記号を付けずそのまま返す', () => {
  assert.equal(truncateNotificationTitle('短いタイトル', MAX_NOTIFICATION_TITLE_LENGTH), '短いタイトル');
  assert.equal(truncateNotificationTitle('', MAX_NOTIFICATION_TITLE_LENGTH), '');
});

test('truncateNotificationTitle: 結合文字を大量に含むタイトルでも、組み立てた結果の UTF-8 バイト長は上限以内に収まる（安藤のセキュリティレビュー再指摘・A-5-b）', () => {
  // 書記素数（見た目上の1文字数）の上限だけでは、1つの書記素クラスタが結合文字
  // （U+0301 結合アキュートアクセント）をいくらでも含みうるためバイト長を保証しない。
  // 安藤が実測した2例（それぞれ旧実装で 10,078 バイト・8,177 バイトになっていた入力）。

  // 例1: 書記素数はちょうど1（'a' に結合文字 5000 個が全て1つの書記素クラスタとして
  // 扱われる）。MAX_NOTIFICATION_TITLE_LENGTH（書記素数）の判定を素通りしてしまう入力。
  const singleGraphemeHeavy = 'a' + '́'.repeat(5000);
  const title1 = buildNotificationPayload({ termId: '1', kind: 'waiting', paneLabel: singleGraphemeHeavy }).title;
  assert.ok(
    Buffer.byteLength(title1, 'utf8') <= MAX_NOTIFICATION_TITLE_BYTES,
    `バイト長が上限を超えている: ${Buffer.byteLength(title1, 'utf8')} bytes`
  );

  // 例2: 書記素数はちょうど MAX_NOTIFICATION_TITLE_LENGTH（100）。書記素数の上限判定
  // だけでは切り詰められない入力。
  const hundredGraphemesHeavy = ('a' + '́'.repeat(40)).repeat(100);
  const title2 = buildNotificationPayload({ termId: '1', kind: 'waiting', paneLabel: hundredGraphemesHeavy }).title;
  assert.ok(
    Buffer.byteLength(title2, 'utf8') <= MAX_NOTIFICATION_TITLE_BYTES,
    `バイト長が上限を超えている: ${Buffer.byteLength(title2, 'utf8')} bytes`
  );

  // どちらも切り詰めが発生した結果、省略記号が付いていること。
  assert.ok(title1.endsWith(TITLE_TRUNCATION_SUFFIX));
  assert.ok(title2.endsWith(TITLE_TRUNCATION_SUFFIX));
});
