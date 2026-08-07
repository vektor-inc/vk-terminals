'use strict';

// xterm.js の Terminal.registerLinkProvider（ILinkProvider）を自前実装して、ペイン内の
// http(s) URL を Cmd/Ctrl+クリックで開けるようにする（issue #349）。
//
// なぜ @xterm/addon-web-links を使わず自前実装なのか（issue コメントに記録した判断の要約）:
//   - 同アドオンがカスタマイズ用に公開しているのは urlRegex（正規表現 1 本の差し替え）のみ。
//     マッチ後の後処理フック（例:「末尾の閉じカッコは対応が取れていれば残す」といった
//     カッコの対応関係を数える処理）は無く、正規表現だけでは表現できない
//     （バックトラッキングはできても「開きカッコの数を数えて判断する」ことは不可能）。
//   - 実際、同アドオンの既定 urlRegex は末尾の閉じカッコを対応関係を見ずに常に落とすため、
//     Wikipedia の "..._(disambiguation)" のような URL 自体が持つ閉じカッコまで壊れる
//     （このリポジトリのテスト tests/urlLinkify.test.js で再現・検証済み）。
//   - 折り返し行をまたぐ URL を 1 本として拾う仕組み（LinkComputer._getWindowedLineStrings /
//     _mapStrIdx）は同アドオンのソース上には存在するが、パッケージの公開 API
//     （@xterm/addon-web-links の d.ts が公開するのは WebLinksAddon クラスのみ）としては
//     外部から一切再利用できない内部実装であるため、正規表現をカスタムする方針を採る場合
//     結局この折り返し処理を自前で書く必要がある。であれば依存を増やさず、xterm.js 本体が
//     公開している Terminal.buffer 経由の API（getLine / isWrapped / translateToString /
//     getCell 等、すべて @xterm/xterm の型定義に載っている公開 API）だけで完結させる方が、
//     触る範囲（依存追加や main.js のリソース解決・bootstrap.js の起動チェックの変更）が
//     小さく済む。
//
// この判断はリポジトリの判断記録（issue #349）にも残す。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKTerminalLinkProvider = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const { extractUrlMatches } = (typeof require === 'function')
    ? require('./urlLinkify')
    : self.VKUrlLinkify;

  // 折り返し行の連結・逆方向探索を打ち切る上限文字数。@xterm/addon-web-links の
  // LinkComputer と同じ値（2048）に揃えている。1 行が異常に長い・折り返し回数が
  // 異常に多いログで連結処理が際限なく伸びるのを防ぐための安全弁で、実務上の
  // URL 長（isSafeHttpUrl の上限も 2048）を大きく下回ることはない。
  const MAX_WINDOW_CHARS = 2048;

  // lineIndex0（0-based のバッファ行）を起点に、折り返しでつながっている前後の行を
  // 連結し、[{ index: 0-based行番号, text: その行の文字列 }, ...] を返す。
  //
  // 展開を打ち切る条件（@xterm/addon-web-links と同じ考え方）:
  //   - 連結後の文字数が MAX_WINDOW_CHARS を超えたら打ち切る。
  //   - 空白を含む行まで遡った／進んだら、その行を含めて打ち切る（URL は空白を含まない
  //     ため、単語の区切りが来た時点でそれ以上先に URL が続くことは無いとみなせる）。
  //
  // translateToString は trimRight を渡さない（false 相当）。trimRight を使うと、
  // 行末に来たワイド文字（全角文字）が次行へ折り返された際に生まれる「幅 1・中身無し」の
  // 穴埋めセルが文字列から欠落し、文字列インデックスとバッファ列の対応がずれる
  // （@xterm/addon-web-links が _mapStrIdx で個別に補正しているのはこのため）。
  // trimRight を使わなければ、そのセルは xterm 自身の translateToString の実装上
  // 半角スペース 1 文字として出力されるため、この補正が不要になる
  // （stringIndexToColumn 側のコメントも参照）。
  function getWrappedLineWindow(buffer, lineIndex0) {
    const line = buffer.getLine(lineIndex0);
    if (!line) return null;

    const rows = [{ index: lineIndex0, text: line.translateToString(false) }];

    // 上方向へ拡張: このバッファ行自体が「前の行からの折り返し」なら、前の行を辿る。
    if (line.isWrapped) {
      let idx = lineIndex0;
      let total = rows[0].text.length;
      for (;;) {
        if (total >= MAX_WINDOW_CHARS) break;
        const prevLine = buffer.getLine(idx - 1);
        if (!prevLine) break;
        const prevText = prevLine.translateToString(false);
        rows.unshift({ index: idx - 1, text: prevText });
        total += prevText.length;
        idx -= 1;
        // 前の行自体が折り返し継続行でなければ、そこが論理行の先頭。
        // 空白を含む行まで辿り着いたら、それより前に URL の続きは無いとみなして打ち切る。
        if (!prevLine.isWrapped || /\s/.test(prevText)) break;
      }
    }

    // 下方向へ拡張: 次の行が「この行からの折り返し」である間、連結する。
    {
      let idx = lineIndex0;
      let total = rows[rows.length - 1].text.length;
      for (;;) {
        if (total >= MAX_WINDOW_CHARS) break;
        const nextLine = buffer.getLine(idx + 1);
        if (!nextLine || !nextLine.isWrapped) break;
        const nextText = nextLine.translateToString(false);
        rows.push({ index: idx + 1, text: nextText });
        total += nextText.length;
        idx += 1;
        if (/\s/.test(nextText)) break;
      }
    }

    return rows;
  }

  // 1 バッファ行の中で、その行の translateToString(false) が返す文字列上のインデックス
  // （strIndex 文字目の手前まで）に対応するバッファ列（0-based）を返す。
  //
  // xterm.js の translateToString（BufferLine.ts）と同じ「1 セルにつき最低 1 文字ぶん
  // 進む」規則でセルを歩く:
  //   - 通常のセル: 1 文字ぶん進み、列は width（通常 1、ワイド文字は 2）ぶん進む。
  //   - 中身の無いセル（getChars() === ''）: translateToString 側は半角スペース 1 文字
  //     として出力するため、ここでも 1 文字ぶん進んだものとして扱う
  //     （chars.length || 1。0 は falsy なので || 1 のフォールバックが効く）。
  //   - ワイド文字の直後に来る「幅 0」のセル（IBufferCell.getWidth() の仕様どおり、
  //     ワイド文字の次に来る）は、直前のセルの advance で列を 2 進めた時点で
  //     読み飛ばされる（translateToString も同じ進め方をするため、単独で処理されることは
  //     通常無い）。
  function stringIndexToColumn(line, targetIndex) {
    let col = 0;
    let consumed = 0;
    while (consumed < targetIndex) {
      const cell = line.getCell(col);
      if (!cell) break; // 行末（通常起きない想定だが、安全側に倒して打ち切る）
      const chars = cell.getChars();
      const width = cell.getWidth();
      consumed += chars.length || 1;
      col += width || 1;
    }
    return col;
  }

  // rowOffsets（各行の連結後文字列内での開始オフセット。先頭からの昇順）から、
  // offset が属する行を探し、バッファ上の (行, 列) を返す。
  function mergedOffsetToBufferPosition(buffer, rowOffsets, offset) {
    for (let i = rowOffsets.length - 1; i >= 0; i -= 1) {
      const row = rowOffsets[i];
      if (offset >= row.startOffset) {
        const line = buffer.getLine(row.rowIndex);
        if (!line) return null;
        const col = stringIndexToColumn(line, offset - row.startOffset);
        return { rowIndex: row.rowIndex, col };
      }
    }
    return null;
  }

  // provideLinks(bufferLineNumber, callback) の中身。bufferLineNumber は xterm.js の
  // ILinkProvider の仕様上 1-based（@xterm/xterm 本体の OscLinkProvider も
  // buffer.lines.get(y - 1) としており、同じ規約に揃えている）。
  //
  // handlers:
  //   - activate(event, url): リンクが（xterm.js 側の判定で）クリックされたときに呼ばれる。
  //     修飾キー判定・実際に開く処理は呼び出し側（renderer/app.js）の責務にする
  //     （この関数は「どこが URL か」だけに専念する）。
  //   - hover(event, url) / leave(event, url): ホバー時・ホバー解除時のツールチップ制御。
  function computeLinksForLine(terminal, bufferLineNumber, handlers) {
    const buffer = terminal.buffer.active;
    const lineIndex0 = bufferLineNumber - 1;
    const rows = getWrappedLineWindow(buffer, lineIndex0);
    if (!rows || rows.length === 0) return [];

    let merged = '';
    const rowOffsets = [];
    for (const row of rows) {
      rowOffsets.push({ rowIndex: row.index, startOffset: merged.length });
      merged += row.text;
    }

    const matches = extractUrlMatches(merged);
    if (matches.length === 0) return [];

    const links = [];
    for (const m of matches) {
      const startPos = mergedOffsetToBufferPosition(buffer, rowOffsets, m.start);
      const endPos = mergedOffsetToBufferPosition(buffer, rowOffsets, m.end);
      if (!startPos || !endPos) continue;

      // IBufferRange は 1-based・右側含む規約（@xterm/addon-web-links の WebLinkProvider
      // 内のコメントと同じ）。start は 0-based → 1-based の変換で +1 するが、end.x は
      // 0-based の exclusive 境界がそのまま 1-based の inclusive 境界と数値上一致するため
      // +1 しない。
      //
      // 注記（安藤レビュー・偶然の一致に関する記録）: URL がバッファ行のちょうど末尾で
      // 終わる場合、endPos.col（stringIndexToColumn）が 0 を返し、end.x が 1-based の
      // 規約上あり得ない 0 になることがある。これはバグではない。xterm.js 側の
      // Linkifier._linkAtPosition は range を y*cols+x の線形インデックスに変換して
      // 比較するだけで、x の値が [1..cols] の範囲内かは検証しない。(y, x=0) と
      // (y-1, x=cols) は同じ線形インデックスになるため結果的に正しい範囲として扱われる
      // （xterm.js 本体の実装詳細に依存した挙動であり、xterm 側でこの比較方法が変わると
      // 崩れうる。ただし現状は正しく動作しており、修正の必要は無い）。
      links.push({
        range: {
          start: { x: startPos.col + 1, y: startPos.rowIndex + 1 },
          end: { x: endPos.col, y: endPos.rowIndex + 1 },
        },
        text: m.url,
        activate: (event) => handlers.activate(event, m.url),
        hover: (event) => { if (handlers.hover) handlers.hover(event, m.url); },
        leave: (event) => { if (handlers.leave) handlers.leave(event, m.url); },
      });
    }
    return links;
  }

  // xterm.js の Terminal.registerLinkProvider() にそのまま渡せる ILinkProvider を作る。
  function createTerminalLinkProvider(terminal, handlers) {
    return {
      provideLinks(bufferLineNumber, callback) {
        let links;
        try {
          links = computeLinksForLine(terminal, bufferLineNumber, handlers);
        } catch (e) {
          // バッファアクセスで想定外の例外が起きても、リンク機能が無いだけの状態に
          // フォールバックする（ターミナル表示そのものを壊さない）。
          console.error('[vk-terminals] URL リンクの計算に失敗しました', e);
          links = [];
        }
        callback(links.length ? links : undefined);
      },
    };
  }

  return {
    createTerminalLinkProvider,
    // 以下はテスト用に公開する内部ヘルパー。
    getWrappedLineWindow,
    stringIndexToColumn,
    mergedOffsetToBufferPosition,
  };
});
