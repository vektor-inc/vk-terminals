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

// rowsSpec: [{ cells, isWrapped }, ...]（0-based のバッファ行の並びそのもの）から
// Terminal 相当のフェイクを作る。
function makeFakeTerminal(rowsSpec) {
  const lines = rowsSpec.map((spec) => makeLine(spec.cells, spec.isWrapped));
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
  const terminal = makeFakeTerminal([
    { cells: asciiCells('hello'), isWrapped: false },
  ]);
  const rows = getWrappedLineWindow(terminal.buffer.active, 0);
  assert.deepEqual(rows, [{ index: 0, text: 'hello' }]);
});

test('getWrappedLineWindow: 次行が折り返し継続行なら前方へ連結する', () => {
  const terminal = makeFakeTerminal([
    { cells: asciiCells('https://example.co'), isWrapped: false },
    { cells: asciiCells('m/path'), isWrapped: true },
    { cells: asciiCells(' 続きの行'), isWrapped: false },
  ]);
  const rows = getWrappedLineWindow(terminal.buffer.active, 0);
  assert.deepEqual(rows.map((r) => r.index), [0, 1]);
  assert.equal(rows.map((r) => r.text).join(''), 'https://example.com/path');
});

test('getWrappedLineWindow: 継続行そのものを起点にしても前方の行まで遡って連結する', () => {
  const terminal = makeFakeTerminal([
    { cells: asciiCells('https://example.co'), isWrapped: false },
    { cells: asciiCells('m/path'), isWrapped: true },
  ]);
  // 折り返し 2 行目（isWrapped: true）を起点に呼んでも、1 行目まで遡って連結できること。
  // 「後半だけホバー/クリックしても反応しない」を防ぐための要件（issue #349 植草レビュー）。
  const rows = getWrappedLineWindow(terminal.buffer.active, 1);
  assert.deepEqual(rows.map((r) => r.index), [0, 1]);
  assert.equal(rows.map((r) => r.text).join(''), 'https://example.com/path');
});

test('getWrappedLineWindow: 空白を含む行に達したらそこで打ち切る', () => {
  const terminal = makeFakeTerminal([
    { cells: asciiCells('foo bar'), isWrapped: false },
    { cells: asciiCells('baz'), isWrapped: true },
  ]);
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
  const terminal = makeFakeTerminal([
    { cells: asciiCells('見てください https://example.co'), isWrapped: false },
    { cells: asciiCells('m/path です'), isWrapped: true },
  ]);

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
  const terminal = makeFakeTerminal([
    { cells: asciiCells('ただのログです'), isWrapped: false },
  ]);
  const provider = createTerminalLinkProvider(terminal, { activate: () => {} });
  let received = 'not-called';
  provider.provideLinks(1, (links) => { received = links; });
  assert.equal(received, undefined);
});

test('createTerminalLinkProvider: hover/leave ハンドラに URL を渡す', () => {
  const terminal = makeFakeTerminal([
    { cells: asciiCells('https://example.com/path'), isWrapped: false },
  ]);
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
  const terminal = makeFakeTerminal([
    { cells: asciiCells('┌─────────────┬─────────────────────────────────────────────┬──────────────────────────────┐'), isWrapped: false },
    { cells: asciiCells('│ リポジトリ  │                     PR                      │           ブランチ           │'), isWrapped: false },
    { cells: asciiCells('├─────────────┼─────────────────────────────────────────────┼──────────────────────────────┤'), isWrapped: false },
    { cells: asciiCells('│ vk-agents   │ #399 (https://github.com/vektor-inc/vk-agen │ feature/coderabbit-code-revi │'), isWrapped: false },
    { cells: asciiCells('│             │ ts/pull/399)                                │ ew-opt-in                    │'), isWrapped: false },
    { cells: asciiCells('└─────────────┴─────────────────────────────────────────────┴──────────────────────────────┘'), isWrapped: false },
  ]);

  const provider = createTerminalLinkProvider(terminal, { activate: () => {} });
  let received = 'not-called';
  // 1-based: 4 行目（0-based index 3）＝ 断片 "https://github.com/vektor-inc/vk-agen" が乗る行。
  provider.provideLinks(4, (links) => { received = links; });
  // リンクが1件も無いため xterm へは undefined を返す（＝ホバー・クリックとも一切反応しない）。
  assert.equal(received, undefined);
});

test('createTerminalLinkProvider: 罫線テーブルでも URL の後ろにセル内の文字が続く場合はリンク化を維持する（issue #361 リグレッション）', () => {
  const terminal = makeFakeTerminal([
    { cells: asciiCells('│ PR │ #399 (https://github.com/vektor-inc/vk-agents/pull/399) マージ済み │'), isWrapped: false },
  ]);
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
  const terminal = makeFakeTerminal([
    { cells: asciiCells('│ https://example.com/a │ ok │'), isWrapped: false },
  ]);
  const provider = createTerminalLinkProvider(terminal, { activate: () => {} });
  let received = 'not-called';
  provider.provideLinks(1, (links) => { received = links; });
  assert.equal(received, undefined);
});
