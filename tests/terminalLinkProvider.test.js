'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTerminalLinkProvider,
  getWrappedLineWindow,
  stringIndexToColumn,
} = require('../renderer/terminalLinkProvider');

// ─── xterm.js の Terminal / Buffer / BufferLine を模した最小限のフェイク ───────────────
// 実物の xterm.js を読み込まず（Electron 無しで動く純粋な node --test 環境のため）、
// renderer/terminalLinkProvider.js が実際に呼び出す公開 API の範囲だけを再現する:
//   IBufferLine.isWrapped / length / getCell(x) / translateToString(trimRight)
//   IBufferCell.getChars() / getWidth()
// translateToString は @xterm/xterm 本体（BufferLine.ts）と同じ「1 セルにつき最低 1 文字
// ぶん進む・中身の無いセルは半角スペース扱い・ワイド文字は width ぶん列を飛ばす」規則で
// 実装する（renderer/terminalLinkProvider.js のコメント参照）。

// 半角文字列から「幅 1 のセル」の配列を作るヘルパー。
function asciiCells(str) {
  return str.split('').map((ch) => ({ chars: ch, width: 1 }));
}

// ワイド文字（全角 1 文字）を「幅 2 のセル + 直後の幅 0 の穴埋めセル」に変換して返す。
function wideCell(ch) {
  return [{ chars: ch, width: 2 }, { chars: '', width: 0 }];
}

function translateCellsToString(cells) {
  let result = '';
  let col = 0;
  while (col < cells.length) {
    const cell = cells[col];
    const chars = cell.chars;
    result += chars.length ? chars : ' ';
    col += cell.width || 1;
  }
  return result;
}

function makeLine(cells, isWrapped) {
  return {
    isWrapped: !!isWrapped,
    length: cells.length,
    translateToString(_trimRight) {
      return translateCellsToString(cells);
    },
    getCell(x) {
      const cell = cells[x];
      if (!cell) return undefined;
      return { getChars: () => cell.chars, getWidth: () => cell.width };
    },
  };
}

// cells を cols 列ぶんまで「未書き込みセル」（chars: '', width: 1）で右パディングする。
// 実物の xterm.js（@xterm/xterm, node_modules 配下で実測）は各バッファ行が常に
// buffer.cols 分のセルを持ち、内容が列幅に満たない行は translateToString(false) で
// 残りを半角スペースとして返すため（中身の無いセルは getChars() === '' で、既存の
// translateCellsToString ヘルパーがそれを ' ' として出力する規則に一致）。
function padCells(cells, cols) {
  // 実機ではどの行も常に cols 分のセルしか持てない（cols を超える行は原理的に存在
  // しない）。cells が cols を超えて渡された場合は「実機では起こり得ない行長」の
  // フィクスチャの書き間違いなので、黙って通さずその場で気付けるように例外にする
  // （司レビュー・LOW。罫線テーブル除外テストで cols=11 に対し row0Text が19文字ある
  // フィクスチャが実際に紛れ込んでいた。テスト自体は成立していたためアサーション失敗
  // では検出できず、実行時にここで初めて気付けるようにした）。
  if (cells.length > cols) {
    throw new Error(
      `padCells: cells.length (${cells.length}) が cols (${cols}) を超えています。`
        + ' 実機ではどの行も cols 分のセルしか持てないため、フィクスチャの行の内容を'
        + ' cols 以内に収めてください。',
    );
  }
  const padded = cells.slice();
  while (padded.length < cols) padded.push({ chars: '', width: 1 });
  return padded;
}

// rowsSpec: [{ cells, isWrapped }, ...]（0-based のバッファ行の並びそのもの）から
// Terminal 相当のフェイクを作る。cols は必須（このバッファ全体のペイン幅。実物の
// xterm.js はどの行も常に同じ cols 分のセルを持つため、フェイク側でも共通の値を
// 全行に適用する）。各行の cells は padCells(..., cols) で右パディングされるため、
// 呼び出し側は「実際に書き込まれた分だけ」の cells を渡せばよい。ペイン幅いっぱいまで
// 埋まっている行（isForcedMergeSource の対象にしたい行）を表現したい場合は、その行の
// cells の長さがちょうど cols と一致するように内容を選ぶ（issue #368・案D 安藤レビュー・
// MEDIUM。以前は呼び出し側ごとに padCells を個別に呼ぶ／呼ばないが混在しており、
// 「行長＝内容長」という実機では起こり得ない状態のテストが紛れ込んでいた）。
function makeFakeTerminal(rowsSpec, cols) {
  const lines = rowsSpec.map((spec) => makeLine(padCells(spec.cells, cols), spec.isWrapped));
  return {
    buffer: {
      active: {
        getLine(index) {
          return lines[index];
        },
      },
    },
  };
}

test('getWrappedLineWindow: 折り返し無しの 1 行だけを返す', () => {
  const text = 'hello';
  const terminal = makeFakeTerminal([
    { cells: asciiCells(text), isWrapped: false },
  ], text.length); // cols = 内容の長さ（パディング無しと同じ意味）
  const rows = getWrappedLineWindow(terminal.buffer.active, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].index, 0);
  assert.equal(rows[0].text, text);
  assert.equal(rows[0].forcedMerge, undefined); // 連結していないので付かない
});

test('getWrappedLineWindow: 次行が折り返し継続行なら前方へ連結する', () => {
  // 実 xterm では、isWrapped: true が成り立つのは「前の行がペイン幅いっぱいまで書き込
  // まれてカーソルが折り返した」場合のみ。そのため row0 も cols ちょうどで埋める
  // （row0 だけ未パディングだと、isWrapped: true な row1 が存在するという組み合わせ自体が
  // 実機では起こり得ない状態になってしまう。issue #368・案D 安藤レビュー・MEDIUM）。
  const row0Text = 'https://example.co'; // 18 文字
  const cols = row0Text.length;
  const terminal = makeFakeTerminal([
    { cells: asciiCells(row0Text), isWrapped: false },
    { cells: asciiCells('m/path'), isWrapped: true }, // 折り返し系列の最後の行なので未パディングのままでよい
    { cells: asciiCells(' 続きの行'), isWrapped: false },
  ], cols);
  const rows = getWrappedLineWindow(terminal.buffer.active, 0);
  assert.deepEqual(rows.map((r) => r.index), [0, 1]);
  assert.equal(rows.map((r) => r.text).join('').trimEnd(), 'https://example.com/path');
});

test('getWrappedLineWindow: 継続行そのものを起点にしても前方の行まで遡って連結する', () => {
  const row0Text = 'https://example.co';
  const terminal = makeFakeTerminal([
    { cells: asciiCells(row0Text), isWrapped: false },
    { cells: asciiCells('m/path'), isWrapped: true },
  ], row0Text.length);
  // 折り返し 2 行目（isWrapped: true）を起点に呼んでも、1 行目まで遡って連結できること。
  // 「後半だけホバー/クリックしても反応しない」を防ぐための要件（issue #349 植草レビュー）。
  const rows = getWrappedLineWindow(terminal.buffer.active, 1);
  assert.deepEqual(rows.map((r) => r.index), [0, 1]);
  assert.equal(rows.map((r) => r.text).join('').trimEnd(), 'https://example.com/path');
});

test('getWrappedLineWindow: 空白を含む行に達したらそこで打ち切る', () => {
  const row0Text = 'foo bar'; // 7 文字
  const terminal = makeFakeTerminal([
    { cells: asciiCells(row0Text), isWrapped: false },
    { cells: asciiCells('baz'), isWrapped: true },
  ], row0Text.length);
  const rows = getWrappedLineWindow(terminal.buffer.active, 1);
  // 1 行目に空白があるため、そこを含めて打ち切り（2 行とも含むが、それ以上遡らない）。
  assert.deepEqual(rows.map((r) => r.index), [0, 1]);
});

test('stringIndexToColumn: ワイド文字（全角）を挟んでも列位置を正しく計算する', () => {
  // "日" + "https://example.com"（19 文字）という 1 行を想定。
  const url = 'https://example.com';
  const cells = [...wideCell('日'), ...asciiCells(url)];
  const line = makeLine(cells, false);

  // 文字列 "日https://example.com" の index=1（"h" の直前）はバッファ列 2
  // （"日" が幅 2 を占め、直後の穴埋めセルを飛ばすため）。
  assert.equal(stringIndexToColumn(line, 1), 2);
  // 文字列全体（1 + 19 = 20 文字）の終端はバッファ列 21（列 2..20 の 19 セルぶん進んだ位置）。
  assert.equal(stringIndexToColumn(line, 1 + url.length), 2 + url.length);
});

test('createTerminalLinkProvider: 折り返しをまたいだ URL を 1 本のリンクとして返す', () => {
  const row0Text = '見てください https://example.co';
  const terminal = makeFakeTerminal([
    { cells: asciiCells(row0Text), isWrapped: false },
    { cells: asciiCells('m/path です'), isWrapped: true },
  ], row0Text.length);

  const activateCalls = [];
  const provider = createTerminalLinkProvider(terminal, {
    activate: (event, url) => activateCalls.push(url),
  });

  let received;
  provider.provideLinks(1, (links) => { received = links; }); // 1-based: 1 行目
  assert.equal(received.length, 1);
  const link = received[0];
  assert.equal(link.text, 'https://example.com/path');
  // 1 行目に開始、2 行目で終わる（1-based の y）。
  assert.equal(link.range.start.y, 1);
  assert.equal(link.range.end.y, 2);

  link.activate(new MockEvent(), link.text);
  assert.deepEqual(activateCalls, ['https://example.com/path']);
});

test('createTerminalLinkProvider: URL が無い行は undefined を返す（xterm への「リンク無し」通知）', () => {
  const text = 'ただのログです';
  const terminal = makeFakeTerminal([
    { cells: asciiCells(text), isWrapped: false },
  ], text.length);
  const provider = createTerminalLinkProvider(terminal, { activate: () => {} });
  let received = 'not-called';
  provider.provideLinks(1, (links) => { received = links; });
  assert.equal(received, undefined);
});

test('createTerminalLinkProvider: hover/leave ハンドラに URL を渡す', () => {
  const text = 'https://example.com/path';
  const terminal = makeFakeTerminal([
    { cells: asciiCells(text), isWrapped: false },
  ], text.length);
  const hoverCalls = [];
  const leaveCalls = [];
  const provider = createTerminalLinkProvider(terminal, {
    activate: () => {},
    hover: (event, url) => hoverCalls.push(url),
    leave: (event, url) => leaveCalls.push(url),
  });
  let received;
  provider.provideLinks(1, (links) => { received = links; });
  received[0].hover(new MockEvent(), received[0].text);
  received[0].leave(new MockEvent(), received[0].text);
  assert.deepEqual(hoverCalls, ['https://example.com/path']);
  assert.deepEqual(leaveCalls, ['https://example.com/path']);
});

// activate/hover/leave に渡す MouseEvent はダミーで十分（中身は見ないため）。
function MockEvent() {
  this.metaKey = false;
  this.ctrlKey = false;
}

// ─── 罫線テーブルのセル境界で切り詰められた URL 断片（issue #361） ──────────────────
// 罫線テーブルの各行は「ターミナルの折り返し」ではなく独立したバッファ行のため
// isWrapped は false。getWrappedLineWindow() は連結しないので、1 行目の断片だけが
// 単独の URL 候補として渡ってしまい、リンク化されると 404 になる。
test('createTerminalLinkProvider: 罫線テーブルのセル境界で切り詰められた URL 断片はリンク化しない（issue #361）', () => {
  // issue の再現例そのもの。3行目（0-based index 2）にURLの断片、4行目（index 3）に
  // 続きが表示される。どちらの行も isWrapped: false（罫線テーブルの行は xterm の
  // 折り返しではなく独立したバッファ行のため）。
  //
  // NOTE: asciiCells() は全角文字（"リポジトリ" 等）・罫線文字も含めてすべて幅1の
  // セルとして組み立てる。実際の xterm では日本語は幅2のセル（wideCell()）になるが、
  // このテストで検証するのは「どのバッファ範囲がリンクになるか」ではなく「リンクが
  // 1件も無いこと」だけなので、幅の正確さは検証対象外（安藤レビュー指摘・LOW）。
  const rowTexts = [
    '┌─────────────┬─────────────────────────────────────────────┬──────────────────────────────┐',
    '│ リポジトリ  │                     PR                      │           ブランチ           │',
    '├─────────────┼─────────────────────────────────────────────┼──────────────────────────────┤',
    '│ vk-agents   │ #399 (https://github.com/vektor-inc/vk-agen │ feature/coderabbit-code-revi │',
    '│             │ ts/pull/399)                                │ ew-opt-in                    │',
    '└─────────────┴─────────────────────────────────────────────┴──────────────────────────────┘',
  ];
  // 罫線テーブルは通常どの行も同じ列幅で描画されるため、cols は各行の最大長に揃える
  // （issue #368・案D 安藤レビュー・MEDIUM。行ごとに実際の長さがバラついていても、
  // 一番長い行に他の行を合わせるのが実機に近い）。
  const cols = Math.max(...rowTexts.map((t) => t.length));
  const terminal = makeFakeTerminal(
    rowTexts.map((t) => ({ cells: asciiCells(t), isWrapped: false })),
    cols,
  );

  const provider = createTerminalLinkProvider(terminal, { activate: () => {} });
  let received = 'not-called';
  // 1-based: 4 行目（0-based index 3）＝ 断片 "https://github.com/vektor-inc/vk-agen" が乗る行。
  provider.provideLinks(4, (links) => { received = links; });
  // リンクが1件も無いため xterm へは undefined を返す（＝ホバー・クリックとも一切反応しない）。
  assert.equal(received, undefined);
});

test('createTerminalLinkProvider: 罫線テーブルでも URL の後ろにセル内の文字が続く場合はリンク化を維持する（issue #361 リグレッション）', () => {
  const text = '│ PR │ #399 (https://github.com/vektor-inc/vk-agents/pull/399) マージ済み │';
  const terminal = makeFakeTerminal([
    { cells: asciiCells(text), isWrapped: false },
  ], text.length);
  const provider = createTerminalLinkProvider(terminal, { activate: () => {} });
  let received;
  provider.provideLinks(1, (links) => { received = links; });
  assert.equal(received.length, 1);
  assert.equal(received[0].text, 'https://github.com/vektor-inc/vk-agents/pull/399');
});

// 意図して受け入れた仕様（司・植草合意・M2）。terminalLinkProvider.js を経由した
// 実際のバッファでも、セルの末尾にぴったり収まった（切り詰められていない）URL は
// 一律でリンク化されないことを確認する。
test('createTerminalLinkProvider: 罫線テーブルでもセルの末尾にぴったり収まった URL はリンク化しない（issue #361・意図した仕様）', () => {
  const text = '│ https://example.com/a │ ok │';
  const terminal = makeFakeTerminal([
    { cells: asciiCells(text), isWrapped: false },
  ], text.length);
  const provider = createTerminalLinkProvider(terminal, { activate: () => {} });
  let received = 'not-called';
  provider.provideLinks(1, (links) => { received = links; });
  assert.equal(received, undefined);
});

// ─── ペイン幅ちょうどで URL が割れるケース（issue #368） ─────────────────────────────
//
// #365（罫線テーブル）と違い、通常のペイン出力で「1行目がペイン右端ぴったりで終わり、
// 2行目が列0から始まる（インデント無し）」形で URL が割れる再現。
//
// 実測（このリポジトリの @xterm/xterm, node_modules 配下・実際に main.js が
// require.resolve('@xterm/xterm/lib/xterm.js') で読み込むのと同じパッケージ）で
// term.write() を使い、下記2パターンを直接確認した:
//   A. xterm 自身の autowrap で折り返した行 → 継続行の isWrapped は true。
//      getWrappedLineWindow() は正しく連結し、完全な URL 1本のリンクになる（バグ無し）。
//   B. 子プロセス側が列幅ちょうどの位置で実改行（\r\n）を送ってきた場合 → 継続行の
//      isWrapped は false（xterm の autowrap ではなく実改行のため、これは xterm 側の
//      正しい判定）。getWrappedLineWindow() は isWrapped でない行を連結しないため、
//      1行目の断片だけが URL 候補になり、切り詰められた URL がリンク化される
//      （クリックすると 404 になりうる）。
//
// 実際の issue #368 の再現（司からのライブアプリのバッファ）そのものは未実測
// （このタスクでは live な Electron アプリのバッファへアクセスできないため、実際の
// 再現インスタンスの isWrapped 実測値は確認できていない）。ただし上記 A/B の実測により
// 「xterm 自身の autowrap は既存ロジックで問題なく処理できる」ことが確認できたため、
// 現に #368 で崩れているという事実と合わせると、実改行（B）が原因である可能性が高いと
// 推定する（推定であり実測ではない。詳細は報告の「原因の切り分け」参照）。
//
// 以下は上記 A/B を fakeTerminal で再現するテスト（案D 実装後は全件 green）。
// 案D の仕様: 1行目がペイン幅いっぱいまで埋まっている場合は isWrapped が false でも
// 連結候補に含める。ただし連結した URL 候補が「境界（実改行の位置）より前でホストが
// 確定している」場合に限りリンク化する（境界より前に確定していなければ、1行目の断片も
// 含め一切リンク化しない。ホストすり替わり対策。司・植草合意）。

test('getWrappedLineWindow: ソフトラップ（isWrapped: true）でペイン幅ちょうどにパディングされた行を連結する（issue #368 回帰確認）', () => {
  const cols = 24;
  const fullText = 'prefix https://example.com/foo/bar123';
  const row0Text = fullText.slice(0, cols); // ちょうど cols 文字で埋まる（パディング無し）
  const row1RealText = fullText.slice(cols); // 残り。cols に満たない分は未書き込みセルになる

  const terminal = makeFakeTerminal([
    { cells: asciiCells(row0Text), isWrapped: false },
    { cells: asciiCells(row1RealText), isWrapped: true },
  ], cols);

  const provider = createTerminalLinkProvider(terminal, { activate: () => {} });
  let received;
  provider.provideLinks(1, (links) => { received = links; });
  assert.equal(received && received.length, 1);
  assert.equal(received[0].text, 'https://example.com/foo/bar123');
});

// 案D確定後の具体的な期待値（司・植草合意）。
//   1. 実改行 + 行幅いっぱい + ホスト確定後（パスの途中）で切れている
//      → 連結された完全な URL 1本がリンク化される。
//   2. 実改行 + 行幅いっぱい + ホスト未確定（https:// 直後やドメイン名の途中）で切れている
//      → リンクが1本も作られない（1行目の断片も作られないこと）。
//   3. ホストすり替わり（1行目が "https://example.com" でちょうど終わり、2行目が
//      別ホストの続きに見える "evil.example/foo"）→ 連結してもリンク化しない。

test('createTerminalLinkProvider: 実改行でペイン幅いっぱいの行が割れても、ホスト確定後（パスの途中）なら連結した完全な URL をリンク化する（issue #368・案D）', () => {
  const prefix = 'prefix ';
  const url = 'https://example.com/foo/bar123';
  const combined = prefix + url;

  // ホストが確定する位置（スキームの直後に現れる最初の '/' の直後）を求め、
  // そこから少し先（パスの途中）で行が割れるように cols を決める。
  const schemeEnd = combined.indexOf('://') + 3;
  const hostConfirmedAt = combined.indexOf('/', schemeEnd) + 1;
  const cols = hostConfirmedAt + 2; // パスの途中（"/fo" のように2文字先）で切れる

  const row0Text = combined.slice(0, cols); // ちょうど cols 文字で埋まる（ペイン右端ぴったり）
  const row1Text = combined.slice(cols); // 2行目。列0から始まる（インデント無し）

  const terminal = makeFakeTerminal([
    { cells: asciiCells(row0Text), isWrapped: false },
    // 実改行を想定: 子プロセスが自前で改行したケースなので isWrapped は false のまま。
    { cells: asciiCells(row1Text), isWrapped: false },
  ], cols);

  const provider = createTerminalLinkProvider(terminal, { activate: () => {} });
  let received;
  provider.provideLinks(1, (links) => { received = links; });
  assert.equal(received && received.length, 1);
  assert.equal(received[0].text, url);
});

test('createTerminalLinkProvider: 実改行でペイン幅いっぱいの行が割れても、ホスト未確定（ドメイン名の途中）なら断片も含め一切リンク化しない（issue #368・案D）', () => {
  const prefix = 'prefix ';
  const url = 'https://example.com/foo/bar123';
  const combined = prefix + url;

  // "example" の途中（ホスト名を書き終える前）で行が割れる位置を選ぶ。あわせて、2行目
  // （残り）が cols を超えない位置（＝ combined の半分以上）を選ぶ。実機ではどの行も
  // cols を超えるセル数を持てない（cols を超える内容は必ず次の行へさらに折り返される）
  // ため（司レビュー・LOW。padCells が cols 超過を検出するようになり、この制約を
  // 満たさないフィクスチャは書けなくなった）。
  const cols = Math.max(combined.indexOf('example') + 3, Math.ceil(combined.length / 2));
  const row0Text = combined.slice(0, cols);
  const row1Text = combined.slice(cols);

  const terminal = makeFakeTerminal([
    { cells: asciiCells(row0Text), isWrapped: false },
    { cells: asciiCells(row1Text), isWrapped: false },
  ], cols);

  const provider = createTerminalLinkProvider(terminal, { activate: () => {} });
  let received = 'not-called';
  provider.provideLinks(1, (links) => { received = links; });
  // 1行目の断片 "https://example.c"（等）も含め、一切リンク化されないこと。
  assert.equal(received, undefined);
});

test('createTerminalLinkProvider: ホストすり替わり（1行目 https://example.com ちょうど + 2行目 evil.example/foo）は連結してもリンク化しない（issue #368・案D）', () => {
  const cols = 'https://example.com'.length; // ホスト名の直後・パスの '/' が無い位置でちょうど終わる
  const terminal = makeFakeTerminal([
    { cells: asciiCells('https://example.com'), isWrapped: false },
    // 実改行想定。この行だけを見れば "evil.example/foo" というありふれたパス風の文字列。
    { cells: asciiCells('evil.example/foo'), isWrapped: false },
  ], cols);

  const provider = createTerminalLinkProvider(terminal, { activate: () => {} });
  let received = 'not-called';
  provider.provideLinks(1, (links) => { received = links; });
  // 連結すると "https://example.comevil.example/foo" となり、構文上は正当な
  // ホスト名（example.comevil.example）を持つ URL になってしまう。isSafeHttpUrl /
  // isAcceptableUrlHost / hasUserInfo だけではこのすり替わりを検出できないため、
  // 案D のホスト確定チェックで一切リンク化しないことを確認する。
  assert.equal(received, undefined);
});

// クエリの起点行が異なっても同じ結果になることを確認する回帰テスト。
//
// なぜ必要か: getWrappedLineWindow は上方向（前の行を遡る）・下方向（次の行へ進む）の
// 両方から連結ウィンドウを組み立てられるが、強制連結の境界情報（forcedMerge）は
// 「新しく見つけた行」ではなく「境界の直後に来る行」に付ける必要がある。実装時に
// これを取り違えたところ、1行目（provideLinks(1)）をクエリしたときは正しく非リンク化
// される一方、2行目（provideLinks(2)。xterm がユーザーの実際のホバー位置に応じて
// 呼ぶ行）をクエリしたときは hardWrapBoundaries が空のまま extractUrlMatches に渡り、
// ホスト確定チェックが素通りしてリンク化されてしまうバグを、実 @xterm/xterm を使った
// end-to-end 確認で発見した。1行目のテストだけでは検出できなかったため、2行目からの
// クエリも固定する。
test('createTerminalLinkProvider: ホストすり替わりは2行目からクエリしても連結してリンク化しない（issue #368・案D リグレッション）', () => {
  const cols = 'https://example.com'.length;
  const terminal = makeFakeTerminal([
    { cells: asciiCells('https://example.com'), isWrapped: false },
    { cells: asciiCells('evil.example/foo'), isWrapped: false },
  ], cols);

  const provider = createTerminalLinkProvider(terminal, { activate: () => {} });
  let received = 'not-called';
  // 1-based: 2 行目（0-based index 1）から問い合わせる。
  provider.provideLinks(2, (links) => { received = links; });
  assert.equal(received, undefined);
});

// 意図して受け入れた副作用（司判断・issue #368 decision record。
// https://github.com/vektor-inc/vk-terminals/issues/368#issuecomment-5305135743）。
//
// URL がペイン最終列ちょうどで正しく終わり、次行が URL 構成文字（英数字や '-' 等）で
// 始まる場合、案D の条件2（ホスト確定チェック）はホストが既に確定していると判断する
// ため、無関係な次行の内容まで連結してリンク化してしまう。行内の情報だけでは
// 「URL がちょうど終わった直後に無関係な行が続く」場合と「実は続きの URL だった」場合を
// 区別できず、これは原理的に避けられない。発生には「URL が最終列ちょうどで終わる」必要が
// あり、issue #368 本体の不具合（1行目の断片だけがリンク化される）より発生頻度は低いと
// 判断し、#365 で「セルの末尾にぴったり収まった URL は一律リンク化しない」副作用を
// 受け入れたのと同じ扱いで受け入れる（CHANGELOG.md にも明記）。
//
// このテストは「これはバグでは」と後から別方向に直されることを防ぐため、この挙動を
// 意図した仕様として固定する回帰テスト。
test('createTerminalLinkProvider: URL がペイン最終列ちょうどで終わり次行がURL構成文字で始まる場合は連結してしまう（issue #368・案D・意図して受け入れた副作用）', () => {
  const cols = 30;
  const row0Text = 'see https://example.com/abcdef'; // ちょうど 30 文字（cols と一致）
  assert.equal(row0Text.length, cols); // フィクスチャの前提条件（ズレたら気付けるように明示）
  const row1Text = 'done-2026-08-16'; // URL とは無関係の、たまたま URL 構成文字だけの次行

  const terminal = makeFakeTerminal([
    { cells: asciiCells(row0Text), isWrapped: false },
    // 実改行想定（isWrapped: false のまま）。
    { cells: asciiCells(row1Text), isWrapped: false },
  ], cols);

  const provider = createTerminalLinkProvider(terminal, { activate: () => {} });
  let received;
  provider.provideLinks(1, (links) => { received = links; });
  assert.equal(received && received.length, 1);
  // 意図した副作用: 次行の内容まで連結されてしまう（404 等のリスクは #368 本体より
  // 低頻度だが残る。ユーザーには CHANGELOG で周知する）。
  assert.equal(received[0].text, 'https://example.com/abcdefdone-2026-08-16');
});

// ─── 連結上限（MAX_WINDOW_CHARS）は上下方向で独立に数える（司レビュー・退行の再回帰） ──
//
// 一度「上下で通算すべき」という指摘（安藤レビュー・LOW）を反映したが、これは退行
// だった（司の再レビューで検出・安藤さんも「LOW と書いたとおり直さなくてよかった箇所」
// と申告）。上方向を先に処理するため、通算にすると長い1論理行（空白を含まない2048文字
// 以上のソフトラップ = base64・minify済みコード・1行JSON等）で上方向が予算を使い切り、
// 下方向の連結予算がゼロになる。これは origin/main には無かった挙動で、URL がホバー
// 位置より手前で切り詰められてリンク化される（#361・#368 と同種の「断片がリンク化
// されて404」）。方向ごとに独立した予算（origin/main の挙動）へ戻したことをこのテストで
// 固定する。
test('getWrappedLineWindow: 連結上限（MAX_WINDOW_CHARS）は上下方向で独立に数える', () => {
  // 30行 × 100文字（合計3000文字、行内に空白なし）の isWrapped: true チェーンを作り、
  // 中間の行（index 25）から問い合わせる。上方向だけで 2000 文字超（2048 に迫る／超える
  // 行数）を消費するため、もし上下で予算を通算していれば下方向の予算はゼロになり、
  // 最後の行（index 29）まで届かない。
  const cols = 100;
  const rowCount = 30;
  const rowsSpec = [];
  for (let i = 0; i < rowCount; i += 1) {
    const text = `row${String(i).padStart(3, '0')}${'x'.repeat(cols - 6)}`;
    rowsSpec.push({ cells: asciiCells(text), isWrapped: i > 0 });
  }
  const terminal = makeFakeTerminal(rowsSpec, cols);

  const rows = getWrappedLineWindow(terminal.buffer.active, 25);
  const indices = rows.map((r) => r.index);
  // 下方向は独立した予算を持つため、開始行より後ろの行（26〜29）へ最後まで届く。
  assert.ok(
    indices.includes(29),
    `expected window to reach row 29 (downward budget must be independent), got: ${indices.join(',')}`,
  );
});

// ─── ミューテーションガード（安藤レビュー再検証・案D の中核条件を守るネガティブケース） ──
// isRowFullWidth / isForcedMergeSource のテーブル除外は、どちらも壊しても既存テストが
// 1件も落ちない状態だった（安藤さんのミューテーションテストで検出）。以下2件はそれぞれの
// ガードを1つずつ無効化すると壊れる形で書く。

test('getWrappedLineWindow: ペイン幅に満たない（未書き込みセルが残る）行は強制連結の起点にならない（案D・isRowFullWidth のミューテーションガード）', () => {
  // row0 は cols=10 に対して内容が3文字しか無く、末尾7列は未書き込みセルのまま
  // （＝ペイン幅いっぱいではない）。isRowFullWidth を常に true にする変更を入れると、
  // このテストは window=[0, 1] になって落ちる。
  const cols = 10;
  const terminal = makeFakeTerminal([
    { cells: asciiCells('abc'), isWrapped: false },
    { cells: asciiCells('def'), isWrapped: false },
  ], cols);
  const rows = getWrappedLineWindow(terminal.buffer.active, 0);
  assert.deepEqual(rows.map((r) => r.index), [0]);
});

test('getWrappedLineWindow: 罫線テーブルのデータ行を起点にしても、テーブル行を挟んで無関係な次の行までは連結しない（案D・isForcedMergeSource のテーブル除外のミューテーションガード）', () => {
  // row0→row1 は xterm 自身のソフトラップ（isWrapped: true。ペイン幅より広いテーブルが
  // xterm によって折り返された想定。urlLinkify.js の isTruncatedAtTableCellBorder
  // コメント参照）で、これは #365 からの既存経路として連結してよい。
  //
  // row1 はあえて空白を含まない文字列にする（空白を含めると、テーブル除外の判定に
  // 到達する前に「空白を含む行まで来たら打ち切る」という既存の停止条件で先に止まって
  // しまい、テーブル除外を無効化してもテストが検出できなくなるため）。
  //
  // row1→row2 は isWrapped: false のうえ row1 が罫線テーブルの行（縦線2つ以上）なので、
  // isForcedMergeSource のテーブル除外が効いていれば連結されない。この除外を無効化する
  // 変更を入れると、このテストは window=[0, 1, 2] になって落ちる。
  const row1Text = '│path│done│'; // 縦線2つ以上・空白無し・ペイン幅ちょうどのテーブル行
  const cols = row1Text.length;
  // row0 / row2 の内容自体はこのテストの検証対象ではない（row0→row1 は isWrapped: true
  // による既存の連結経路、row1→row2 が連結されないことだけを見ている）ため、cols を
  // 超えないよう slice しておく。実機ではどの行も同じ cols 分のセルしか持てないため、
  // cols より長い行というフィクスチャ自体が実機では起こり得ない状態になる
  // （安藤レビュー・LOW。makeFakeTerminal(rowsSpec, cols) 導入時に埋めきれなかった穴）。
  const row0Text = '│https://example.co'.slice(0, cols); // makeFakeTerminal が cols まで自動パディングする
  const row2Text = '│nextrow│'.slice(0, cols); // 独立した別のテーブル行（makeFakeTerminal が自動パディング）

  const terminal = makeFakeTerminal([
    { cells: asciiCells(row0Text), isWrapped: false },
    { cells: asciiCells(row1Text), isWrapped: true },
    { cells: asciiCells(row2Text), isWrapped: false },
  ], cols);

  const rows = getWrappedLineWindow(terminal.buffer.active, 0);
  assert.deepEqual(rows.map((r) => r.index), [0, 1]);
});
