'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TRUST_WINDOW_MS,
  READY_GRACE_MS,
  createTrustPromptGate,
  isTrustPrompt,
  resolvePositiveFiniteMs,
} = require('../utils/trustPromptGate');
const {
  CLAUDE_CURRENT_TRUST_PROMPT,
  CODEX_CURRENT_TRUST_PROMPT,
  CLAUDE_LEGACY_TRUST_PROMPT,
} = require('./fixtures/trustPrompts');

// ─── isTrustPrompt: 信頼確認の文脈判定（issue #373）──────────────────────────

test('isTrustPrompt: 実機採取した Claude Code 現行 UI の信頼確認に一致する', () => {
  assert.equal(isTrustPrompt(CLAUDE_CURRENT_TRUST_PROMPT), true);
});

test('isTrustPrompt: 実機採取した Codex 現行 UI の信頼確認に一致する', () => {
  assert.equal(isTrustPrompt(CODEX_CURRENT_TRUST_PROMPT), true);
});

test('isTrustPrompt: Claude Code 旧 UI の信頼確認に一致する', () => {
  assert.equal(isTrustPrompt(CLAUDE_LEGACY_TRUST_PROMPT), true);
});

test('isTrustPrompt: 一般的な確認画面の Enter to confirm だけでは一致しない', () => {
  const nonTrustConfirmation = [
    'Choose a model',
    '1. Default',
    '2. Advanced',
    'Enter to confirm',
  ].join('\r\n');

  assert.equal(isTrustPrompt(nonTrustConfirmation), false);
});

// ─── canAutoRespond: 時間窓（TRUST_WINDOW_MS）まわり ──────────────────────────

test('canAutoRespond: 窓の内側 かつ ready 未検知なら発火する', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  // ペイン作成から 1 秒後（窓の内側）
  assert.equal(gate.canAutoRespond(spawnTime + 1000), true);
});

test('canAutoRespond: 窓の外（経過時間超過）なら発火しない', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  // ペイン作成から TRUST_WINDOW_MS を 1ms 超えた時刻
  assert.equal(gate.canAutoRespond(spawnTime + TRUST_WINDOW_MS + 1), false);
});

test('canAutoRespond: 窓ちょうどの経過時間（境界）はまだ発火する', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  assert.equal(gate.canAutoRespond(spawnTime + TRUST_WINDOW_MS), true);
});

// ─── canAutoRespond: ready 検知後の猶予（READY_GRACE_MS）まわり ────────────────
// 安藤のセキュリティレビュー（HIGH・issue #371 decision-record）指摘対応: 実機の PTY 出力は
// 「起動バナー（ready）」と「信頼確認ダイアログ（trust）」が別チャンクで届くことがあるため、
// ready 検知を「即座に禁止」にすると、直後のチャンクで届く信頼確認に応答できなくなる。
// この対応として、ready 検知後も READY_GRACE_MS の間だけは自動応答を許可し続ける。

test('canAutoRespond: ready 検知直後（猶予内）はまだ発火する（チャンク分割対策）', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  const readyAt = spawnTime + 100;
  gate.markReadyDetected(readyAt);

  // ready 検知から 500ms 後（READY_GRACE_MS=3000 の内側）
  assert.equal(gate.canAutoRespond(readyAt + 500), true);
  assert.equal(gate.isReadyDetected(), true);
});

test('canAutoRespond: ready 検知から猶予ちょうどの経過時間（境界）はまだ発火する', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  const readyAt = spawnTime + 100;
  gate.markReadyDetected(readyAt);

  assert.equal(gate.canAutoRespond(readyAt + READY_GRACE_MS), true);
});

test('canAutoRespond: ready 検知から猶予を過ぎたら（窓の内側でも）発火しない', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  const readyAt = spawnTime + 100;
  gate.markReadyDetected(readyAt);

  // 猶予を 1ms 超えた時刻。TRUST_WINDOW_MS の窓自体はまだ内側であることに注意
  // （猶予切れが単独で発火を止めることを確認する）。
  const now = readyAt + READY_GRACE_MS + 1;
  assert.ok(now - spawnTime <= TRUST_WINDOW_MS, 'test precondition: still within TRUST_WINDOW_MS');
  assert.equal(gate.canAutoRespond(now), false);
});

test('canAutoRespond: markReadyDetected を複数回呼んでも最初の検知時刻だけが使われる（猶予の起点を延長しない）', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  const firstReadyAt = spawnTime + 100;
  gate.markReadyDetected(firstReadyAt);
  // READY_PATTERN がバッファに残り続け、後続の onData でも一致するケースを模す。
  // 2回目の呼び出しで readyAt が後ろへ動くと猶予が延長されてしまうため、
  // 無視されることを確認する。
  gate.markReadyDetected(firstReadyAt + 10000);

  const now = firstReadyAt + READY_GRACE_MS + 1;
  assert.equal(gate.canAutoRespond(now), false);
});

test('markReadyDetected: now が数値でなければ例外を投げる', () => {
  const gate = createTrustPromptGate({ spawnTime: 1000 });
  assert.throws(() => gate.markReadyDetected(), TypeError);
  assert.throws(() => gate.markReadyDetected('not-a-number'), TypeError);
  assert.throws(() => gate.markReadyDetected(NaN), TypeError);
});

test('canAutoRespond: 一度発火（markTrustHandled）したら二度目は発火しない', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  // 1回目: 窓の内側・ready 未検知なので発火してよい
  assert.equal(gate.canAutoRespond(spawnTime + 500), true);
  gate.markTrustHandled();

  // 2回目: 同じ窓の内側でも、既に発火済みのため発火しない
  assert.equal(gate.canAutoRespond(spawnTime + 600), false);
  assert.equal(gate.isTrustHandled(), true);
});

// ─── shouldStopWatching ────────────────────────────────────────────────────

test('shouldStopWatching: 窓が閉じ、initialCommand も送られる見込みが無ければ監視終了と判定する', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  // 経過時間超過で窓が閉じている・initialCommand も送信済み（pending ではない）
  const now = spawnTime + TRUST_WINDOW_MS + 1;
  assert.equal(gate.shouldStopWatching(now, { initialCommandPending: false }), true);
});

test('shouldStopWatching: ready 検知の猶予内は、initialCommand が pending でなくても監視を続ける', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  const readyAt = spawnTime + 100;
  gate.markReadyDetected(readyAt);

  // 猶予（READY_GRACE_MS）の内側はまだ「窓が閉じた」扱いにならない。
  assert.equal(
    gate.shouldStopWatching(readyAt + 500, { initialCommandPending: false }),
    false
  );
});

test('shouldStopWatching: ready 検知から猶予を過ぎ、initialCommand も送られる見込みが無ければ監視終了と判定する', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  const readyAt = spawnTime + 100;
  gate.markReadyDetected(readyAt);

  const now = readyAt + READY_GRACE_MS + 1;
  assert.equal(gate.shouldStopWatching(now, { initialCommandPending: false }), true);
});

test('shouldStopWatching: ready 検知から猶予を過ぎても、initialCommand がまだ送られうるなら監視を続ける', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  const readyAt = spawnTime + 100;
  gate.markReadyDetected(readyAt);

  const now = readyAt + READY_GRACE_MS + 1;
  // 窓（時間・猶予とも）は閉じているが、initialCommand の送信がまだ起こりうる場合は
  // READY_PATTERN 検知による sendInitialCommand 呼び出しが完了するまで監視を続ける必要がある
  assert.equal(gate.shouldStopWatching(now, { initialCommandPending: true }), false);
});

test('shouldStopWatching: 窓が開いている間は initialCommand が pending でなくても監視を続ける', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  // 窓の内側・ready 未検知（まだ信頼確認が出うる）なので、initialCommand が pending
  // でなくても監視を止めてはいけない
  assert.equal(
    gate.shouldStopWatching(spawnTime + 100, { initialCommandPending: false }),
    false
  );
});

// ─── 時計の巻き戻り耐性（安藤の指摘・MEDIUM） ──────────────────────────────────
// NTP のステップ補正・手動での時刻変更・VM のサスペンド復帰等で時計が巻き戻ると、
// 経過時間が負になりうる。負の経過時間を「窓が開いている」と誤判定しない（＝安全側の
// 「窓の外」扱いにする）ことを確認する。

test('canAutoRespond: spawnTime より前の now（時計の巻き戻り）は窓の外として扱う', () => {
  const spawnTime = 10000;
  const gate = createTrustPromptGate({ spawnTime });

  assert.equal(gate.canAutoRespond(spawnTime - 1), false);
});

test('canAutoRespond: readyAt より前の now（時計の巻き戻り）は猶予の外として扱う', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  const readyAt = spawnTime + 5000;
  gate.markReadyDetected(readyAt);

  // 窓（TRUST_WINDOW_MS）の内側だが、readyAt より前の時刻（巻き戻り）を渡す。
  assert.equal(gate.canAutoRespond(readyAt - 1), false);
});

test('shouldStopWatching: spawnTime より前の now（時計の巻き戻り）は窓が閉じたものとして扱い、監視終了へ倒す', () => {
  const spawnTime = 10000;
  const gate = createTrustPromptGate({ spawnTime });

  assert.equal(gate.shouldStopWatching(spawnTime - 1, { initialCommandPending: false }), true);
});

// ─── createTrustPromptGate: 入力検証・上書き ───────────────────────────────────

test('createTrustPromptGate: spawnTime 未指定は例外を投げる', () => {
  assert.throws(() => createTrustPromptGate({}), TypeError);
  assert.throws(() => createTrustPromptGate(), TypeError);
});

test('createTrustPromptGate: trustWindowMs を指定すると既定の TRUST_WINDOW_MS を上書きできる', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime, trustWindowMs: 5000 });

  assert.equal(gate.canAutoRespond(spawnTime + 5000), true);
  assert.equal(gate.canAutoRespond(spawnTime + 5001), false);
});

test('createTrustPromptGate: readyGraceMs を指定すると既定の READY_GRACE_MS を上書きできる', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime, readyGraceMs: 200 });

  const readyAt = spawnTime + 100;
  gate.markReadyDetected(readyAt);

  assert.equal(gate.canAutoRespond(readyAt + 200), true);
  assert.equal(gate.canAutoRespond(readyAt + 201), false);
});

// ─── resolvePositiveFiniteMs ────────────────────────────────────────────────
// main.js の VK_TERMINALS_TRUST_WINDOW_MS / VK_TERMINALS_READY_GRACE_MS のパースに使う
// 純粋関数（安藤の指摘・必須2）。

test('resolvePositiveFiniteMs: 正の有限な数値文字列はパースして返す', () => {
  assert.equal(resolvePositiveFiniteMs('500', 30000), 500);
  assert.equal(resolvePositiveFiniteMs('1', 30000), 1);
  assert.equal(resolvePositiveFiniteMs('0.5', 30000), 0.5);
});

test('resolvePositiveFiniteMs: 未設定・空文字は fallback を返す', () => {
  assert.equal(resolvePositiveFiniteMs(undefined, 30000), 30000);
  assert.equal(resolvePositiveFiniteMs(null, 30000), 30000);
  assert.equal(resolvePositiveFiniteMs('', 30000), 30000);
});

test('resolvePositiveFiniteMs: 0以下・NaN・Infinity・数値に変換できない文字列は fallback を返す', () => {
  assert.equal(resolvePositiveFiniteMs('0', 30000), 30000);
  assert.equal(resolvePositiveFiniteMs('-100', 30000), 30000);
  assert.equal(resolvePositiveFiniteMs('not-a-number', 30000), 30000);
  assert.equal(resolvePositiveFiniteMs('Infinity', 30000), 30000);
  assert.equal(resolvePositiveFiniteMs('NaN', 30000), 30000);
});

// ─── resolvePositiveFiniteMs: options.max による上限クランプ（短縮のみ許可） ────────
// 安藤のセキュリティレビュー（MEDIUM・issue #371 decision-record）指摘対応: max が
// 無いと、VK_TERMINALS_TRUST_WINDOW_MS / VK_TERMINALS_READY_GRACE_MS は「時間窓を
// 延長して自動応答の防御を無効化する」経路にもなってしまう。main.js は両環境変数とも
// 既定値を max として渡し「既定値以下への短縮のみ」を許可する。ここではその main.js の
// 使い方（fallback と max に同じ既定値を渡す形）に揃えてテストする。

test('resolvePositiveFiniteMs: TRUST_WINDOW_MS 用途で、既定より大きい値は既定値へクランプされる（延長を許さない）', () => {
  // main.js の RESOLVED_TRUST_WINDOW_MS と同じ呼び方（fallback = max = 既定値）。
  assert.equal(
    resolvePositiveFiniteMs('1000000000', TRUST_WINDOW_MS, { max: TRUST_WINDOW_MS }),
    TRUST_WINDOW_MS
  );
  assert.equal(
    resolvePositiveFiniteMs('999999999999', TRUST_WINDOW_MS, { max: TRUST_WINDOW_MS }),
    TRUST_WINDOW_MS
  );
  // 既定値以下（短縮方向）はそのまま採用される。
  assert.equal(
    resolvePositiveFiniteMs('500', TRUST_WINDOW_MS, { max: TRUST_WINDOW_MS }),
    500
  );
  // 既定値ちょうど（境界）はそのまま採用される。
  assert.equal(
    resolvePositiveFiniteMs(String(TRUST_WINDOW_MS), TRUST_WINDOW_MS, { max: TRUST_WINDOW_MS }),
    TRUST_WINDOW_MS
  );
});

test('resolvePositiveFiniteMs: READY_GRACE_MS 用途で、既定より大きい値は既定値へクランプされる（延長を許さない）', () => {
  // main.js の RESOLVED_READY_GRACE_MS と同じ呼び方（fallback = max = 既定値）。
  assert.equal(
    resolvePositiveFiniteMs('1000000000', READY_GRACE_MS, { max: READY_GRACE_MS }),
    READY_GRACE_MS
  );
  assert.equal(
    resolvePositiveFiniteMs('999999999999', READY_GRACE_MS, { max: READY_GRACE_MS }),
    READY_GRACE_MS
  );
  // 既定値以下（短縮方向）はそのまま採用される。
  assert.equal(
    resolvePositiveFiniteMs('300', READY_GRACE_MS, { max: READY_GRACE_MS }),
    300
  );
});

test('resolvePositiveFiniteMs: max 未指定時は従来どおり上限なし（既存呼び出し元は非影響）', () => {
  assert.equal(resolvePositiveFiniteMs('999999999999', 30000), 999999999999);
});
