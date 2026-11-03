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
const INK_RIGHT_MARGIN_CELLS = 3;

function leadingWidth(text) {
  return (String(text).match(/^\s*/) || [''])[0].length;
}

function cleanLine(text) {
  return String(text).replace(/\s*[─-╿]+\s*/g, ' ').trim();
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
  if (!String(nextText).trim() || BOX_DRAWING_LINE_PATTERN.test(nextText)) return false;
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

// xterm と Ink の折り返し行を改行なしで連結し、物理行の先頭インデントを保持する。
function readRecentBufferLines(buffer, maxLines, cols) {
  if (!buffer || typeof buffer.length !== 'number' || typeof buffer.getLine !== 'function') return null;
  if (!Number.isFinite(maxLines) || maxLines <= 0 || !Number.isFinite(buffer.length)) return null;
  const lines = [];
  for (let i = Math.max(0, buffer.length - maxLines); i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line || typeof line.translateToString !== 'function') continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) {
      lines[lines.length - 1].text += text;
    } else if (lines.length && isInkWrapped(lines[lines.length - 1].text, text, cols)) {
      const previous = lines[lines.length - 1];
      previous.text = previous.text.trimEnd() + inkJoinSeparator(previous.text, text) + text.trimStart();
    } else {
      lines.push({ text, indent: leadingWidth(text) });
    }
  }
  return lines.length ? lines : null;
}

function isTerminator(text, markerIndent) {
  if (!text.trim()) return true;
  if (BOX_DRAWING_LINE_PATTERN.test(text)) return true;
  return leadingWidth(text) < markerIndent;
}

// 最新の marker から、後続の終端行が確定できる返信文だけを返す。
function extractLatestReplyText(lines) {
  if (!Array.isArray(lines)) return null;
  for (let markerIndex = lines.length - 1; markerIndex >= 0; markerIndex--) {
    const markerText = typeof lines[markerIndex] === 'string' ? lines[markerIndex] : lines[markerIndex]?.text;
    if (typeof markerText !== 'string' || !markerText.includes(REPLY_MARKER)) continue;

    const markerIndent = leadingWidth(markerText);
    const captured = [{ text: markerText, indent: markerIndent }];
    let terminated = false;
    for (let i = markerIndex + 1; i < lines.length; i++) {
      const text = typeof lines[i] === 'string' ? lines[i] : lines[i]?.text;
      if (typeof text !== 'string') continue;
      if (isTerminator(text, markerIndent)) {
        terminated = true;
        break;
      }
      captured.push({ text, indent: leadingWidth(text) });
    }
    if (!terminated || captured.length < 2) continue;

    const commonIndent = Math.min(...captured.map(line => line.indent));
    const result = captured
      .map(line => cleanLine(line.text.slice(commonIndent)))
      .join('\n')
      .trimEnd();
    if (result.includes('\n')) return result;
  }
  return null;
}

function detectReplyText(buffer, maxLines, cols) {
  const lines = readRecentBufferLines(buffer, maxLines, cols);
  return lines ? extractLatestReplyText(lines) : null;
}

// 端末が自動で返す ESC 応答と移動キーは除外し、本文・改行・貼り付けを入力とみなす。
function containsReplyDismissInput(data) {
  if (typeof data !== 'string' || !data) return false;
  if (data.startsWith('\x1b')) return data.startsWith('\x1b[200~') && data.includes('\x1b[201~');
  return /[\r\n\t\x20-\x7e\u0080-\uffff]/.test(data);
}

return {
  REPLY_MARKER,
  containsReplyDismissInput,
  detectReplyText,
  extractLatestReplyText,
  readRecentBufferLines,
};
});
