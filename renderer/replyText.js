// ─── Reply text detection ────────────────────────────────────────────────
// Node（require）とブラウザ（<script>）の両方から使える UMD 形式。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKReplyText = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

const REPLY_MARKER = '[ユーザー返信用]';
const BOX_DRAWING_LINE_PATTERN = /^[\s─-╿]+$/;
const HORIZONTAL_LINE_PATTERN = /[─━═╌╍┄┅┈┉]+/g;
const EDGE_BOX_DRAWING_PATTERN = /^[\s│┃┆┇┊┋┌┐└┘├┤┬┴┼╭╮╰╯]+|[\s│┃┆┇┊┋┌┐└┘├┤┬┴┼╭╮╰╯]+$/g;
const INVISIBLE_CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
const URL_LINE_PATTERN = /^https?:\/\/\S+$/;
const INK_RIGHT_MARGIN_CELLS = 3;

function leadingWidth(text) {
  return (String(text).match(/^\s*/) || [''])[0].length;
}

function cleanLine(text) {
  return String(text)
    .replace(HORIZONTAL_LINE_PATTERN, ' ')
    .replace(EDGE_BOX_DRAWING_PATTERN, '')
    .trim();
}

function stripInvisibleControlCharacters(text) {
  return String(text).replace(INVISIBLE_CONTROL_PATTERN, '');
}

// Ink の物理行分割を、端末上のセル幅に合わせて判定する。
function isFullWidth(character) {
  const codePoint = character.codePointAt(0);
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function displayWidth(text) {
  return Array.from(String(text)).reduce((width, character) => width + (isFullWidth(character) ? 2 : 1), 0);
}

function firstChunk(text) {
  const content = String(text).trimStart();
  if (!content) return '';
  const firstCharacter = Array.from(content)[0];
  if (isFullWidth(firstCharacter)) return firstCharacter;
  return (content.match(/^\S+/) || [''])[0];
}

function isInkWrapped(previousText, nextText, cols) {
  if (!Number.isFinite(cols) || cols <= 0) return false;
  // 空行で段落が分かれている場合は、前後の行を折り返しとして連結しない。
  if (!String(previousText).trim() || !String(nextText).trim() || BOX_DRAWING_LINE_PATTERN.test(nextText)) return false;
  const chunk = firstChunk(nextText);
  if (!chunk) return false;
  const usableWidth = Math.max(1, cols - INK_RIGHT_MARGIN_CELLS);
  return displayWidth(previousText) + displayWidth(chunk) > usableWidth;
}

function inkJoinSeparator(previousText, nextText) {
  const previousCharacter = Array.from(previousText.trimEnd()).pop() || '';
  const nextCharacter = Array.from(nextText.trimStart())[0] || '';
  return /[A-Za-z0-9-]/.test(previousCharacter) && /[A-Za-z0-9-]/.test(nextCharacter) ? ' ' : '';
}

// xterm の折り返し行だけを改行なしで連結し、物理行の先頭インデントを保持する。
function readRecentBufferLines(buffer, maxLines) {
  if (!buffer || typeof buffer.length !== 'number' || typeof buffer.getLine !== 'function') return null;
  if (!Number.isFinite(maxLines) || maxLines <= 0 || !Number.isFinite(buffer.length)) return null;
  const lines = [];
  for (let i = Math.max(0, buffer.length - maxLines); i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line || typeof line.translateToString !== 'function') continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) {
      lines[lines.length - 1].text += text;
    } else {
      lines.push({ text, indent: leadingWidth(text) });
    }
  }
  return lines.length ? lines : null;
}

function isTerminator(text, markerIndent) {
  if (!text.trim()) return false;
  if (BOX_DRAWING_LINE_PATTERN.test(text)) return true;
  if (URL_LINE_PATTERN.test(text.trim())) return true;
  return leadingWidth(text) < markerIndent;
}

// 最新の marker から、後続の終端行が確定できる返信文だけを返す。
function extractLatestReplyText(lines, cols) {
  if (!Array.isArray(lines)) return null;
  for (let markerIndex = lines.length - 1; markerIndex >= 0; markerIndex--) {
    const markerText = typeof lines[markerIndex] === 'string' ? lines[markerIndex] : lines[markerIndex]?.text;
    if (typeof markerText !== 'string' || !markerText.includes(REPLY_MARKER)) continue;

    const markerIndent = leadingWidth(markerText);
    const captured = [{ text: markerText, indent: markerIndent, physicalText: markerText }];
    let terminated = false;
    for (let i = markerIndex + 1; i < lines.length; i++) {
      const text = typeof lines[i] === 'string' ? lines[i] : lines[i]?.text;
      if (typeof text !== 'string') continue;
      if (isTerminator(text, markerIndent)) {
        terminated = true;
        break;
      }
      const previous = captured[captured.length - 1];
      // marker と終端行を除く本文だけを対象にし、直前の物理行幅で Ink の折り返しを判定する。
      if (captured.length > 1 && isInkWrapped(previous.physicalText, text, cols)) {
        previous.text = previous.text.trimEnd() + inkJoinSeparator(previous.text, text) + text.trimStart();
        previous.physicalText = text;
      } else {
        captured.push({ text, indent: leadingWidth(text), physicalText: text });
      }
    }
    if (!terminated) return null;

    // 返信文中の空行は保持し、終端直前に残った空行だけを取り除く。
    while (captured.length > 1 && !captured[captured.length - 1].text.trim()) {
      captured.pop();
    }
    if (captured.length < 2) return null;

    // 空行の indent 0 に引っ張られず、返信文全体の字下げを取り除く。
    const commonIndent = Math.min(...captured.filter(line => line.text.trim()).map(line => line.indent));
    const result = captured
      .map(line => cleanLine(line.text.slice(commonIndent)))
      .join('\n')
      .trimEnd();
    if (result.includes('\n')) return stripInvisibleControlCharacters(result);
  }
  return null;
}

function detectReplyText(buffer, maxLines, cols) {
  const lines = readRecentBufferLines(buffer, maxLines);
  return lines ? extractLatestReplyText(lines, cols) : null;
}

// 端末が自動で返す ESC 応答と移動キーは除外し、本文・改行・貼り付けを入力とみなす。
function containsReplyDismissInput(data) {
  if (typeof data !== 'string' || !data) return false;
  if (data.startsWith('\x1b')) return data.startsWith('\x1b[200~') && data.includes('\x1b[201~');
  return /[\r\n\x20-\x7e\u0080-\uffff]/.test(data);
}

// 入力文字（event.key）だけでなく物理キー（event.code）でも判定し、配列や Option の差を吸収する。
function isReplyCopyShortcut(event) {
  return (event?.code === 'KeyC' || event?.key?.toLowerCase() === 'c')
    && event.altKey === true
    && event.shiftKey === true
    && event.ctrlKey !== true
    && event.metaKey !== true;
}

return {
  REPLY_MARKER,
  containsReplyDismissInput,
  detectReplyText,
  extractLatestReplyText,
  isReplyCopyShortcut,
  readRecentBufferLines,
  stripInvisibleControlCharacters,
};
});
