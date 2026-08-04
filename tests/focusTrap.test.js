'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createFocusTrapStack } = require('../renderer/focusTrap');

// focusTrap.js が実際に触れる範囲の DOM（body の子要素・inert・activeElement・focus()・
// contains・querySelectorAll・getClientRects）だけを再現する最小のスタブ。
// querySelectorAll はセレクタを解釈せず「停止位置の候補として作った子孫」を返す。
// そこから先の絞り込み（disabled / tabindex="-1" / 非表示 / inert）は本物の実装に判定させ、
// テストがセレクタの写経にならないようにする。
function createDocument() {
  const listeners = { capture: [], bubble: [] };
  const doc = {
    activeElement: null,
    body: null,
    addEventListener(type, listener, capture = false) {
      assert.equal(type, 'keydown');
      listeners[capture ? 'capture' : 'bubble'].push(listener);
    },
    removeEventListener(type, listener, capture = false) {
      assert.equal(type, 'keydown');
      const phase = listeners[capture ? 'capture' : 'bubble'];
      const index = phase.indexOf(listener);
      if (index !== -1) phase.splice(index, 1);
    },
    dispatchKey(key, options = {}) {
      const event = {
        key,
        shiftKey: options.shiftKey === true,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
      };
      for (const listener of [...listeners.capture, ...listeners.bubble]) listener(event);
      return event;
    },
    listeners,
  };

  doc.createElement = (options = {}) => ({
    name: options.name || '',
    children: [],
    // querySelectorAll が拾う「停止位置の候補」かどうか（本物の FOCUSABLE_SELECTOR 相当）。
    candidate: options.candidate === true,
    inert: options.inert === true,
    disabled: options.disabled === true,
    attributes: options.attributes || {},
    // 0 にすると hidden / display:none 相当（矩形を持たない）になる。
    rects: options.rects === undefined ? 1 : options.rects,
    focusCount: 0,
    getAttribute(attributeName) {
      return Object.prototype.hasOwnProperty.call(this.attributes, attributeName)
        ? this.attributes[attributeName]
        : null;
    },
    hasAttribute(attributeName) {
      return Object.prototype.hasOwnProperty.call(this.attributes, attributeName);
    },
    getClientRects() {
      return this.rects > 0 ? [{}] : [];
    },
    focus() {
      this.focusCount += 1;
      doc.activeElement = this;
    },
    append(...nodes) {
      this.children.push(...nodes);
      return this;
    },
    contains(node) {
      if (node === this) return true;
      return this.children.some((child) => child.contains(node));
    },
    querySelectorAll() {
      const found = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (child.candidate) found.push(child);
          walk(child);
        }
      };
      walk(this);
      return found;
    },
  });

  doc.body = doc.createElement({ name: 'body' });
  return doc;
}

// 背後の要素（タイトルバー・ペイン領域）と、ボタンを並べたモーダルを持つ画面を作る。
function createScreen(buttonNames = ['close', 'cancel', 'save']) {
  const doc = createDocument();
  const titlebar = doc.createElement({ name: 'titlebar' });
  const root = doc.createElement({ name: 'root' });
  const modal = doc.createElement({ name: 'modal' });
  const buttons = {};
  for (const buttonName of buttonNames) {
    const button = doc.createElement({ name: buttonName, candidate: true });
    buttons[buttonName] = button;
    modal.append(button);
  }
  doc.body.append(titlebar, root, modal);
  return { doc, titlebar, root, modal, buttons };
}

test('開いた時点で先頭の操作対象へフォーカスが入る', () => {
  const { doc, modal, buttons } = createScreen();
  const traps = createFocusTrapStack(doc);

  traps.activate(modal);

  assert.equal(doc.activeElement, buttons.close);
  assert.equal(buttons.close.focusCount, 1);
});

test('initialFocus を指定すると先頭ではなくそこへフォーカスが入る', () => {
  // 確認ダイアログが「キャンセル」を既定にするための経路。
  const { doc, modal, buttons } = createScreen(['cancel', 'closePane']);
  const traps = createFocusTrapStack(doc);

  traps.activate(modal, { initialFocus: buttons.closePane });

  assert.equal(doc.activeElement, buttons.closePane);
});

test('initialFocus が focus できない要素なら先頭の操作対象へ落とす', () => {
  const { doc, modal, buttons } = createScreen();
  buttons.save.disabled = true;
  const traps = createFocusTrapStack(doc);

  traps.activate(modal, { initialFocus: buttons.save });

  assert.equal(doc.activeElement, buttons.close);
});

test('initialFocus に tabindex="-1" の着地点を渡すとそこへ入る', () => {
  // 設定パネルは Tab の停止位置ではないパネル本体を着地点にする（マウスで開いたときに
  // リングが見えないまま閉じるボタンが選ばれるのを避けるため）。Tab で止まれるかどうかで
  // 判定すると、ここで弾かれて先頭のボタンへ落ちてしまう。
  const { doc, modal, buttons } = createScreen();
  modal.attributes.tabindex = '-1';
  const traps = createFocusTrapStack(doc);

  traps.activate(modal, { initialFocus: modal });

  assert.equal(doc.activeElement, modal);
  // 着地点自身は Tab の停止位置に混ざらない（最初の Tab は先頭のボタンへ進む）。
  doc.dispatchKey('Tab');
  assert.equal(doc.activeElement, buttons.close);
  // 着地点からの Shift+Tab は末尾へ入れる（ブラウザ既定の巻き戻り先に委ねない）。
  modal.focus();
  doc.dispatchKey('Tab', { shiftKey: true });
  assert.equal(doc.activeElement, buttons.save);
});

test('初期フォーカスで例外が出たら、トラップを巻き戻してから投げ直す', () => {
  // 解除関数を受け取れないまま抜けると、背後の inert を外す手段が無くなる。
  const { doc, titlebar, root, modal, buttons } = createScreen();
  const failure = new Error('focus failed');
  buttons.close.focus = () => { throw failure; };
  const traps = createFocusTrapStack(doc);

  assert.throws(() => traps.activate(modal), (error) => error === failure);

  assert.equal(titlebar.inert, false);
  assert.equal(root.inert, false);
  assert.equal(doc.listeners.capture.length, 0);
  // トラップも残っていない（次に開くモーダルが最前面として扱われる）。
  buttons.save.focus();
  const event = doc.dispatchKey('Tab');
  assert.equal(event.defaultPrevented, false);
});

test('末尾で Tab を押すと先頭へ、先頭で Shift+Tab を押すと末尾へ循環する', () => {
  const { doc, modal, buttons } = createScreen();
  const traps = createFocusTrapStack(doc);
  traps.activate(modal);

  buttons.save.focus();
  const forward = doc.dispatchKey('Tab');
  assert.equal(forward.defaultPrevented, true);
  assert.equal(doc.activeElement, buttons.close);

  const backward = doc.dispatchKey('Tab', { shiftKey: true });
  assert.equal(backward.defaultPrevented, true);
  assert.equal(doc.activeElement, buttons.save);
});

test('端以外の Tab はブラウザ既定の移動に任せる', () => {
  const { doc, modal, buttons } = createScreen();
  const traps = createFocusTrapStack(doc);
  traps.activate(modal);

  buttons.cancel.focus();
  const event = doc.dispatchKey('Tab');

  assert.equal(event.defaultPrevented, false);
  assert.equal(doc.activeElement, buttons.cancel);
});

test('フォーカスがモーダルの外にあっても、次の Tab で中へ引き戻す', () => {
  const { doc, modal, root, buttons } = createScreen();
  const traps = createFocusTrapStack(doc);
  traps.activate(modal);

  doc.activeElement = root;
  doc.dispatchKey('Tab');
  assert.equal(doc.activeElement, buttons.close);

  // Shift+Tab で外から戻すときは末尾へ入れる（進行方向と逆にならないように）。
  doc.activeElement = root;
  doc.dispatchKey('Tab', { shiftKey: true });
  assert.equal(doc.activeElement, buttons.save);
});

test('disabled・tabindex="-1"・非表示の要素は停止位置に数えない', () => {
  const { doc, modal, buttons } = createScreen(['close', 'tabInactive', 'hiddenSave', 'cancel']);
  const traps = createFocusTrapStack(doc);
  // 非アクティブなタブボタン（矢印キー移動のため tabindex="-1"）と、隠した保存ボタン。
  buttons.tabInactive.attributes.tabindex = '-1';
  buttons.hiddenSave.rects = 0;
  traps.activate(modal);

  // 先頭は close のまま。末尾は cancel（隠した保存ボタンではない）。
  assert.equal(doc.activeElement, buttons.close);
  buttons.cancel.focus();
  doc.dispatchKey('Tab');
  assert.equal(doc.activeElement, buttons.close);

  // Shift+Tab は tabindex="-1" と非表示を飛ばして cancel へ戻る。
  doc.dispatchKey('Tab', { shiftKey: true });
  assert.equal(doc.activeElement, buttons.cancel);
});

test('停止位置が 1 つも無いモーダルでも Tab で外へ出さない', () => {
  const { doc } = createScreen();
  const empty = doc.createElement({ name: 'emptyModal' });
  doc.body.append(empty);
  const traps = createFocusTrapStack(doc);

  traps.activate(empty);
  const event = doc.dispatchKey('Tab');

  assert.equal(event.defaultPrevented, true);
  assert.equal(doc.activeElement, null);
});

test('Tab 以外のキーはトラップがあっても何もしない', () => {
  const { doc, modal, buttons } = createScreen();
  const traps = createFocusTrapStack(doc);
  traps.activate(modal);
  buttons.save.focus();

  const event = doc.dispatchKey('Enter');

  assert.equal(event.defaultPrevented, false);
  assert.equal(doc.activeElement, buttons.save);
});

test('背後の要素へ inert を付け、解除で元の状態へ戻す', () => {
  const { doc, titlebar, root, modal } = createScreen();
  // アプリ側が最初から inert にしていた要素は、解除後もそのままにする。
  const alreadyInert = doc.createElement({ name: 'alreadyInert', inert: true });
  doc.body.append(alreadyInert);
  const traps = createFocusTrapStack(doc);

  const release = traps.activate(modal);
  assert.equal(titlebar.inert, true);
  assert.equal(root.inert, true);
  assert.equal(modal.inert, false);

  assert.equal(release(), true);
  assert.equal(titlebar.inert, false);
  assert.equal(root.inert, false);
  assert.equal(alreadyInert.inert, true);
});

test('data-vk-inert-exempt を持つ body 直下の子は inert にせず、解除時も他の要素の復元を壊さない', () => {
  // 汎用トースト（renderer/app.js の .vk-toast-layer, issue #326）向けの除外分岐。
  // モーダルより手前に置いてどのモーダル表示中でも操作できる必要があるため、
  // applyInert の対象から外す。
  const { doc, titlebar, root, modal } = createScreen();
  const toastLayer = doc.createElement({
    name: 'toastLayer',
    attributes: { 'data-vk-inert-exempt': '' },
  });
  doc.body.append(toastLayer);
  const traps = createFocusTrapStack(doc);

  const release = traps.activate(modal);
  // 通常どおり無効化される要素（titlebar / root）はそのまま inert になる。
  assert.equal(titlebar.inert, true);
  assert.equal(root.inert, true);
  // 除外対象は inert にならない。
  assert.equal(toastLayer.inert, false);

  // 解除しても、除外対象を挟んだことで他の要素の復元が壊れない
  // （inertBackup に載らない要素が復元処理を巻き込まないこと）。
  assert.equal(release(), true);
  assert.equal(titlebar.inert, false);
  assert.equal(root.inert, false);
  assert.equal(toastLayer.inert, false);
});

test('モーダル自身ではなく overlay が body 直下にあっても、その overlay は無効化しない', () => {
  const doc = createDocument();
  const root = doc.createElement({ name: 'root' });
  const overlay = doc.createElement({ name: 'overlay' });
  const modal = doc.createElement({ name: 'modal' });
  overlay.append(modal);
  modal.append(doc.createElement({ name: 'close', candidate: true }));
  doc.body.append(root, overlay);
  const traps = createFocusTrapStack(doc);

  traps.activate(modal);

  // overlay へ inert を付けると中のモーダルまで無効になるため、祖先は対象外にしている。
  assert.equal(overlay.inert, false);
  assert.equal(root.inert, true);
});

test('重ねたモーダルの最前面だけを閉じても、下のモーダルは操作できる状態へ戻る', () => {
  // 設定パネルの上に確認ダイアログが重なる経路（issue #282 / escapeLayer と同じ重なり順）。
  const doc = createDocument();
  const root = doc.createElement({ name: 'root' });
  const settingsOverlay = doc.createElement({ name: 'settingsOverlay' });
  const settingsModal = doc.createElement({ name: 'settingsModal' });
  const settingsClose = doc.createElement({ name: 'settingsClose', candidate: true });
  settingsModal.append(settingsClose);
  settingsOverlay.append(settingsModal);
  doc.body.append(root, settingsOverlay);
  const traps = createFocusTrapStack(doc);

  const releaseSettings = traps.activate(settingsModal);
  assert.equal(root.inert, true);

  // 確認ダイアログは設定パネルの後から body へ追加される。
  const confirmOverlay = doc.createElement({ name: 'confirmOverlay' });
  const confirmModal = doc.createElement({ name: 'confirmModal' });
  const confirmCancel = doc.createElement({ name: 'confirmCancel', candidate: true });
  confirmModal.append(confirmCancel);
  confirmOverlay.append(confirmModal);
  doc.body.append(confirmOverlay);

  const releaseConfirm = traps.activate(confirmModal, { initialFocus: confirmCancel });
  assert.equal(doc.activeElement, confirmCancel);
  // 下のモーダルは重なっている間だけ無効化する。
  assert.equal(settingsOverlay.inert, true);
  assert.equal(confirmOverlay.inert, false);

  // 最前面を閉じたら、下のモーダルは再び操作できる。背後（root）は無効のまま。
  assert.equal(releaseConfirm(), true);
  assert.equal(settingsOverlay.inert, false);
  assert.equal(root.inert, true);

  // Tab は残った設定パネルの中で循環する。
  settingsClose.focus();
  doc.dispatchKey('Tab');
  assert.equal(doc.activeElement, settingsClose);

  assert.equal(releaseSettings(), true);
  assert.equal(root.inert, false);
});

test('下のモーダルを先に閉じても、最前面の無効化は保たれる', () => {
  // 設定パネルの自動クローズが、確認ダイアログを重ねたまま発火する経路。
  const doc = createDocument();
  const root = doc.createElement({ name: 'root' });
  const settingsOverlay = doc.createElement({ name: 'settingsOverlay' });
  const settingsModal = doc.createElement({ name: 'settingsModal' });
  settingsModal.append(doc.createElement({ name: 'settingsClose', candidate: true }));
  settingsOverlay.append(settingsModal);
  const confirmOverlay = doc.createElement({ name: 'confirmOverlay' });
  const confirmModal = doc.createElement({ name: 'confirmModal' });
  const confirmCancel = doc.createElement({ name: 'confirmCancel', candidate: true });
  confirmModal.append(confirmCancel);
  confirmOverlay.append(confirmModal);
  doc.body.append(root, settingsOverlay, confirmOverlay);
  const traps = createFocusTrapStack(doc);

  const releaseSettings = traps.activate(settingsModal);
  const releaseConfirm = traps.activate(confirmModal, { initialFocus: confirmCancel });

  assert.equal(releaseSettings(), true);
  // 最前面は確認ダイアログのままなので、背後の無効化は続く。
  assert.equal(root.inert, true);
  assert.equal(settingsOverlay.inert, true);
  assert.equal(confirmOverlay.inert, false);

  assert.equal(releaseConfirm(), true);
  assert.equal(root.inert, false);
  assert.equal(settingsOverlay.inert, false);
});

test('全トラップを解除するとリスナーを外し、Tab を背後へ通す', () => {
  const { doc, modal, buttons } = createScreen();
  const traps = createFocusTrapStack(doc);
  const seen = [];
  doc.addEventListener('keydown', () => seen.push('background'));

  const release = traps.activate(modal);
  assert.equal(doc.listeners.capture.length, 1);

  assert.equal(release(), true);
  // 二重に呼んでも、後から開いたモーダルの状態を巻き戻さない。
  assert.equal(release(), false);
  assert.equal(doc.listeners.capture.length, 0);

  buttons.save.focus();
  const event = doc.dispatchKey('Tab');
  assert.deepEqual(seen, ['background']);
  assert.equal(event.defaultPrevented, false);
});

test('document とコンテナの型を検証する', () => {
  assert.throws(() => createFocusTrapStack(null), TypeError);

  const { doc } = createScreen();
  const traps = createFocusTrapStack(doc);
  assert.throws(() => traps.activate(null), TypeError);
  assert.throws(() => traps.activate('.settings-modal'), TypeError);
});
