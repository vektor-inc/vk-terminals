'use strict';

// main プロセス側（main.js）の POST /api/set-title 専用のパーサ（issue #536）。
// paneNote は、ペインの入力待ち・実行中とは別に「見守り中」「完了」を出すための任意項目。
// renderer 側（app.js）は CommonJS の require が使えないため、この module は
// main プロセス以外からは読み込まない（renderer 側の解決は renderer/statusPresentation.js）。

const PANE_NOTES = Object.freeze(['watching', 'done']);

// リクエストボディから paneNote の更新指示を取り出す。
//   - 項目が無い、または 'watching' / 'done' / null 以外（型違いを含む）→ { provided: false }（現在値を変えない）
//   - 'watching' / 'done' → { provided: true, value: その値 }
//   - null → { provided: true, value: null }（明示的に消す）
//
// @param {*} parsed - JSON.parse 済みのリクエストボディ（型は不定）。
// @returns {{ provided: boolean, value: ('watching'|'done'|null) }}
function parsePaneNoteUpdate(parsed) {
  if (!parsed || typeof parsed !== 'object' || !Object.prototype.hasOwnProperty.call(parsed, 'paneNote')) {
    return { provided: false, value: null };
  }
  const raw = parsed.paneNote;
  if (raw === null) return { provided: true, value: null };
  if (typeof raw === 'string' && PANE_NOTES.includes(raw)) return { provided: true, value: raw };
  return { provided: false, value: null };
}

module.exports = { PANE_NOTES, parsePaneNoteUpdate };
