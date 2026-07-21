// 宣言的ウィジェット（tasks-widget.json）の DOM 描画コントローラ（共有実装）。
//
// VK Orchestrator が書き出す宣言（docs/tasks-widget-schema.md）だけを読み、タスクの
// 語彙・色・遷移・操作を自前に持たずに描画する。デスクトップ（renderer/app.js）と
// モバイル（renderer/mobile.html）で描画ロジックを共有し、二重実装を減らす。
//
// このモジュールは Node（app.js が require）とブラウザ（mobile.html が <script> で読み込み）の
// 両方から使えるよう UMD 形式で定義する。契約ロジックは utils/widgetContract.js に依存する。
//
// セキュリティ契約: 宣言に載る全文字列は textContent で描画する（innerHTML 禁止）。
// URL は呼び出し側の isSafeExternalUrl で二重防御し、http(s) 以外は開かない。
// 未知の tone/field/action/rel は描画を壊さず既定フォールバックで処理する（前方互換）。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKWidgetView = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function resolveContract(injected) {
    if (injected) return injected;
    if (typeof require === 'function') {
      try { return require('../utils/widgetContract'); } catch (_e) { /* fallthrough */ }
    }
    if (typeof self !== 'undefined' && self.VKWidgetContract) return self.VKWidgetContract;
    throw new Error('VKWidgetContract not available');
  }

  const DEFAULT_STRINGS = Object.freeze({
    pending: '反映待ち',
    sendError: '送信に失敗しました（再試行してください）',
    timeoutError: '反映されませんでした（再試行してください）',
    empty: 'タスクはありません',
    emptySelf: '自分に割り当てられたタスクはありません',
    emptyFiltered: '該当するタスクはありません',
    assigneePrefix: '担当: ',
    openExternal: '（外部ブラウザで開く）',
    self: '自分のみ',
    all: '全員',
    none: '担当なし',
  });

  // window.confirm は 1 文字列なので title + body を結合する（body 空なら本文なし）。
  function joinConfirm(confirm) {
    if (!confirm) return '';
    const title = typeof confirm.title === 'string' ? confirm.title : '';
    const body = typeof confirm.body === 'string' ? confirm.body : '';
    if (title && body) return `${title}\n\n${body}`;
    return title || body;
  }

  /**
   * ウィジェット描画コントローラを生成する。
   * @param {object} deps
   * @param {Document} deps.doc
   * @param {HTMLElement} deps.groupsEl  グループを描画するコンテナ（.task-list-groups 相当）
   * @param {(url:string)=>boolean} deps.isSafeExternalUrl
   * @param {(url:string)=>void} deps.openUrl  外部リンクを開く
   * @param {(command:object)=>Promise<{ok:boolean,error?:string}>} deps.sendCommand
   * @param {(text:string)=>boolean} [deps.confirm]  確認ダイアログ（既定 window.confirm）
   * @param {()=>string} [deps.getFilterMode]  担当者フィルタの現在モード
   * @param {()=>void} [deps.requestRerender]  pending タイムアウト時などの再描画要求
   * @param {object} [deps.strings]
   * @param {object} [deps.contract]
   * @param {number} [deps.pendingTimeoutMs]
   */
  function createTaskWidgetView(deps) {
    const contract = resolveContract(deps.contract);
    const doc = deps.doc;
    const groupsEl = deps.groupsEl;
    const strings = Object.assign({}, DEFAULT_STRINGS, deps.strings || {});
    const isSafeExternalUrl = deps.isSafeExternalUrl || (() => false);
    const openUrl = deps.openUrl || (() => {});
    const sendCommand = deps.sendCommand || (async () => ({ ok: false, error: 'no-transport' }));
    const confirmFn = deps.confirm || ((text) => (typeof window !== 'undefined' ? window.confirm(text) : true));
    const getFilterMode = deps.getFilterMode || (() => 'all');
    const requestRerender = deps.requestRerender || (() => {});
    const pendingTimeoutMs = Number.isFinite(deps.pendingTimeoutMs) ? deps.pendingTimeoutMs : 30000;

    // pending: taskId -> { fields: [{ field, expected }], timeoutId }
    const pending = new Map();
    const errors = new Map();
    let lastWidget = null;

    function getPending(taskId) { return pending.get(taskId) || null; }

    function clearPending(taskId) {
      const p = pending.get(taskId);
      if (p && p.timeoutId) clearTimeout(p.timeoutId);
      pending.delete(taskId);
    }

    function setPendingField(taskId, field, expected) {
      const existing = pending.get(taskId);
      const fields = existing ? existing.fields.filter((f) => f.field !== field) : [];
      fields.push({ field, expected });
      if (existing && existing.timeoutId) clearTimeout(existing.timeoutId);
      const timeoutId = setTimeout(() => {
        clearPending(taskId);
        errors.set(taskId, strings.timeoutError);
        requestRerender();
      }, pendingTimeoutMs);
      pending.set(taskId, { fields, timeoutId });
      errors.delete(taskId);
    }

    // 現在のウィジェットに照らして pending を掃除する。
    // 反映された（該当 control の current が expected と変わった）field は落とす。
    function syncPending(widget) {
      const items = contract.flatItems(widget);
      const byId = new Map();
      for (const item of items) byId.set(item.id, item);
      for (const taskId of Array.from(pending.keys())) {
        const item = byId.get(taskId);
        if (!item) { clearPending(taskId); continue; }
        const currentByField = {};
        for (const control of (item.controls || [])) currentByField[control.field] = control.current;
        const p = pending.get(taskId);
        const remaining = p.fields.filter((f) => currentByField[f.field] === f.expected);
        if (remaining.length === 0) {
          clearPending(taskId);
        } else if (remaining.length !== p.fields.length) {
          if (p.timeoutId) clearTimeout(p.timeoutId);
          const timeoutId = setTimeout(() => {
            clearPending(taskId);
            errors.set(taskId, strings.timeoutError);
            requestRerender();
          }, pendingTimeoutMs);
          pending.set(taskId, { fields: remaining, timeoutId });
        }
      }
      for (const taskId of Array.from(errors.keys())) {
        if (!byId.has(taskId)) errors.delete(taskId);
      }
    }

    // ── DOM ヘルパー（すべて textContent。innerHTML 禁止）────────────────────
    function el(tag, className) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      return node;
    }

    function buildLink(link) {
      const a = el('a', 'widget-link');
      a.dataset.rel = link.rel;
      a.href = '#';
      a.setAttribute('role', 'link');
      a.draggable = false;
      a.title = `${link.label}\n${link.url}`;
      a.setAttribute('aria-label', `${link.label}${strings.openExternal}`);
      const text = el('span', 'widget-link-text');
      text.textContent = link.label;
      const icon = el('span', 'widget-link-icon');
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '⁠↗';
      text.appendChild(icon);
      a.appendChild(text);
      a.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isSafeExternalUrl(link.url)) openUrl(link.url);
      });
      return a;
    }

    function buildBadge(badge) {
      const span = el('span', 'widget-badge');
      span.dataset.tone = contract.toneOrDefault(badge.tone);
      span.textContent = badge.label;
      return span;
    }

    function buildControl(item, control, disabled) {
      const field = el('label', 'widget-control');
      const labelEl = el('span', 'widget-control-label');
      labelEl.textContent = control.label;
      const select = el('select', 'widget-control-select');
      select.dataset.taskId = item.id;
      select.dataset.field = control.field;
      if (control.ariaLabel) select.setAttribute('aria-label', control.ariaLabel);
      select.disabled = disabled;
      if (disabled) select.setAttribute('aria-disabled', 'true');
      // tone は現在値の option の tone を select に反映する（badge と同系統の色）。
      const optionByValue = new Map();
      for (const option of control.options) {
        optionByValue.set(option.value, option);
        const optionEl = el('option');
        optionEl.value = option.value;
        optionEl.textContent = option.label;
        optionEl.disabled = option.disabled === true;
        if (option.value === control.current) optionEl.selected = true;
        select.appendChild(optionEl);
      }
      select.value = control.current;
      select.addEventListener('change', async () => {
        const option = optionByValue.get(select.value);
        // 現在値・command 無しの選択肢は no-op（元に戻す）。
        if (!option || !option.command || option.value === control.current) {
          select.value = control.current;
          return;
        }
        if (option.confirm) {
          const text = joinConfirm(option.confirm);
          if (text && !confirmFn(text)) {
            select.value = control.current;
            return;
          }
        }
        if (getPending(item.id)) { select.value = control.current; return; }
        setPendingField(item.id, control.field, control.current);
        requestRerender();
        const res = await sendCommand(option.command);
        if (!res || !res.ok) {
          clearPending(item.id);
          errors.set(item.id, strings.sendError);
          requestRerender();
        }
      });
      field.appendChild(labelEl);
      field.appendChild(select);
      return field;
    }

    function buildItem(item) {
      const li = el('li', 'task-item');
      li.dataset.id = item.id;
      if (item.emphasis) li.dataset.emphasis = item.emphasis;

      const title = el('div', 'task-item-title');
      title.textContent = item.title;
      title.title = item.title;
      li.appendChild(title);

      const head = el('div', 'task-item-head');
      for (const badge of (item.badges || [])) head.appendChild(buildBadge(badge));
      if (item.assignee) {
        const assignee = el('span', 'task-item-assignee');
        assignee.textContent = `${strings.assigneePrefix}${item.assignee}`;
        head.appendChild(assignee);
      }
      if (head.childNodes.length) li.appendChild(head);

      if (item.links && item.links.length) {
        const links = el('div', 'task-item-links');
        for (const link of item.links) {
          if (isSafeExternalUrl(link.url)) links.appendChild(buildLink(link));
        }
        if (links.childNodes.length) li.appendChild(links);
      }

      const isPending = !!getPending(item.id);
      if (item.editable && Array.isArray(item.controls) && item.controls.length) {
        const controls = el('div', 'task-edit-panel');
        for (const control of item.controls) controls.appendChild(buildControl(item, control, isPending));
        li.appendChild(controls);
      }

      const errorMessage = errors.get(item.id);
      if (isPending || errorMessage) {
        const feedback = el('div', 'task-item-feedback');
        if (isPending) {
          const p = el('span', 'task-item-pending');
          p.setAttribute('role', 'status');
          p.textContent = strings.pending;
          feedback.appendChild(p);
        }
        if (errorMessage) {
          const err = el('span', 'task-item-action-error');
          err.setAttribute('role', 'status');
          err.textContent = errorMessage;
          feedback.appendChild(err);
        }
        li.appendChild(feedback);
      }
      return li;
    }

    function buildGroup(group, items) {
      const section = el('section', 'task-list-group');
      section.dataset.groupId = group.id;
      section.dataset.tone = contract.toneOrDefault(group.tone);

      const header = el('div', 'task-list-group-head');
      const label = el('span', 'widget-group-label');
      label.dataset.tone = contract.toneOrDefault(group.tone);
      label.textContent = group.label;
      header.appendChild(label);
      section.appendChild(header);

      const list = el('ul', 'task-list-items');
      for (const item of items) list.appendChild(buildItem(item));
      section.appendChild(list);
      return section;
    }

    /**
     * ウィジェットを groupsEl へ描画する。
     * @param {object|null} widget  サニタイズ済みウィジェット（null 可）
     * @param {{ now?: number }} [options]
     * @returns {object} 描画に付随する情報（chrome 更新用）
     */
    function render(widget, options = {}) {
      lastWidget = widget || null;
      syncPending(lastWidget);

      const now = (typeof options.now === 'number') ? options.now : Date.now();
      const stale = contract.isWidgetStale(lastWidget, { now });
      const viewer = lastWidget && lastWidget.viewer ? lastWidget.viewer : null;
      const githubMode = contract.isGithubMode(lastWidget);
      const filterEnabled = githubMode && !!viewer;

      const filterOptions = contract.deriveAssigneeFilterOptions(lastWidget, strings);
      const mode = filterEnabled
        ? contract.resolveAssigneeFilterMode(getFilterMode(), filterOptions)
        : 'all';

      groupsEl.replaceChildren();

      const groups = (lastWidget && Array.isArray(lastWidget.groups)) ? lastWidget.groups : [];
      const totalItems = contract.flatItems(lastWidget).length;
      let visibleItems = 0;
      let emptyReason = '';

      if (!lastWidget) {
        return { stale, viewer, githubMode, filterEnabled, filterOptions, filterMode: mode, totalItems, visibleItems, emptyReason, emptyText: '' };
      }

      for (const group of groups) {
        const filtered = filterEnabled
          ? contract.applyAssigneeFilter(group.items, mode, viewer)
          : (group.items || []);
        if (!filtered.length) continue;
        visibleItems += filtered.length;
        groupsEl.appendChild(buildGroup(group, filtered));
      }

      if (visibleItems === 0 && !stale) {
        const empty = el('div', 'task-list-empty');
        if (totalItems === 0) emptyReason = lastWidget.emptyText || strings.empty;
        else if (mode === 'self') emptyReason = strings.emptySelf;
        else emptyReason = strings.emptyFiltered;
        empty.textContent = emptyReason;
        groupsEl.appendChild(empty);
      }

      return {
        stale, viewer, githubMode, filterEnabled, filterOptions, filterMode: mode,
        totalItems, visibleItems, emptyReason, emptyText: lastWidget.emptyText || '',
      };
    }

    return {
      render,
      getLastWidget: () => lastWidget,
      hasPending: () => pending.size > 0,
    };
  }

  return { createTaskWidgetView, joinConfirm, DEFAULT_STRINGS };
});
