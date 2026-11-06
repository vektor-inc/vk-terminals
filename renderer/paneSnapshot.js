(function (root) {
  'use strict';
  // スクロール履歴ではなく、現在の画面とセル属性を同時に採取する。
  function capturePaneScreen(term) {
    const buffer = term.buffer.active;
    return {
      bracketedPaste: term.modes.bracketedPasteMode === true,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      lines: Array.from({ length: term.rows }, (_, y) => {
        const line = buffer.getLine(buffer.baseY + y);
        return { text: line.translateToString(true), wrapped: line.isWrapped,
          cells: Array.from({ length: term.cols }, (_, x) => {
            const cell = line.getCell(x);
            return { chars: cell.getChars(), dim: !!cell.isDim(), fg: cell.getFgColor(), fgMode: cell.getFgColorMode() };
          }) };
      }),
    };
  }
  if (typeof module !== 'undefined') module.exports = { capturePaneScreen };
  else root.VKPaneSnapshot = { capturePaneScreen };
})(typeof window !== 'undefined' ? window : globalThis);
