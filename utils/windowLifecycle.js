'use strict';

// ウィンドウを閉じても作業ペインを動かし続け、作り直したウィンドウへつなぎ直すための判断（issue #649）。
// main.js は Electron に依存して単体テストできないため、判断だけをここへ切り出している。

const TEXT_LIMIT = 4096;
const TEXT_KEYS = ['taskTitle', 'apiTitle', 'apiUrl', 'apiPrUrl', 'apiPaneNote'];
const BOOLEAN_KEYS = ['apiPrMerged', 'apiWaitingMerge', 'externalWaiting'];

/**
 * ⌘ + W（ウィンドウを閉じるショートカット）の押下かを判定する。
 * macOS 以外の Ctrl + W は、ターミナルの「直前の単語を消す」入力と重なるため対象にしない。
 *
 * @param {object} input Electron の before-input-event が渡す入力（type・key・meta・control・alt・shift）
 * @param {string} [platform] process.platform と同じ形式の OS 名
 * @returns {boolean} ⌘ + W の keyDown なら true
 */
function isCloseShortcut(input, platform = process.platform) {
  if (platform !== 'darwin' || !input || input.type !== 'keyDown') return false;
  if (typeof input.key !== 'string' || input.key.toLowerCase() !== 'w') return false;
  return input.meta === true && !input.control && !input.alt && !input.shift;
}

/**
 * 画面が保存した並び（terminal:save-layout）と、main で生きているペインから、
 * 作り直したウィンドウへ戻すペインの一覧と並びを組み立てる。
 * 記録に無い生存ペインは既定名で末尾へ足し、終了したペインの記録は捨てる。
 *
 * @param {object} params
 * @param {string[]} params.liveIds main で生きているペインの番号（termId）
 * @param {object|null} params.layout 画面が最後に保存した並び（{ order, stashOrder, focusedPaneId, panes }）
 * @param {string} params.defaultCwd 記録に作業フォルダが無いときに使うフォルダ
 * @returns {{ panes: object[], order: string[], stashOrder: string[], focusedPaneId: string|null }}
 */
function planLivePaneReattach({ liveIds, layout, defaultCwd }) {
  const live = new Set((Array.isArray(liveIds) ? liveIds : []).map(String).filter(id => /^\d+$/.test(id)));
  const savedPanes = Array.isArray(layout?.panes) ? layout.panes : [];
  const panes = [];
  const usedTermIds = new Set();
  const usedPaneIds = new Set();

  // 記録にある生存ペインは、画面の名前・エンジン・PR ボタンの状態ごと戻す。
  for (const saved of savedPanes) {
    if (!saved || typeof saved !== 'object') continue;
    const id = String(saved.termId);
    if (!live.has(id) || usedTermIds.has(id)) continue;
    if (typeof saved.paneId !== 'string' || !/^pane-\d+$/.test(saved.paneId) || usedPaneIds.has(saved.paneId)) continue;
    usedTermIds.add(id);
    usedPaneIds.add(saved.paneId);
    panes.push(normalizePane(saved, id, saved.paneId, defaultCwd));
  }

  // 記録より後に増えたペインは、重ならない名前を付けて末尾へ戻す。
  let nextPaneNumber = Math.max(0, ...[...usedPaneIds].map(paneId => Number(paneId.slice(5)))) + 1;
  for (const id of live) {
    if (usedTermIds.has(id)) continue;
    let paneId = `pane-${id}`;
    while (usedPaneIds.has(paneId)) paneId = `pane-${nextPaneNumber++}`;
    usedTermIds.add(id);
    usedPaneIds.add(paneId);
    panes.push(normalizePane({}, id, paneId, defaultCwd));
  }

  const selectOrder = values => (Array.isArray(values) ? values : []).filter((paneId, index, list) =>
    usedPaneIds.has(paneId) && list.indexOf(paneId) === index);
  const stashOrder = selectOrder(layout?.stashOrder);
  const order = selectOrder(layout?.order).filter(paneId => !stashOrder.includes(paneId));
  // 並びの記録に無いペインは、画面に見えるよう末尾へ置く。
  for (const pane of panes) {
    if (!order.includes(pane.paneId) && !stashOrder.includes(pane.paneId)) order.push(pane.paneId);
  }
  const focusedPaneId = usedPaneIds.has(layout?.focusedPaneId) ? layout.focusedPaneId : null;
  return { panes, order, stashOrder, focusedPaneId };
}

function normalizePane(saved, id, paneId, defaultCwd) {
  const pane = {
    id, paneId,
    cwd: typeof saved.cwd === 'string' && saved.cwd ? saved.cwd.slice(0, TEXT_LIMIT) : defaultCwd,
    engine: saved.engine === 'codex' ? 'codex' : 'claude',
  };
  for (const key of TEXT_KEYS) if (typeof saved[key] === 'string') pane[key] = saved[key].slice(0, TEXT_LIMIT);
  for (const key of BOOLEAN_KEYS) if (typeof saved[key] === 'boolean') pane[key] = saved[key];
  // 閉じる保護（POST /api/set-lock）は画面と同じ形にそろえる。
  if (Object.hasOwn(saved, 'lock')) pane.lock = saved.lock && typeof saved.lock.close === 'boolean' ? { close: saved.lock.close } : null;
  return pane;
}

/**
 * ウィンドウが無い間に届いた POST /api/set-title を、画面の並びの記録へ反映した新しい記録を返す。
 * 画面（renderer/app.js の terminal:title）と同じく、型の合わない項目は今の値を保つ。
 *
 * @param {object|null} layout 画面が最後に保存した並び
 * @param {string} termId 対象のペイン番号
 * @param {object} update { title, url, prUrl, prMerged, waitingMerge, paneNoteUpdate }
 * @param {Function} resolvePaneNote renderer/statusPresentation.js の resolvePaneNote
 * @returns {object|null} 反映後の記録（対象のペインが無ければ元の記録）
 */
function applyTitleUpdateToLayout(layout, termId, update, resolvePaneNote) {
  return updateLayoutPane(layout, termId, pane => {
    const title = typeof update.title === 'string' ? update.title : '';
    const next = { ...pane, apiPaneNote: resolvePaneNote(pane.apiPaneNote, update.paneNoteUpdate, pane.apiTitle, title), apiTitle: title };
    if (typeof update.url === 'string') next.apiUrl = update.url;
    if (typeof update.prUrl === 'string') next.apiPrUrl = update.prUrl;
    if (typeof update.prMerged === 'boolean') next.apiPrMerged = update.prMerged;
    if (typeof update.waitingMerge === 'boolean') next.apiWaitingMerge = update.waitingMerge;
    return next;
  });
}

/**
 * ウィンドウが無い間に AI エンジンを入れ替えたペインの記録を、新しいエンジンに書き換えた記録を返す。
 *
 * @param {object|null} layout 画面が最後に保存した並び
 * @param {string} termId 対象のペイン番号
 * @param {string} engine 入れ替えたエンジン名
 * @returns {object|null} 反映後の記録
 */
function applyEngineChangeToLayout(layout, termId, engine) {
  return updateLayoutPane(layout, termId, pane => ({ ...pane, engine }));
}

/**
 * ウィンドウが無い間に届いたペインの状態（閉じる保護・外部からの入力待ち）を、並びの記録へ反映した記録を返す。
 *
 * @param {object|null} layout 画面が最後に保存した並び
 * @param {string} termId 対象のペイン番号
 * @param {object} patch 上書きする項目（{ lock } や { externalWaiting }）
 * @returns {object|null} 反映後の記録
 */
function applyPaneStateToLayout(layout, termId, patch) {
  return updateLayoutPane(layout, termId, pane => ({ ...pane, ...patch }));
}

function updateLayoutPane(layout, termId, change) {
  if (!layout || !Array.isArray(layout.panes)) return layout;
  const id = String(termId);
  if (!layout.panes.some(pane => pane && String(pane.termId) === id)) return layout;
  return { ...layout, panes: layout.panes.map(pane => (pane && String(pane.termId) === id ? change(pane) : pane)) };
}

/**
 * 保持役を使わない（node-pty 直結の）ペインの出力を、ペインごとに上限つきで覚えておく。
 * ウィンドウを作り直したときは、覚えた出力を新しい画面へ流して表示を戻す。
 * 画面へ流し終えるまでは hold で新しい出力を画面へ送らせず、順番の入れ替わりを防ぐ。
 *
 * @param {object} [options]
 * @param {number} [options.maxChars] 1 ペインあたりに覚える文字数の上限
 * @returns {object} append / read / hold / isHeld / release / delete を持つ
 */
function createOutputReplayBuffer({ maxChars = 1_000_000 } = {}) {
  const buffers = new Map();
  const held = new Set();

  function append(id, data) {
    if (typeof data !== 'string' || !data) return;
    let entry = buffers.get(id);
    if (!entry) { entry = { chunks: [], length: 0 }; buffers.set(id, entry); }
    entry.chunks.push(data);
    entry.length += data.length;
    if (entry.length <= maxChars) return;
    // 古い出力から捨てる。途中で切った先頭は、制御文字の途中から始まらないよう次の改行まで落とす。
    while (entry.chunks.length > 1 && entry.length - entry.chunks[0].length >= maxChars) {
      entry.length -= entry.chunks.shift().length;
    }
    const excess = entry.length - maxChars;
    if (excess > 0) {
      let head = entry.chunks[0].slice(excess);
      const newline = head.indexOf('\n');
      if (newline >= 0) head = head.slice(newline + 1);
      entry.length += head.length - entry.chunks[0].length;
      entry.chunks[0] = head;
    }
  }

  return {
    append,
    read: id => (buffers.get(id)?.chunks.join('') ?? ''),
    hold: id => { held.add(id); },
    isHeld: id => held.has(id),
    release: id => { held.delete(id); },
    delete: id => { buffers.delete(id); held.delete(id); },
  };
}

module.exports = {
  isCloseShortcut,
  planLivePaneReattach,
  applyTitleUpdateToLayout,
  applyEngineChangeToLayout,
  applyPaneStateToLayout,
  createOutputReplayBuffer,
};
