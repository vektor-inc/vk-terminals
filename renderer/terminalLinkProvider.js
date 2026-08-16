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

  const { extractUrlMatches, scanTableBorders } = (typeof require === 'function')
    ? require('./urlLinkify')
    : self.VKUrlLinkify;

  // 折り返し行の連結・逆方向探索を打ち切る上限文字数。@xterm/addon-web-links の
  // LinkComputer と同じ値（2048）に揃えている。1 行が異常に長い・折り返し回数が
  // 異常に多いログで連結処理が際限なく伸びるのを防ぐための安全弁で、実務上の
  // URL 長（isSafeHttpUrl の上限も 2048）を大きく下回ることはない。
  const MAX_WINDOW_CHARS = 2048;

  // バッファ行が「ペイン幅いっぱいまで書き込まれている」（＝行末に未書き込みセルが無い）
  // かどうかを判定する（issue #368・案D）。
  //
  // なぜ必要か: #365 までの getWrappedLineWindow は isWrapped（xterm 自身がソフトラップと
  // 判定した行）だけを連結していた。しかし #368 の再現は「ペインを描画しているプログラム
  // 自身が、たまたまペイン幅ちょうどの位置で実改行（\r\n）を出している」ケースで、この
  // 場合 isWrapped は（xterm 側から見て正しく）false のまま止まる。1行目がペイン幅
  // いっぱいまで埋まっているのに isWrapped が false というのは「URL が続いていそうな
  // 見た目」の強いシグナルなので、この条件を満たす行に限って isWrapped が false でも
  // 連結候補に含める（実測に基づく判断。詳細は司への調査報告・issue #368 コメント参照）。
  //
  // 判定方法: 行の最終セル（列 line.length - 1）を見る。
  //   - 未書き込みのデフォルトセル: getChars() === '' かつ getWidth() === 1（xterm.js が
  //     何も書いていない列に割り当てるデフォルト値）。→ 「いっぱいではない」。
  //   - ワイド文字（全角）がちょうど行末に来た場合、その文字自身の「幅 0 の穴埋めセル」が
  //     最終セルになることがある。これは書き込み済みセルの一部であり、未書き込みとは
  //     区別する（getWidth() === 0 のセルは常に直前のワイド文字の一部であり、単独では
  //     現れない。stringIndexToColumn のコメントも参照）。→ 「いっぱい」として扱う。
  //   - それ以外（実際に文字が書き込まれているセル）→ 「いっぱい」。
  //
  // 【既知の限界・修正不要】この判定はバッファの列幅（line.length）を現在のペイン幅と
  // みなしている。ペインをリサイズすると、過去に書き込まれた行の列幅と現在のペイン幅が
  // 一致しなくなる余地がある（xterm.js のリサイズ時の再フロー処理に依存する）。案A/C/D
  // いずれの方式でも避けられない共通の限界のため、今回は対応しない（司・植草合意）。
  function isRowFullWidth(line) {
    if (!line || !line.length) return false;
    const lastCell = line.getCell(line.length - 1);
    if (!lastCell) return false;
    if (lastCell.getWidth() === 0) return true; // ワイド文字の穴埋めセル→書き込み済み扱い
    return lastCell.getChars() !== '';
  }

  // isRowFullWidth に加えて、「罫線テーブルの行らしい行（縦線が2つ以上ある）」を強制連結の
  // 起点から除外する（issue #368・案D）。
  //
  // なぜ必要か: 罫線テーブルの各行はセル幅ちょうどまで描画され、かつ isWrapped は
  // 常に false（#365 のコメント参照）。テーブルがペイン幅ぴったりに描画されていると
  // isRowFullWidth() だけでは「実改行で割れた URL」と区別できず、無関係な独立行同士を
  // 連結してしまう（#365 の抑止方針である isTruncatedAtTableCellBorder は連結後の文字列
  // に対しても安全に働くため実害は無いが、罫線テーブルの行を案D の対象にする理由が
  // そもそも無い＝本来連結すべきでない）。テーブルらしさの判定は文字列だけで完結する
  // scanTableBorders（urlLinkify.js の純粋関数）をそのまま再利用し、判定基準
  // （縦線2つ以上）も isTruncatedAtTableCellBorder と揃える。
  //
  // 【既知の挙動・修正不要（安藤レビュー・LOW）】scanTableBorders は縦線（│┃║）だけを
  // 数えるため、"├──────┼───────────┤" のような横罫線・接続文字だけの区切り行は
  // count が 0 になり、この関数の除外対象に入らない（＝強制連結の起点になり得る）。
  // 罫線文字は urlLinkify.js の URL_CANDIDATE_REGEX の文字集合に含まれないため、この
  // 区切り行を挟んで URL 候補が連結される・誤ってリンク化されることは無い（起きるのは
  // 「連結ウィンドウが本来より少し広がる」だけで、isTruncatedAtTableCellBorder は連結後の
  // 文字列に対しても安全に働くよう設計されている。urlLinkify.js の isTruncatedAtTableCellBorder
  // コメント参照）。「罫線テーブルの行を案D の対象にする理由がそもそも無い」という上記の
  // 意図とは厳密には食い違うが、実害が無く、横罫線・接続文字まで判定に含めると
  // scanTableBorders の判定基準（#365 の isTruncatedAtTableCellBorder と共有）がこの関数
  // 専用に分岐してしまうため、あえて直さずここに記録するだけに留める（司・安藤合意）。
  function isForcedMergeSource(line, text) {
    if (!isRowFullWidth(line)) return false;
    return scanTableBorders(text).count < 2;
  }

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

    // 連結後の文字数は上下方向で通算する（安藤レビュー・LOW）。上下を別々に数えると
    // 実質 2 × MAX_WINDOW_CHARS まで伸びてしまう。#365 まではこの上限に事実上到達し
    // づらかった（isWrapped の連鎖でしか発動しない＝実際のソフトラップの範囲に自然と
    // 収まる）が、案D 以降は「全幅行が並んでいるだけ」でも発動するため、通算にしておく。
    let total = rows[0].text.length;

    // 上方向へ拡張: 「前の行からこの行への連結」が成り立つ間、前の行を辿る。
    // 連結が成り立つ条件（issue #368・案D で拡張。isForcedMergeSource のコメント参照）:
    //   - このバッファ行自体が xterm の判定で「前の行からの折り返し」（isWrapped）である
    //     （#349 からの既存条件。挙動は変えない）。
    //   - または、前の行がペイン幅いっぱいまで埋まっている（isForcedMergeSource）。
    //     xterm 側の isWrapped が false でも、実改行の直前がペイン幅ちょうどなら URL が
    //     続いていそうな強いシグナルとみなす。
    // 起点となるバッファ行自身の isWrapped だけで一度きり判定していた #365 までと異なり、
    // 案D では連結が続く限り毎回判定し直す（「継続行そのものを起点にしても前方の行まで
    // 遡って連結する」という既存要件・#349 植草レビューを、強制連結の場合にも保つため）。
    //
    // rows の各要素には、xterm の isWrapped ではなく isForcedMergeSource（案D）で連結した
    // 行にだけ forcedMerge: true を付ける。computeLinksForLine 側がこれをそのまま
    // hardWrapBoundaries の算出に使うため、buffer.getLine() を引き直す必要が無い
    // （安藤レビュー・LOW。以前は「rows の形を変えると deepEqual を使う既存テストが
    // 壊れる」という理由で引き直していたが、テストが実装の API 形状を縛るのは本末転倒
    // という指摘を受けて見直した。既存テストは rows.map(r => r.index) 等の形へ更新済み）。
    //
    // forcedMerge を付ける行に注意（重要）: 「row.forcedMerge === true は、rows 配列上で
    // この行の直前にある境界が強制連結（案D）であることを表す」という規約に統一する
    // （下方向の push と揃える）。上方向は「新しく見つけた prevLine」を配列の先頭に
    // unshift するため、境界があるのは prevLine の直後＝現在の rows[0] の直前。
    // つまり forcedMerge は「これから unshift する新しい行」ではなく「今まさに rows[0]
    // である行」に付ける（unshift の前に判定する）。ここを取り違えると、この行から
    // 開始したクエリ（xterm が下側の行をホバーしたとき等）では forcedMerge が
    // computeLinksForLine から見えず、hardWrapBoundaries に載らないまま
    // isHostConfirmedBeforeBoundary の検証が素通りしてしまう（ホストすり替わり対策が
    // 無効化される。実 xterm での end-to-end 確認で検出・修正）。
    {
      let idx = lineIndex0;
      for (;;) {
        if (total >= MAX_WINDOW_CHARS) break;
        const prevLine = buffer.getLine(idx - 1);
        if (!prevLine) break;
        const currentLine = buffer.getLine(idx); // これまでに含めた最も手前の行
        const prevText = prevLine.translateToString(false);
        const genuineWrap = !!(currentLine && currentLine.isWrapped);
        const canMerge = genuineWrap || isForcedMergeSource(prevLine, prevText);
        if (!canMerge) break;
        if (!genuineWrap) rows[0].forcedMerge = true;
        rows.unshift({ index: idx - 1, text: prevText });
        total += prevText.length;
        idx -= 1;
        // 空白を含む行まで辿り着いたら、それより前に URL の続きは無いとみなして打ち切る
        // （URL は空白を含まないため）。それ以外の続行可否は次の周回の canMerge 判定に
        // 委ねる（前の行自身の isWrapped / isForcedMergeSource で決まる）。
        if (/\s/.test(prevText)) break;
      }
    }

    // 下方向へ拡張: 「この行から次の行への連結」が成り立つ間、連結する。
    // 条件は上方向と対称（次の行の isWrapped、または現在の行の isForcedMergeSource）。
    {
      let idx = lineIndex0;
      for (;;) {
        if (total >= MAX_WINDOW_CHARS) break;
        const nextLine = buffer.getLine(idx + 1);
        if (!nextLine) break;
        const currentLine = buffer.getLine(idx);
        const currentText = rows[rows.length - 1].text;
        const canMerge = nextLine.isWrapped || isForcedMergeSource(currentLine, currentText);
        if (!canMerge) break;
        const nextText = nextLine.translateToString(false);
        const newRow = { index: idx + 1, text: nextText };
        if (!nextLine.isWrapped) newRow.forcedMerge = true;
        rows.push(newRow);
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
    // hardWrapBoundaries: rows 内で「案D の強制連結（isForcedMergeSource）によって
    // 連結された境界」の merged 内オフセットを集める。getWrappedLineWindow が付ける
    // row.forcedMerge をそのまま使う。
    const hardWrapBoundaries = [];
    for (const row of rows) {
      const startOffset = merged.length;
      if (startOffset > 0 && row.forcedMerge) {
        hardWrapBoundaries.push(startOffset);
      }
      rowOffsets.push({ rowIndex: row.index, startOffset });
      merged += row.text;
    }

    const matches = extractUrlMatches(merged, hardWrapBoundaries);
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
