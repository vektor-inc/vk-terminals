'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WAITING_BEEP_COOLDOWN_MS,
  WAITING_BEEP_REPEAT_SUPPRESS_MS,
  WAITING_MAX_EVAL_INTERVAL_MS,
  WAITING_PATTERNS,
  WAITING_QUIESCENCE_MS,
  containsIgnoringWhitespace,
  detectBackgroundAgents,
  extractScreenLines,
  findWaitingMatch,
  isOutputQuiescent,
  isWaitingCwdExcluded,
  matchesWaiting,
  nextWaitingState,
  normalizeWaitingExcludeCwdPatterns,
  sameIgnoringWhitespace,
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

// ─── 静止評価での自動解除（issue vektor-inc/vk-terminals#352） ──────────────────
// 旧実装（vk-orchestrator#212）の唯一の解除経路は「出力が流れている最中（quiescent =
// false）の非マッチ」だった。数秒おきに 1 行だけ出力し続けるペイン（vk-orchestrator の
// 常駐ログ等）は、判定のたびに 1.5 秒（WAITING_QUIESCENCE_MS）以上経ってから評価される
// ため quiescent = true にしかならず、この解除経路が一度も回ってこなかった。
// nextWaitingState に onsetStillVisible（点灯根拠の文字列がまだ判定バッファに見えるか）
// を追加し、静止評価でも「根拠が画面から消えていれば解除する」経路を設けた。

test('findWaitingMatch: 一致箇所の文字列を返す（前後の文脈を含む）。非マッチは null', () => {
  const sample = '作業が完了しました。ご確認をお願いします。';
  const match = findWaitingMatch(sample);
  assert.notEqual(match, null);
  assert.equal(typeof match, 'string');
  // 返り値は一致箇所の前後に文脈を含めるため m[0] そのものより長くなり得るが、
  // 元の文字列の部分文字列であることは変わらない。
  assert.ok(sample.includes(match), `返り値が元の文字列の部分文字列になっていない: ${JSON.stringify(match)}`);
  assert.equal(findWaitingMatch('$ echo done'), null);
  assert.equal(findWaitingMatch(''), null);
});

test('findWaitingMatch: matchesWaiting と一致・非一致の判定が揃う', () => {
  const matchSamples = ['Proceed?', 'この内容で進めてよろしいでしょうか？', '❯ Yes'];
  const noMatchSamples = ['$ echo done', 'CI の完了を待っています。'];
  for (const sample of [...matchSamples, ...noMatchSamples]) {
    assert.equal(findWaitingMatch(sample) !== null, matchesWaiting(sample), `不整合: ${sample}`);
  }
});

test('findWaitingMatch: 全角「？」1 文字にしか一致しないケースでも、前後の文脈込みで短すぎない文字列を返す', () => {
  // 懸念点: /[？]\s*$/ の m[0] 自体は「？」1 文字。文脈を含めずに記録すると、後続の
  // 無関係な出力に「？」が 1 つでも含まれるだけで「まだ画面にある」と誤判定し、
  // 疎な出力ペインでの自動解除が実質効かなくなる（レビューで指摘された懸念）。
  const sample = 'この作業は続けても大丈夫？';
  const match = findWaitingMatch(sample);
  assert.notEqual(match, null);
  assert.ok(match.length > 1, `文脈を含めておらず短すぎる: ${JSON.stringify(match)}`);
});

test('containsIgnoringWhitespace: 空白・改行（全角スペース含む）を無視して包含判定する', () => {
  assert.equal(containsIgnoringWhitespace('foo\nbar baz', 'foobarbaz'), true);
  assert.equal(containsIgnoringWhitespace('foo\nbar baz', 'foo bar   baz'), true);
  assert.equal(containsIgnoringWhitespace('ご確認　を　お願いします', 'ご確認をお願いします'), true);
});

test('containsIgnoringWhitespace: 含まれていなければ false', () => {
  assert.equal(containsIgnoringWhitespace('poll 1\npoll 2', 'Proceed?'), false);
});

test('containsIgnoringWhitespace: needle が空・非文字列なら false（空文字列が常に true になる事故を防ぐ）', () => {
  assert.equal(containsIgnoringWhitespace('anything', ''), false);
  assert.equal(containsIgnoringWhitespace('anything', null), false);
  assert.equal(containsIgnoringWhitespace('anything', undefined), false);
});

test('nextWaitingState: onsetStillVisible が無い（追跡できていない）ときは fail-safe で解除しない', () => {
  // onsetStillVisible は本 issue で新規追加した引数であり、守るべき既存の互換は無い。
  // undefined のときに解除しないのは互換維持ではなく、「根拠が追跡できていない・
  // 確かめられない」状況に対する fail-safe（安藤の指摘 LOW-2）。
  assert.equal(nextWaitingState({ prev: true, matches: false, quiescent: true }), true);
});

test('nextWaitingState: 静止時点の非マッチでも、点灯根拠が消えていれば（onsetStillVisible=false）解除する', () => {
  assert.equal(
    nextWaitingState({ prev: true, matches: false, quiescent: true, onsetStillVisible: false }),
    false,
  );
});

test('nextWaitingState: 静止時点の非マッチで、点灯根拠がまだ見えていれば（onsetStillVisible=true）解除しない', () => {
  assert.equal(
    nextWaitingState({ prev: true, matches: false, quiescent: true, onsetStillVisible: true }),
    true,
  );
});

test('シナリオ: 数秒おきに1行だけ出力し続けるペインで、一度点灯したあと静止評価で自動解除される', () => {
  // 点灯: 「Proceed?」を含む行が流れ、静止評価でマッチして waiting になる。
  const onsetLine = 'Proceed?';
  let waiting = nextWaitingState({ prev: false, matches: true, quiescent: true });
  assert.equal(waiting, true);
  const onsetMatch = findWaitingMatch(onsetLine);
  assert.notEqual(onsetMatch, null);

  // その後、無人ペインが数秒おきに無関係な1行だけを出し続け、判定のたびに
  // quiescent = true（出力が疎なので毎回静止時間を超えている）・非マッチになる。
  // 80 行分押し出された結果、点灯根拠の行はもう lastLines に無い。
  const lastLinesAfterEviction = Array.from({ length: 80 }, (_, i) => `[poll] 実行待ちタスクなし ${i}`).join('\n');
  const onsetStillVisible = containsIgnoringWhitespace(lastLinesAfterEviction, onsetMatch);
  assert.equal(onsetStillVisible, false, '押し出された行が残っている想定になっている');

  waiting = nextWaitingState({ prev: true, matches: false, quiescent: true, onsetStillVisible });
  assert.equal(waiting, false, '疎な出力で点灯根拠が消えたのに解除されていない（張り付き回帰）');
});

test('シナリオ: リサイズで折り返しが変わっただけでは解除されない（vektor-inc/vk-terminals#91 再発防止）', () => {
  // 点灯: 本物の確認待ち文言でマッチして waiting になる。
  const onsetLine = '作業が完了しました。ご確認をお願いします。';
  let waiting = nextWaitingState({ prev: false, matches: true, quiescent: true });
  assert.equal(waiting, true);
  const onsetMatch = findWaitingMatch(onsetLine);
  assert.notEqual(onsetMatch, null);

  // リサイズ再描画で確認文の折り返し位置だけが変わり、文字自体は残ったまま
  // 別の行に分割される（既存テスト「リサイズ再描画で確認文が折り返された非マッチ例」と
  // 同種の状況）。静止評価では非マッチになる。
  const resizedBuffer = [
    '作業が完了しました。ご確認',
    'をお願いします。',
    '✻ Worked for 2m 14s',
  ].join('\n');
  assert.equal(matchesWaiting(resizedBuffer), false);

  // しかし空白・改行を無視すれば、点灯根拠の文字はまだ画面に残っている。
  const onsetStillVisible = containsIgnoringWhitespace(resizedBuffer, onsetMatch);
  assert.equal(onsetStillVisible, true, 'リサイズで文字自体が消えた想定になっている');

  waiting = nextWaitingState({ prev: true, matches: false, quiescent: true, onsetStillVisible });
  assert.equal(waiting, true, 'リサイズによる折り返しだけで誤って解除されている（#91 の再発）');
});

test('シナリオ: 枠線付き TUI（Claude Code のプロンプト枠）でリサイズしても解除されない（安藤の指摘 HIGH-2・#91 再発防止）', () => {
  // 空白だけを無視する比較は、折り返しで確認文の改行位置が変わるだけなら安全（文字の
  // 総数は変わらない）。しかし枠線で囲まれたレイアウトでは、リサイズで枠の横幅
  // （╭──────╮ の「─」の本数）自体が変わり、罫線の文字数が増減する。空白だけ
  // 無視する比較のままだと、この本数の変化を「消えた」と誤判定してしまう。
  const onsetLine = [
    '───────────────╮',
    '│ ご確認をお願いします。   │',
    '╰───────────────╯',
  ].join('\n');
  assert.equal(matchesWaiting(onsetLine), true);
  let waiting = nextWaitingState({ prev: false, matches: true, quiescent: true });
  assert.equal(waiting, true);
  const onsetMatch = findWaitingMatch(onsetLine);
  assert.notEqual(onsetMatch, null);

  // リサイズでペイン幅が狭まり、枠の横幅（罫線の本数）自体が変わり、かつ確認文が
  // 「ご確認」と「を」の間で折り返されて再描画された状態。文字自体は残っている。
  const narrowedBuffer = [
    '─────╮',
    '│ ご確認',
    'を│',
    'お願いします。│',
    '╰─────╯',
  ].join('\n');
  // 罫線の本数が変わり、かつ折り返しで許可リストの名詞パターンが分断されたため、
  // 素の文字列比較では非マッチになる（このテストが検証したい「誤って解除され
  // そうになる」状況そのもの）。
  assert.equal(matchesWaiting(narrowedBuffer), false);

  const onsetStillVisible = containsIgnoringWhitespace(narrowedBuffer, onsetMatch);
  assert.equal(
    onsetStillVisible,
    true,
    '枠線の本数が変わっただけなのに「消えた」と誤判定している（#91 の再発）',
  );

  waiting = nextWaitingState({ prev: true, matches: false, quiescent: true, onsetStillVisible });
  assert.equal(waiting, true, '枠線付き TUI のリサイズで誤って解除されている（#91 の再発）');
});

test('containsIgnoringWhitespace: TUI の枠線・罫線（Unicode Box Drawing）も無視する（安藤の指摘 HIGH-2）', () => {
  // 枠の横幅が変わって罫線の本数そのものが増減しても、罫線を除けば一致する。
  assert.equal(containsIgnoringWhitespace('╭───╮\n│ abc │\n╰───╯', '╭─╮\nabc\n╰─╯'), true);
  // 罫線を除いた本文自体が違えば、当然一致しない（緩めすぎて何でも true になっていないことの確認）。
  assert.equal(containsIgnoringWhitespace('╭───╮\n│ abc │\n╰───╯', 'xyz'), false);
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

// ─── ビープの長期抑制（issue #352・植草のレビュー） ─────────────────────────────
// #352 で解除経路（静止評価での自動解除）を追加した結果、疎な出力ペインは
// 「点灯→押し出されて解除→同じ文言で再点灯」の点滅を起こし得る。旧実装は一度点灯
// したら二度と状態が遷移しなかったため、この種の誤検知でもビープは初回 1 回だけ
// だったが、新実装では毎回の再点灯がビープ対象になる。直前と同じ点灯根拠なら
// 通常のクールダウン（WAITING_BEEP_COOLDOWN_MS）ではなく長い猶予
// （WAITING_BEEP_REPEAT_SUPPRESS_MS）で抑止することを確認する。

test('shouldBeepForWaiting: onsetMatch / lastBeepedOnsetMatch を渡さない呼び出しは従来どおり通常クールダウンで判定する（後方互換）', () => {
  const lastBeepAt = 10_000;
  assert.equal(
    shouldBeepForWaiting({ now: lastBeepAt + WAITING_BEEP_COOLDOWN_MS, lastBeepAt }),
    true,
  );
  assert.equal(
    shouldBeepForWaiting({ now: lastBeepAt + WAITING_BEEP_COOLDOWN_MS - 1, lastBeepAt }),
    false,
  );
});

test('shouldBeepForWaiting: 直前と同じ点灯根拠（空白・罫線を無視して同一）なら、通常クールダウンを過ぎていても長期抑制で鳴らさない', () => {
  const lastBeepAt = 10_000;
  const onsetMatch = '[poll] 実行待ちタスクなし';
  assert.equal(
    shouldBeepForWaiting({
      now: lastBeepAt + WAITING_BEEP_COOLDOWN_MS + 1, // 通常のクールダウンは過ぎている
      lastBeepAt,
      onsetMatch,
      lastBeepedOnsetMatch: onsetMatch,
    }),
    false,
    '同じ誤検知の点滅なのに通常クールダウンだけで鳴ってしまっている',
  );
});

test('shouldBeepForWaiting: 直前と同じ点灯根拠でも、長期抑制の猶予を過ぎれば再び鳴らす', () => {
  const lastBeepAt = 10_000;
  const onsetMatch = '[poll] 実行待ちタスクなし';
  assert.equal(
    shouldBeepForWaiting({
      now: lastBeepAt + WAITING_BEEP_REPEAT_SUPPRESS_MS,
      lastBeepAt,
      onsetMatch,
      lastBeepedOnsetMatch: onsetMatch,
    }),
    true,
  );
});

test('shouldBeepForWaiting: 点灯根拠が異なる（別の新しい確認）なら、通常クールダウンだけで鳴らす', () => {
  const lastBeepAt = 10_000;
  assert.equal(
    shouldBeepForWaiting({
      now: lastBeepAt + WAITING_BEEP_COOLDOWN_MS,
      lastBeepAt,
      onsetMatch: 'ご確認をお願いします。',
      lastBeepedOnsetMatch: '[poll] 実行待ちタスクなし',
    }),
    true,
  );
});

test('shouldBeepForWaiting: 空白・罫線だけが違う同一の点灯根拠は「同じ」とみなし長期抑制する', () => {
  const lastBeepAt = 10_000;
  assert.equal(
    shouldBeepForWaiting({
      now: lastBeepAt + WAITING_BEEP_COOLDOWN_MS + 1,
      lastBeepAt,
      onsetMatch: '│ ご確認をお願いします。 │',
      lastBeepedOnsetMatch: 'ご確認\nをお願いします。',
    }),
    false,
  );
});

test('sameIgnoringWhitespace: 空白・罫線を無視して同一なら true', () => {
  assert.equal(sameIgnoringWhitespace('foo\nbar', 'foobar'), true);
  assert.equal(sameIgnoringWhitespace('│ foo │', 'foo'), true);
});

test('sameIgnoringWhitespace: 内容自体が違えば false', () => {
  assert.equal(sameIgnoringWhitespace('foo', 'bar'), false);
});

test('sameIgnoringWhitespace: 非文字列・空文字列は false（空文字列同士が誤って同一と判定されないように）', () => {
  assert.equal(sameIgnoringWhitespace('', ''), false);
  assert.equal(sameIgnoringWhitespace(null, null), false);
  assert.equal(sameIgnoringWhitespace(undefined, 'foo'), false);
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

// ─── フッター截断（ペイン幅による "…" 切り詰め）への耐性 ────────────────────────
// 司からの実機データ（~/.vk-terminals/states.json の lastLines）で確認された、
// 同じペインがペイン幅の変化に応じて異なる長さに截断された実例そのもの。
// フッターの目印（bypass permissions on 等）は行頭側にあるので必ず一致するが、
// agents セグメントは行末側なので真っ先に切られる。「目印が読めた＝0」と早合点すると
// 動いているペインを 0（≒ 止まっている）と誤認させてしまうため、数字が読める限りは
// 截断の深さに関わらず 2 を返せる必要がある。
test('detectBackgroundAgents: フッター截断（実機データ） — 「← 2 agents…」以降、agents の綴りが截断されても 2 を返す', () => {
  const truncatedButReadable = [
    '⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents · ↓ to mana…',
    '⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents…',
    '⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agent…',
    '⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agen…',
    '⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 age…',
    '⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 ag…',
    '⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 a…',
    '⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 …',
    '⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2…',
    '⏵⏵ bypass permissions on · 1 shell · ← 2 agents · ↓ to mana…',
  ];
  for (const line of truncatedButReadable) {
    assert.equal(detectBackgroundAgents(line), 2, `2 を検知できていない: ${line}`);
  }
});

test('detectBackgroundAgents: フッター截断（実機データ） — 数字自体や agents セグメント全体が截断で読めないときは不明（null）', () => {
  const truncatedUnreadable = [
    // 矢印はあるが数字自体が截断で消えている。0 台の数字さえ読み取れないので不明。
    '⏵⏵ bypass permissions on (shift+tab to cycle) · ← …',
    // agents セグメント自体が截断で丸ごと見えない（この先に agents があったか分からない）。
    '⏵⏵ bypass permissions on (shift+tab to cycle) · esc to inte…',
  ];
  for (const line of truncatedUnreadable) {
    assert.equal(detectBackgroundAgents(line), null, `null になっていない: ${line}`);
  }
});

test('detectBackgroundAgents: フッターが截断されていなければ agents セグメント無しは 0 のまま（回帰確認）', () => {
  // "esc to interrupt" が最後まで読めていて省略記号も付いていない ＝ 截断されていない。
  const screen = '⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt';
  assert.equal(detectBackgroundAgents(screen), 0);
});

// ─── 「✻ Waiting for N background agent(s) to finish」ナレーション ──────────────
// 「← N agents」ヒントとは別のタイミング（メイン応答がサブエージェントの完了待ちで
// 停止している間）に出る表示。実機で単数・複数の両方を確認済み。
test('detectBackgroundAgents: 「Waiting for 1 background agent to finish」（単数形）は 1 を返す', () => {
  const screen = [
    '✻ Waiting for 1 background agent to finish',
    '',
    '❯ ',
  ].join('\n');
  assert.equal(detectBackgroundAgents(screen), 1);
});

test('detectBackgroundAgents: 「Waiting for 4 background agents to finish」（複数形）は 4 を返す', () => {
  const screen = [
    '✻ Waiting for 4 background agents to finish',
    '',
    '❯ ',
  ].join('\n');
  assert.equal(detectBackgroundAgents(screen), 4);
});

test('detectBackgroundAgents: 「Waiting for N background agent(s)」はフッターの目印が無くても正の証拠として拾う', () => {
  // メイン応答が完全に止まりフッターの入力ボックス自体がまだ描画されていない
  // タイミングでもこのナレーションだけは出るため、目印を要求しない。
  const screen = '✻ Waiting for 2 background agents to finish';
  assert.equal(detectBackgroundAgents(screen), 2);
});

// ─── 「←」の誤検知防止（無関係な文字列との区別） ────────────────────────────────
// "↓ 75.4k tokens" のような既存表示は下矢印（↓）であり左矢印（←）とは別の記号なので
// そもそも衝突しない。ここでは「← N」の直後が agents の断片でも省略記号でもない、
// この issue とは無関係な文字列を誤って拾わないことを確認する。
test('detectBackgroundAgents: 「← N」の直後が agents の断片でも省略記号でもなければ正の証拠として扱わない', () => {
  const screen = [
    '❯ ',
    '  ? for shortcuts',
    '← 5 minutes ago にコミットされました', // agents 表示ではない無関係な文言（仮想例）
  ].join('\n');
  // フッターの目印（? for shortcuts）は截断されていないので、agents 表示無しとして 0。
  assert.equal(detectBackgroundAgents(screen), 0);
});

// ─── 安藤（セキュリティレビュー）の指摘への回帰防止テスト ──────────────────────────

test('detectBackgroundAgents: 走査窓の上部にあるノイズ（← 0 agents 等）が下端の本物の数を打ち消さない（HIGH-1）', () => {
  // 安藤の指摘: 先頭一致だけを見ると、画面上部にたまたま流れた「← 0 agents」表記や
  // 「Waiting for 0 background agents to finish」ナレーションが、画面下端にある
  // 本物の「← 2 agents」を打ち消して 0 を返してしまう（この PR の diff やドキュメントを
  // Claude Code ペインに表示しただけでも再現する）。全行から最大値を採ることで防ぐ。
  const screen = [
    '⏺ 参考: 過去のログには「← 0 agents」という表示が残っていました。', // 上部のノイズ（0 件）
    '✻ Waiting for 0 background agents to finish', // 上部のノイズ（0 件のナレーション）
    '✻ Brewed for 21m 15s · 2 shells still running',
    '❯ ',
    '  bypass permissions on (shift+tab to cycle)',
    '                              ← 2 agents · ↓ to manage', // 画面下端の本物
  ].join('\n');
  assert.equal(detectBackgroundAgents(screen), 2);
});

test('detectBackgroundAgents: 目印行は無傷でもヒント行だけが截断されていれば不明（HIGH-2・2行レイアウト）', () => {
  // 安藤の指摘: agents ヒントがフッターの目印と別行に描かれるレイアウトで、目印行
  // 自体は最後まで読めていても、ヒント行（矢印はあるが数字が截断で読めない）だけが
  // 截断されていれば 0 と断定できない。目印行だけでなく、それより下の全行を
  // 截断チェックの対象にすることで塞ぐ。
  const screen = [
    '❯ ',
    '  bypass permissions on (shift+tab to cycle) · esc to interrupt', // 目印行は無傷
    '                              ← …', // ヒント行だけが截断（数字も読めない）
  ].join('\n');
  assert.equal(detectBackgroundAgents(screen), null);
});

test('detectBackgroundAgents: 目印が無く、迷子の「← 0 agents」しか無ければ不明（null）のまま（MEDIUM-2・N1）', () => {
  // 規則2「目印が無ければ null」は変わらない。「← 0 agents」という信用できない
  // 証拠（実機では出現しないはずの 0）を見たとしても、目印そのものが無い以上、
  // それを根拠に 0 と断定してはいけない（安藤の再レビュー N1 のケース）。
  const screen = [
    '⏺ 参考: 過去のログには「← 0 agents」という表示が残っていました。',
    '$ echo done',
  ].join('\n');
  assert.equal(detectBackgroundAgents(screen), null);
});

test('detectBackgroundAgents: 目印が無く、「Waiting for 0 background agents to finish」しか無ければ不明（null）のまま（MEDIUM-2・N2）', () => {
  const screen = [
    '✻ Waiting for 0 background agents to finish',
    '$ echo done',
  ].join('\n');
  assert.equal(detectBackgroundAgents(screen), null);
});

test('detectBackgroundAgents: 桁数が異常に大きい数値（現実には截断を伴う）は null のまま（LOW: 上限チェック）', () => {
  // 20 桁の数値は実際の端末幅では必ず截断されるため、截断側の判定で null になる
  // ことを確認する（安藤の検証結果「20桁→null」）。
  const screen = [
    '❯ ',
    '  bypass permissions on (shift+tab to cycle)',
    '                              ← 99999999999999999999 age…',
  ].join('\n');
  assert.equal(detectBackgroundAgents(screen), null);
});

test('detectBackgroundAgents: 桁数上限（4桁）を超える数値は 0 と断定せず不明（null）にする（MEDIUM-2・N3）', () => {
  // 截断されていない（省略記号なし）ケースでも、5 桁以上の数値は厳格パターン
  // （\d{1,4} + (?!\d)）には 1 件も一致しない。ここで「一致が無い＝agents 表示が
  // 無い」と早合点すると、JSON に載らないだけで実態は「読み取れなかった」だけの
  // ケースを 0 と断定してしまう。緩いパターン（BACKGROUND_AGENTS_ARROW_AMBIGUOUS_
  // PATTERN）で「agents ヒントらしきものが実在した」ことを検知し、null（不明）にする
  // ことを確認する（安藤の再レビュー・実測「N3 範囲外の5桁 → 0」からの回帰防止）。
  const screen = [
    '❯ ',
    '  bypass permissions on (shift+tab to cycle)',
    '                              ← 99999 agents · ↓ to manage',
  ].join('\n');
  assert.equal(detectBackgroundAgents(screen), null);
});

test('detectBackgroundAgents: 「← 3 apples remaining」は agents ではないので拾わない（MEDIUM-3）', () => {
  const screen = [
    '❯ ',
    '  ? for shortcuts',
    '← 3 apples remaining', // agents 表示ではない無関係な文言
  ].join('\n');
  assert.equal(detectBackgroundAgents(screen), 0);
});

test('detectBackgroundAgents: 先頭ゼロ埋めの数値は 0 と断定せず不明（null）にする（MEDIUM-2・N4）', () => {
  // 「← 0000000002 agents」のように先頭にゼロが並ぶと、桁数上限のための
  // (?!\d) 判定が数字の開始位置から縮めていく形になるため、10 桁分の数字全体が
  // 1〜4 桁のどの切り出し方でも「直後がまだ数字」になり、厳格パターンは結局
  // どこにもマッチしない。実機の Claude Code は先頭ゼロ埋めの表記を出さないため
  // 実際には起きないが、「一致が無い＝agents 表示が無い」と早合点して 0 と断定する
  // のは誤り（0 は確定値であって不明側ではないため、それ自体は安全側の値ではない）。
  // 緩いパターンで「agents ヒントらしきもの」を検知し null（不明）にすることを確認する。
  const screen = [
    '❯ ',
    '  bypass permissions on (shift+tab to cycle)',
    '                              ← 0000000002 agents · ↓ to manage',
  ].join('\n');
  assert.equal(detectBackgroundAgents(screen), null);
});

// 安藤の指摘（MEDIUM-1、および再レビューでの LOW 指摘）: matchAll は元の正規表現
// オブジェクトの lastIndex を「書き換え」はしないが、複製を作る際に「読み取って
// 引き継ぐ」。したがって、g フラグ付きの共有正規表現オブジェクトに対して外部から
// .test()/.exec() が一度でも呼ばれると、以後の matchAll がその汚染された位置から
// 始まってしまい、本来ヒットするはずの一致を取りこぼす（false 0）。
//
// 対応: 該当する 2 定数（WAITING_FOR_BACKGROUND_AGENTS_PATTERN /
// BACKGROUND_AGENTS_ARROW_PATTERN）は module の export から外し（この waitingState.js
// の UMD ラッパーはクロージャなので、Node の require からも一切参照できない）、加えて
// collectAgentCounts が呼び出しのたびに明示的に lastIndex を 0 へリセットする、の
// 二重の対策にした（pattern.lastIndex = 0 の行自体はテストできなくても export を
// 外したことと二重に効いていてコストがゼロなので、そのまま残している）。
//
// 「一致位置が先頭から離れた入力を連続で判定しても毎回正しく検知できる」という形の
// 回帰防止テストは、当初これで足りると考えていたが誤りだった。matchAll は元の
// lastIndex を書き換えない（読み取るだけ）ため、外部からの汚染経路が無い限り
// 共有定数の lastIndex は永久に 0 のままで、リセット行の有無は公開 API 経由の
// 挙動に一切差を生まない（実際に pattern.lastIndex = 0 を外して確認済み。全テスト
// 通過してしまい、退行を検知できなかった）。
//
// 守るべき不変条件は「共有される lastIndex に外から手が届かないこと」そのものであり、
// それは公開面（export 一覧）を直接検証することでしか観測できない。このテストは
// 「汚染が起きたか」ではなく「汚染できる経路が公開されていないか」を見る。
test('waitingState: g フラグ付きの正規表現を export しない（lastIndex 汚染の回帰防止・MEDIUM-1）', () => {
  // g 付き正規表現は lastIndex という可変状態を持つオブジェクト。export すると
  // 外部の .test()/.exec() が lastIndex を進め、その後の matchAll が複製を作る際に
  // その値を引き継いで一致を取り逃す（＝ backgroundAgents が false 0 を返す）。
  // 「matchAll は元を書き換えない」のは書き込みの話で、読み取りは守られない。
  //
  // このテストは「汚染が起きたか」ではなく「汚染できる経路が公開されていないか」を
  // 見る。lastIndex を汚す経路が無いことは公開 API 側からしか観測できないため、
  // 実際に汚染を再現するテストは（意図どおり）書けない。
  for (const [name, value] of Object.entries(require('../renderer/waitingState'))) {
    if (value instanceof RegExp) {
      assert.equal(value.global, false, `g フラグ付きの正規表現を export している: ${name}`);
    }
  }
});

// findWaitingMatch（issue #352）は WAITING_PATTERNS を pattern.exec() でループして回し、
// 返り値の m.index を使って文脈の切り出し位置を決める。g / y フラグ付きの正規表現は
// lastIndex という可変状態を持つため、複数回の exec() 呼び出しの間で位置が持ち越され、
// 同じ入力を渡しても 1 回おきに取りこぼす（安藤の指摘 LOW-1・実演: g 付きパターンを
// 一時的に足して同じ文字列を 3 回渡すと call 0 は一致・call 1 は null・call 2 は
// 再び一致、という交互のふるまいになった）。
// WAITING_PATTERNS は現状 g / y フラグ付きを 1 件も含まないため実害は無いが、将来
// パターンを足すときにこの前提が崩れないよう固定する。
test('WAITING_PATTERNS: g / y フラグを持たない（findWaitingMatch が exec を回すため lastIndex の持ち越しで 1 回おきに取りこぼす回帰の防止・LOW-1）', () => {
  const stateful = WAITING_PATTERNS.filter((p) => p.global || p.sticky);
  assert.deepEqual(stateful, [], `g / y フラグ付きのパターンがある: ${stateful}`);
});

test('detectBackgroundAgents: 「← 5 and counting」は agents ではないので拾わない（MEDIUM-3）', () => {
  const screen = [
    '❯ ',
    '  ? for shortcuts',
    '← 5 and counting', // agents 表示ではない無関係な文言
  ].join('\n');
  assert.equal(detectBackgroundAgents(screen), 0);
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

test('detectBackgroundAgents: Claude Code 以外の出力（フッターの目印も agents ヒントも無い）は不明（null）', () => {
  // 「← N agents」の断片も「Waiting for N background agent(s)」も含まない、
  // フッターの目印も無い素の shell 出力。正の証拠が無く、目印も無いので null。
  const screen = [
    '$ npm test',
    '2007 pass / 0 fail',
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

// ─── extractScreenLines（xterm 画面バッファの切り出し） ─────────────────────────
// issue vektor-inc/vk-terminals#340 / 安藤の指摘（MEDIUM-1）:
//   renderer/app.js の readBackgroundAgents は、xterm の term.buffer.active から
//   末尾 N 行を読んで detectBackgroundAgents に渡す。この切り出し自体（何行目から
//   読むか）にテストが 1 件も無く、「buffer.active だから古い描画は残らない」という
//   案 A の前提が、ペインが N 行より小さいとき（グリッド分割で常態）に崩れることが
//   見落とされていた。app.js は window.* グローバルに依存して Node から require
//   できないため、この切り出しロジックを純粋関数として waitingState.js 側へ移し、
//   xterm の IBuffer と同じ形（length / baseY / getLine）を持つスタブでテストする。

// テスト用の最小スタブ。xterm の IBuffer / IBufferLine の該当プロパティだけを持つ。
function makeStubBuffer({ length, baseY, wrappedIndexes = [] }) {
  return {
    length,
    baseY,
    getLine(i) {
      if (i < 0 || i >= length) return undefined;
      return {
        translateToString: () => `line-${i}`,
        isWrapped: wrappedIndexes.includes(i),
      };
    },
  };
}

test('extractScreenLines: バッファが maxLines 未満なら先頭（0 行目）から全行読む', () => {
  const buffer = makeStubBuffer({ length: 10, baseY: 0 });
  const lines = extractScreenLines(buffer, 20);
  assert.deepEqual(lines, Array.from({ length: 10 }, (_, i) => `line-${i}`));
});

test('extractScreenLines: baseY でクランプし、baseY より前（スクロールバック）を読まない（MEDIUM-1 回帰防止）', () => {
  // total=30 行のバッファで、現在画面（baseY..29）は 5 行しかない小さなペインを想定。
  // baseY によるクランプが無いと、maxLines=20 に合わせて 10 行目から読んでしまい、
  // baseY より前（10〜24 行目、＝現在の画面ではない過去の描画）まで拾ってしまう。
  const buffer = makeStubBuffer({ length: 30, baseY: 25 });
  const lines = extractScreenLines(buffer, 20);
  assert.deepEqual(lines, ['line-25', 'line-26', 'line-27', 'line-28', 'line-29']);
});

test('extractScreenLines: isWrapped な行は改行を挟まず直前の行へ連結する（折り返し対応）', () => {
  // 1 行目（index 1）が isWrapped=true ＝ 0 行目の続き（折り返し）。
  const buffer = makeStubBuffer({ length: 3, baseY: 0, wrappedIndexes: [1] });
  const lines = extractScreenLines(buffer, 20);
  assert.deepEqual(lines, ['line-0line-1', 'line-2']);
});

test('extractScreenLines: getLine が undefined を返す行は読み飛ばす（例外を投げない）', () => {
  const buffer = {
    length: 3,
    baseY: 0,
    getLine: (i) => (i === 1 ? undefined : { translateToString: () => `line-${i}` }),
  };
  assert.deepEqual(extractScreenLines(buffer, 20), ['line-0', 'line-2']);
});

test('extractScreenLines: buffer が不正な形（duck typing 失敗）なら null', () => {
  assert.equal(extractScreenLines(null, 20), null);
  assert.equal(extractScreenLines({}, 20), null);
  assert.equal(extractScreenLines({ length: 10 }, 20), null); // getLine が無い
});

test('extractScreenLines: length が 0 以下なら null', () => {
  const buffer = makeStubBuffer({ length: 0, baseY: 0 });
  assert.equal(extractScreenLines(buffer, 20), null);
});

// ─── 境界値の締め直し（安藤の指摘 LOW-2） ────────────────────────────────────
// 「buffer / maxLines が不正な形なら null」という契約に対し、境界値がいくつか
// 緩かった。結果的には null に落ちるケースもあったが、契約どおり明示的に検証する。

test('extractScreenLines: baseY が buffer.length を超えていても例外にならず null（読める行が無い）', () => {
  // 通常は起こらない想定だが、baseY が総行数を超えるような不整合な入力でも、
  // 負インデックスへの読み出し等を起こさず安全に null へ倒れることを確認する。
  const buffer = makeStubBuffer({ length: 10, baseY: 100 });
  assert.equal(extractScreenLines(buffer, 20), null);
});

test('extractScreenLines: baseY が負の値でも 0 未満へは倒さない（クランプ）', () => {
  const buffer = makeStubBuffer({ length: 5, baseY: -3 });
  const lines = extractScreenLines(buffer, 20);
  assert.deepEqual(lines, ['line-0', 'line-1', 'line-2', 'line-3', 'line-4']);
});

test('extractScreenLines: maxLines が数値でない・0 以下なら null', () => {
  const buffer = makeStubBuffer({ length: 10, baseY: 0 });
  assert.equal(extractScreenLines(buffer, undefined), null);
  assert.equal(extractScreenLines(buffer, NaN), null);
  assert.equal(extractScreenLines(buffer, 0), null);
  assert.equal(extractScreenLines(buffer, -5), null);
  assert.equal(extractScreenLines(buffer, 'twenty'), null);
});
