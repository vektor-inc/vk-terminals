"use strict";

const { stripAnsi, sanitizeMobilePreviewText, applyCarriageReturns, tail } = window.VKMobilePreview;
const { isSafeHttpUrl } = window.VKUrlSafety;
var statusPresentation = window.VKStatusPresentation;
var prBadge = window.VKPrBadge;

// スクロール位置の保存・復元。
// このページは Cache-Control: no-store で配信され、#list の中身は読み込み後に
// fetch('/api/states') 完了を待って非同期に描画される（poll() → render()）。
// そのためブラウザ標準の自動スクロール復元は #list がまだ空（ドキュメント高さ≒0）の
// 段階で走り、深い位置を復元できず最上部に戻ってしまう。標準復元を切り、自前で
// sessionStorage（タブ単位・再読込で保持・タブを閉じると消える）に scrollY を保存し、
// 初回描画でカードが入った後に一度だけ復元する。
if ("scrollRestoration" in history) { history.scrollRestoration = "manual"; }
var SCROLL_KEY = "vkt.scrollY";
var restoredScroll = false; // 復元は一度きり（毎回の再描画でスクロールを飛ばさない）
var scrollSaveScheduled = false;
// 復元の再試行上限。初回 render() でドキュメント高さが保存位置に届かない場合、
// 次回以降の poll() で再試行する（端末カードの描画完了が遅れるケースの保険）。
// ただし無制限に再試行すると、高さが永久に届かない状況（端末数が減った等）で
// ずっと後にコンテンツが伸びた瞬間 scrollTo が走りユーザーを引き戻す回帰を招く。
// 目的はあくまでリロード直後の復元なので、最初の数回（≒数秒）だけ再試行して諦める。
var SCROLL_RESTORE_MAX_TRIES = 5;
var scrollRestoreTries = 0;

function saveScrollY() {
  // scroll イベントは高頻度に発火するため requestAnimationFrame で 1 フレーム 1 回に間引く。
  if (scrollSaveScheduled) return;
  scrollSaveScheduled = true;
  requestAnimationFrame(function () {
    scrollSaveScheduled = false;
    try { sessionStorage.setItem(SCROLL_KEY, String(window.scrollY)); }
    catch (e) { /* 保存失敗は無視（プライベートモード等） */ }
  });
}
window.addEventListener("scroll", saveScrollY, { passive: true });

function restoreScrollOnce() {
  if (restoredScroll) return;
  var saved;
  try { saved = sessionStorage.getItem(SCROLL_KEY); }
  catch (e) { saved = null; }
  // 復元すべき値が無い／不正なら、これ以上試す意味がないので確定して終了。
  if (saved == null) { restoredScroll = true; return; }
  var y = parseInt(saved, 10);
  if (isNaN(y) || y <= 0) { restoredScroll = true; return; }
  // まだドキュメント高さが保存位置 y に届いていない場合は、復元フラグを立てずに
  // return して次回 poll() で再試行する（カード描画完了が初回に間に合わないケースの保険）。
  var maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  if (maxY < y) {
    // ただし再試行は上限まで。超えたら高さは永久に届かないとみなし諦める
    // （無制限再試行による「後からの引き戻し」回帰を防ぐ）。
    if (++scrollRestoreTries >= SCROLL_RESTORE_MAX_TRIES) restoredScroll = true;
    return;
  }
  // ここまで来たら復元できる。フラグを確定してからレイアウト確定後に復元する
  // （window.scrollTo は最大スクロール量に自動クランプされる）。
  restoredScroll = true;
  requestAnimationFrame(function () { window.scrollTo(0, y); });
}

var errEl = document.getElementById("err");
function showErr(msg) {
  if (!msg) { errEl.style.display = "none"; return; }
  errEl.textContent = msg; errEl.style.display = "block";
}

// タスクの語彙・遷移・確認文言・色は自前に持たず、GET /api/widgets が返す宣言（tasks-widget.json の
// サニタイズ済みペイロード）を共有レンダラ（/widgetView.js）で描画する。契約ロジックは
// window.VKWidgetContract（/widgetContract.js）にある。ここではその周辺の最小限だけを定義する。
// 反映待ちがこの時間内に反映されない場合はタイムアウトで解除する（ms）。共有レンダラへ渡す。
var TASK_PENDING_TIMEOUT_MS = 30000;
// コマンド送信失敗時のエラーメッセージ（send() などでも共用）。
var TASK_COMMAND_SEND_ERROR_MESSAGE = "送信に失敗しました（再試行してください）";
// dual-write 期間: 新 tasks-widget.json が無く旧 tasks-view.json だけがある場合の後方互換注記。
var WIDGET_LEGACY_NOTICE_TEXT = "orchestrator の更新が必要な可能性があります";

var taskListSection = document.getElementById("task-list");
var taskListCount = document.getElementById("task-list-count");
var taskListGroups = taskListSection ? taskListSection.querySelector(".task-list-groups") : null;
var taskListStale = taskListSection ? taskListSection.querySelector(".task-list-stale") : null;
var taskListFilter = document.getElementById("task-list-assignee-filter");
var taskListLive = document.getElementById("task-list-live");
// GET /api/widgets の中継ペイロード { widget, legacyNotice, commandsConfigured }。
var lastWidgetPayload = null;
var hasSeenFreshWidget = false;

// タスク一覧の折り畳み。項目が多いと下のペイン一覧へスクロールで届かなくなるため見出しから畳めるようにする。
var TASK_LIST_COLLAPSE_KEY = "vkt.taskListCollapsed";
var taskListHead = document.getElementById("task-list-head");
var taskListChevron = taskListHead ? taskListHead.querySelector(".task-list-chevron") : null;
function readTaskListCollapsed() {
  try { return localStorage.getItem(TASK_LIST_COLLAPSE_KEY) === "1"; } catch (e) { return false; }
}
function writeTaskListCollapsed(collapsed) {
  try { localStorage.setItem(TASK_LIST_COLLAPSE_KEY, collapsed ? "1" : "0"); } catch (e) { /* 保存失敗は無視 */ }
}

// 担当者フィルタは PC 版と同じ localStorage キーを使い、端末をまたいで選択を揃える（issue #232）。
//   "self"（自分のみ・デフォルト） / "all"（全員） / "none"（担当なし） / "<login>"（個別担当者）
var TASK_ASSIGNEE_FILTER_KEY = "vkt.taskAssigneeFilter";
var TASK_ASSIGNEE_FILTER_DEFAULT = "self";
var ASSIGNEE_OPTION_FIELD_SEP = "\u001f";
var ASSIGNEE_OPTION_ITEM_SEP = "\u001e";
function readTaskAssigneeFilter() {
  try {
    var value = localStorage.getItem(TASK_ASSIGNEE_FILTER_KEY);
    return (typeof value === "string" && value) ? value : TASK_ASSIGNEE_FILTER_DEFAULT;
  } catch (e) { return TASK_ASSIGNEE_FILTER_DEFAULT; }
}
function writeTaskAssigneeFilter(mode) {
  try { localStorage.setItem(TASK_ASSIGNEE_FILTER_KEY, mode); }
  catch (e) { /* 保存失敗は無視 */ }
}

function syncTaskListCollapse(collapsed) {
  if (taskListSection) taskListSection.classList.toggle("collapsed", collapsed);
  if (taskListHead) taskListHead.setAttribute("aria-expanded", collapsed ? "false" : "true");
  if (taskListChevron) taskListChevron.textContent = collapsed ? "▲" : "▼";
}
if (taskListHead) {
  syncTaskListCollapse(readTaskListCollapsed());
  taskListHead.addEventListener("click", function() {
    var next = !taskListSection.classList.contains("collapsed");
    syncTaskListCollapse(next);
    writeTaskListCollapsed(next);
  });
}
// ─── 宣言的ウィジェット描画（#229 / vk-orchestrator#182）────────────────────
// GET /api/widgets が返す宣言（サニタイズ済みペイロード）だけを、PC 版と共有の
// 描画ロジック（window.VKWidgetView / window.VKWidgetContract）で描画する。
var widgetContract = window.VKWidgetContract;

// http(s) のみ許可する外部リンク判定（描画側の二段構え防御）。
function isSafeExternalUrl(url) {
  return isSafeHttpUrl(url);
}

// モバイルはブラウザなので新規タブで開く（noopener/noreferrer で opener を切る）。
function openExternalUrlSafe(url) {
  if (!isSafeExternalUrl(url)) return;
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch (e) {
    /* 失敗時は何もしない */
  }
}

// 共有描画コントローラ。初回描画時に一度だけ生成する。
//   sendCommand: 宣言のコマンド断片を POST /api/widgets/command へ中継する
//                （id/requestedAt は main が付与）。
//   getFilterMode: モバイルには担当者フィルタ UI が無いため常に 'all'（全件表示）。
//   requestRerender: 反映待ちのタイムアウト等で共有側から再描画を要求する経路。
var widgetViewController = null;

function ensureWidgetViewController() {
  if (widgetViewController) return widgetViewController;
  if (!window.VKWidgetView || !taskListGroups) return null;
  widgetViewController = window.VKWidgetView.createTaskWidgetView({
    doc: document,
    groupsEl: taskListGroups,
    contract: widgetContract,
    isSafeExternalUrl: isSafeExternalUrl,
    openUrl: openExternalUrlSafe,
    sendCommand: async function(command) {
      try {
        var res = await fetch("/api/widgets/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command)
        });
        var json = await res.json().catch(function() { return {}; });
        if (res.ok && json && json.ok) {
          showErr("");
          return { ok: true };
        }
        showErr(TASK_COMMAND_SEND_ERROR_MESSAGE);
        return { ok: false, error: json && json.error };
      } catch (e) {
        showErr(TASK_COMMAND_SEND_ERROR_MESSAGE);
        return { ok: false, error: e && e.message };
      }
    },
    getFilterMode: function() { return readTaskAssigneeFilter(); },
    requestRerender: function() { renderWidget(); },
    pendingTimeoutMs: TASK_PENDING_TIMEOUT_MS
  });
  return widgetViewController;
}

// ネイティブ select ピッカーを操作中（select にフォーカスがある）かを判定する。
// poll（2 秒周期）の再描画で DOM を作り直すとピッカーが選択前に閉じてしまうため、
// この間は poll 起因の再描画をスキップする（PC 版 shouldSkipTaskRenderForActiveEdit 相当）。
function isEditingWidgetControl() {
  var active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (taskListFilter && active === taskListFilter) return true;
  if (!taskListGroups || !taskListGroups.contains(active)) return false;
  return active.tagName === "SELECT";
}

function updateWidgetFilter(info) {
  if (!taskListFilter) return;

  if (!info || !info.filterEnabled) {
    taskListFilter.hidden = true;
    if (taskListLive) taskListLive.textContent = "";
    return;
  }

  // 選択肢が変わったときだけ作り直す。poll 中に毎回 replace するとネイティブピッカーが閉じる。
  var options = Array.isArray(info.filterOptions) ? info.filterOptions : [];
  var currentOptions = Array.prototype.map.call(taskListFilter.options, function(opt) {
    return opt.value + ASSIGNEE_OPTION_FIELD_SEP + opt.textContent;
  }).join(ASSIGNEE_OPTION_ITEM_SEP);
  var nextOptions = options.map(function(opt) {
    return opt.value + ASSIGNEE_OPTION_FIELD_SEP + opt.label;
  }).join(ASSIGNEE_OPTION_ITEM_SEP);
  if (currentOptions !== nextOptions) {
    while (taskListFilter.firstChild) taskListFilter.removeChild(taskListFilter.firstChild);
    options.forEach(function(opt) {
      var el = document.createElement("option");
      el.value = opt.value;
      el.textContent = opt.label;
      taskListFilter.appendChild(el);
    });
  }
  taskListFilter.value = info.filterMode;
  taskListFilter.hidden = false;
  if (taskListLive) taskListLive.textContent = info.visibleItems + "件表示";
}

if (taskListFilter) {
  taskListFilter.addEventListener("change", function() {
    writeTaskAssigneeFilter(taskListFilter.value);
    renderWidget();
  });
}

// 一度でも新鮮な widget を見たら以後は表示を維持する（PC 版 computeTaskSectionVisibility と同じ考え方）。
// ブラウザ配信で require できないため最小限を再実装する。stale は widget があるときだけ意味を持つ。
function computeWidgetVisibility(widget, hasSeenFresh) {
  var stale = widgetContract.isWidgetStale(widget, {});
  var hasFresh = !!widget && !stale;
  var nextHasSeenFresh = hasSeenFresh === true || hasFresh;
  return {
    shouldShow: nextHasSeenFresh,
    stale: (!!widget && stale),
    hasSeenFresh: nextHasSeenFresh
  };
}

// GET /api/widgets の中継ペイロード { widget, legacyNotice, commandsConfigured } を描画する。
// widget があれば共有レンダラで描画し、無く legacyNotice のみのときはタスク語彙を復活させず
// 後方互換の注記だけを出す（dual-write 期間）。fromPoll のときはピッカー操作中の再描画を避ける。
function renderWidget(fromPoll) {
  if (!taskListSection || !taskListGroups) return;

  // ネイティブ select ピッカー操作中、または編集パネルで下書き編集中は poll 再描画をスキップする
  // （データは保持し、閉じた後の次回描画で最新化）。保存中は反映検知のため更新を通す。
  if (
    fromPoll
    && (
      isEditingWidgetControl()
      || (widgetViewController && widgetViewController.hasOpenEditor() && !widgetViewController.hasPending())
    )
  ) return;

  var payload = lastWidgetPayload;
  var widget = payload && payload.widget ? payload.widget : null;
  var legacyNotice = !!(payload && payload.legacyNotice);

  var visibility = computeWidgetVisibility(widget, hasSeenFreshWidget);
  hasSeenFreshWidget = visibility.hasSeenFresh;
  var stale = visibility.stale;
  var shouldShow = visibility.shouldShow || legacyNotice;

  taskListSection.hidden = !shouldShow;
  taskListSection.classList.toggle("is-stale", stale);

  // 注記は stale 優先。widget が無く legacyNotice のときだけ後方互換の注記を出す。
  // data-kind で配色を分ける（stale=danger / legacy=助言的な warning）。
  if (taskListStale) {
    if (stale) {
      taskListStale.dataset.kind = "stale";
      taskListStale.textContent = "orchestrator 停止中";
      taskListStale.hidden = !shouldShow;
    } else if (legacyNotice) {
      taskListStale.dataset.kind = "legacy";
      taskListStale.textContent = WIDGET_LEGACY_NOTICE_TEXT;
      taskListStale.hidden = !shouldShow;
    } else {
      taskListStale.hidden = true;
    }
  }

  if (!shouldShow) {
    while (taskListGroups.firstChild) taskListGroups.removeChild(taskListGroups.firstChild);
    updateWidgetFilter(null);
    if (taskListCount) taskListCount.textContent = "";
    return;
  }

  var controller = ensureWidgetViewController();
  if (!controller) return;
  var info = controller.render(widget, { now: Date.now() });
  updateWidgetFilter(info);
  if (taskListCount) {
    if (info && info.filterEnabled) {
      taskListCount.textContent = info.visibleItems + " / " + info.totalItems + "件";
    } else {
      taskListCount.textContent = info ? info.totalItems + "件" : "";
    }
  }
}

async function send(termId, input) {
  try {
    var res = await fetch("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ termId: termId, input: input })
    });
    if (!res.ok) {
      await res.json().catch(function(){ return {}; });
      showErr(TASK_COMMAND_SEND_ERROR_MESSAGE);
    } else {
      showErr("");
    }
  } catch (e) {
    showErr(TASK_COMMAND_SEND_ERROR_MESSAGE);
  }
}

async function closeTerm(termId, label) {
  var nm = (label && label.trim()) ? label : ("Terminal " + termId);
  if (!window.confirm("「" + nm + "」を終了しますか？\n実行中のプロセス（claude 等）が停止し、元に戻せません。")) return;
  try {
    var res = await fetch("/api/close-pane", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ termId: termId })
    });
    if (!res.ok) {
      var j = await res.json().catch(function(){ return {}; });
      showErr("終了失敗: " + (j.error || res.status));
    } else {
      showErr("");
    }
  } catch (e) {
    showErr("終了失敗: " + e.message);
  }
}

var list = document.getElementById("list");
var cards = {}; // termId -> { root, pre, name, cwd, dot, badge, head, chevron, orderControls, moveUpBtn, moveDownBtn }

var PANE_ORDER_KEY = "vkt_mobile_pane_order";
var paneOrder = []; // termId の表示順。保存値に無い新規端末は末尾へ追加する。
var visiblePaneOrder = []; // 現在描画対象の termId だけに絞った表示順。
try {
  var savedOrder = localStorage.getItem(PANE_ORDER_KEY);
  if (savedOrder) {
    var parsedOrder = JSON.parse(savedOrder);
    if (Array.isArray(parsedOrder)) {
      var orderSeen = {};
      paneOrder = parsedOrder.reduce(function(next, termId) {
        var id = String(termId);
        if (!orderSeen[id]) {
          orderSeen[id] = true;
          next.push(id);
        }
        return next;
      }, []);
    }
  }
} catch (e) { /* 壊れた JSON でも落とさない */ }

function savePaneOrder() {
  try { localStorage.setItem(PANE_ORDER_KEY, JSON.stringify(paneOrder)); }
  catch (e) { /* 保存失敗は無視（プライベートモード等） */ }
}

function getTermId(paneId, terminal) {
  return String(terminal && terminal.termId != null ? terminal.termId : paneId);
}

function isCloseLocked(terminal) {
  return !!(terminal && terminal.lock && terminal.lock.close === false);
}

function sortTerminalKeysByStatus(keys, terms) {
  // 新規端末を初めて末尾に足すときだけ、従来のステータス順で安定化する。
  return keys.slice().sort(function(a, b) {
    var ra = statusPresentation.getStatusRank(terms[a].status);
    var rb = statusPresentation.getStatusRank(terms[b].status);
    if (ra !== rb) return ra - rb;
    return getTermId(a, terms[a]).localeCompare(getTermId(b, terms[b]), undefined, { numeric: true });
  });
}

function syncPaneOrder(terms) {
  var keys = Object.keys(terms);
  var present = {};
  keys.forEach(function(paneId) {
    present[getTermId(paneId, terms[paneId])] = true;
  });

  var used = {};
  var next = [];
  paneOrder.forEach(function(termId) {
    var id = String(termId);
    if (!used[id]) {
      used[id] = true;
      next.push(id);
    }
  });

  var changed = next.length !== paneOrder.length;
  sortTerminalKeysByStatus(keys, terms).forEach(function(paneId) {
    var id = getTermId(paneId, terms[paneId]);
    if (!used[id]) {
      used[id] = true;
      next.push(id);
      changed = true;
    }
  });

  if (!changed) {
    for (var i = 0; i < next.length; i++) {
      if (next[i] !== paneOrder[i]) { changed = true; break; }
    }
  }
  paneOrder = next;
  if (changed) savePaneOrder();
  visiblePaneOrder = paneOrder.filter(function(termId) { return !!present[termId]; });
  return visiblePaneOrder;
}

function applyPaneOrder() {
  var showOrderControls = visiblePaneOrder.length > 1;
  visiblePaneOrder.forEach(function(termId, idx) {
    var c = cards[termId];
    if (!c) return;
    c.root.style.order = String(idx);
    c.orderControls.style.display = showOrderControls ? "" : "none";
    c.moveUpBtn.disabled = idx === 0;
    c.moveDownBtn.disabled = idx === visiblePaneOrder.length - 1;
  });
}

function movePane(termId, delta) {
  var id = String(termId);
  var idx = visiblePaneOrder.indexOf(id);
  if (idx < 0) return;
  var nextIdx = idx + delta;
  if (nextIdx < 0 || nextIdx >= visiblePaneOrder.length) return;
  visiblePaneOrder.splice(idx, 1);
  visiblePaneOrder.splice(nextIdx, 0, id);
  var visible = {};
  visiblePaneOrder.forEach(function(visibleId) { visible[visibleId] = true; });
  var nextVisibleIndex = 0;
  paneOrder = paneOrder.map(function(orderId) {
    if (!visible[orderId]) return orderId;
    return visiblePaneOrder[nextVisibleIndex++];
  });
  savePaneOrder();
  applyPaneOrder();
}

// 折り畳み状態は cards とは独立した plain object で持つ（termId -> bool）。
// 理由: render() 末尾で states から消えた端末は cards[termId].root.remove() され
// cards から消える。端末が一瞬消えて復活すると ensureCard がまっさらな DOM を
// 作り直すため、DOM の classList を状態の真実にすると吹き飛ぶ。collapsed を
// 別管理し、render のカード更新ループで毎回 classList を当て直すことで
// 再描画・復活をまたいで状態を一致させる。
var COLLAPSE_KEY = "vkt.collapsed";
var collapsed = {}; // termId -> bool
try {
  var saved = localStorage.getItem(COLLAPSE_KEY);
  if (saved) {
    var parsed = JSON.parse(saved);
    if (parsed && typeof parsed === "object") collapsed = parsed;
  }
} catch (e) { /* 壊れた JSON でも落とさない */ }

function saveCollapsed() {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed)); }
  catch (e) { /* 保存失敗は無視（プライベートモード等） */ }
}

// chevron / aria-expanded を collapsed 状態に同期
function syncCollapseUI(c, termId) {
  var isCollapsed = !!collapsed[termId];
  c.root.classList.toggle("collapsed", isCollapsed);
  c.head.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
  c.chevron.textContent = isCollapsed ? "▲" : "▼";
}

function toggleCollapse(termId) {
  var c = cards[termId];
  if (!c) return;
  collapsed[termId] = !collapsed[termId];
  syncCollapseUI(c, termId);
  if (!collapsed[termId]) c.pre.scrollTop = c.pre.scrollHeight;
  saveCollapsed();
}

function ensureCard(termId) {
  if (cards[termId]) return cards[termId];
  var root = document.createElement("div"); root.className = "card";

  var head = document.createElement("div"); head.className = "card-head";
  var headMain = document.createElement("div"); headMain.className = "card-head-main";
  var headMeta = document.createElement("div"); headMeta.className = "card-head-meta";
  var dot = document.createElement("span"); dot.className = "dot"; dot.dataset.status = "idle";
  var title = document.createElement("a"); title.className = "card-title";
  var name = document.createElement("div"); name.className = "name";
  var cwd = document.createElement("div"); cwd.className = "cwd";
  title.appendChild(name); title.appendChild(cwd);
  var badge = document.createElement("span"); badge.className = "badge"; badge.dataset.status = "idle"; badge.hidden = true;
  badge.setAttribute("role", "status");
  badge.setAttribute("aria-live", "polite");
  // PR リンク（issue #53）。ヘッダ帯に置くことで折り畳んでも残り、PC の「常時表示」方針と整合する。
  // モバイルは通常ブラウザなので実 URL を href に入れた通常リンク（target=_blank）にする。
  // href へのセットは render() 側で isSafeHttpUrl() を通った値だけ行う。
  var prLink = document.createElement("a");
  prLink.className = "pr-link"; // 初期は display:none。.show 付与で表示
  prLink.target = "_blank";
  prLink.rel = "noopener noreferrer";
  prLink.setAttribute("aria-label", "プルリクエストを開く");
  var prLabel = document.createElement("span"); prLabel.textContent = "PR";
  var prIcon = document.createElement("span"); prIcon.className = "pr-icon";
  prIcon.setAttribute("aria-hidden", "true"); prIcon.textContent = "↗";
  prLink.appendChild(prLabel); prLink.appendChild(prIcon);
  var orderControls = document.createElement("span"); orderControls.className = "pane-order-controls";
  var moveUpBtn = document.createElement("button");
  moveUpBtn.type = "button"; moveUpBtn.className = "pane-order-button";
  moveUpBtn.textContent = "↑"; moveUpBtn.setAttribute("aria-label", "1つ上へ移動");
  moveUpBtn.addEventListener("click", function() { movePane(termId, -1); });
  var moveDownBtn = document.createElement("button");
  moveDownBtn.type = "button"; moveDownBtn.className = "pane-order-button";
  moveDownBtn.textContent = "↓"; moveDownBtn.setAttribute("aria-label", "1つ下へ移動");
  moveDownBtn.addEventListener("click", function() { movePane(termId, 1); });
  orderControls.appendChild(moveUpBtn); orderControls.appendChild(moveDownBtn);
  var chevron = document.createElement("span"); chevron.className = "chevron";
  chevron.setAttribute("aria-hidden", "true"); chevron.textContent = "▼";
  headMain.appendChild(dot); headMain.appendChild(title);
  headMeta.appendChild(badge); headMeta.appendChild(prLink); headMeta.appendChild(orderControls); headMeta.appendChild(chevron);
  head.appendChild(headMain); head.appendChild(headMeta);

  // ヘッダ帯全体をタップで開閉トグル。将来ヘッダ内に
  // ボタン/入力/リンクを置いた場合の保険で、それらをタップした時はトグルしない。
  head.setAttribute("role", "button");
  head.setAttribute("tabindex", "0");
  function onHeadToggle(e) {
    if (e.target.closest("button, input, a[href]")) return;
    toggleCollapse(termId);
  }
  head.addEventListener("click", onHeadToggle);
  head.addEventListener("keydown", function(e) {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      if (e.target.closest("button, input, a[href]")) return;
      e.preventDefault();
      onHeadToggle(e);
    }
  });

  var pre = document.createElement("pre"); pre.className = "lines";

  var actions = document.createElement("div"); actions.className = "actions";
  // 自由入力
  var sendrow = document.createElement("div"); sendrow.className = "sendrow";
  var inp = document.createElement("input");
  inp.type = "text"; inp.placeholder = "コマンド/テキスト"; inp.autocapitalize = "off";
  inp.autocomplete = "off"; inp.spellcheck = false;
  var sbtn = document.createElement("button"); sbtn.textContent = "送信";
  function doSend() {
    var v = inp.value;
    if (v === "") return;
    send(termId, nlToggle.checked ? v + "\r" : v);
    inp.value = "";
  }
  sbtn.addEventListener("click", doSend);
  inp.addEventListener("keydown", function(e) { if (e.key === "Enter") doSend(); });
  sendrow.appendChild(inp); sendrow.appendChild(sbtn);
  var nlLabel = document.createElement("label"); nlLabel.className = "nl-toggle";
  var nlToggle = document.createElement("input"); nlToggle.type = "checkbox"; nlToggle.checked = true;
  nlLabel.appendChild(nlToggle);
  nlLabel.appendChild(document.createTextNode("末尾に改行(↵)を付ける"));

  actions.appendChild(sendrow);
  actions.appendChild(nlLabel);

  // ペイン終了ボタン（issue #100）。破壊的操作なので最下段・独立行・全幅・塗り赤。
  var killRow = document.createElement("div"); killRow.className = "row danger-row";
  var killBtn = document.createElement("button");
  killBtn.className = "k kill"; killBtn.textContent = "✕ ターミナルを終了";
  killBtn.addEventListener("click", function() {
    if (cards[termId] && cards[termId].closeLocked) return;
    closeTerm(termId, name.textContent);
  });
  killRow.appendChild(killBtn);
  actions.appendChild(killRow);

  root.appendChild(head); root.appendChild(pre); root.appendChild(actions);
  list.appendChild(root);

  cards[termId] = { root: root, pre: pre, name: name, cwd: cwd, dot: dot, badge: badge,
    title: title,
    prLink: prLink, prIcon: prIcon, head: head, chevron: chevron, orderControls: orderControls, killBtn: killBtn,
    moveUpBtn: moveUpBtn, moveDownBtn: moveDownBtn };
  // 復活時を含め、現在の collapsed 状態を初期反映
  syncCollapseUI(cards[termId], termId);
  return cards[termId];
}

// 使用量カード（issue #69 → #73）。data.usage があれば表示、無ければカードごと隠す。
//   - source === 'oauth'（公式 usage API）: セッション% / 週間% の 2 バー表示。
//     percent は百分率（17 = 17%）、resetAtMs は epoch ms。2 秒ポーリングに相乗りして
//     残り時間表示も自然に追従する。
//   - それ以外（source === 'transcript' フォールバック）: 従来表示のまま。
// 文字列は textContent で入れるので XSS 面も安全。
var usageCard = document.getElementById("usage-card");
var codexUsageCard = document.getElementById("codex-usage-card");
var appVersionFooter = document.getElementById("app-version-footer");
var appTitleHeading = document.querySelector("header h1");

// ヘッダー／タブ／フッターに表示するアプリ名。呼び出し元が env VK_TERMINALS_APP_TITLE を
// 渡すと main が /api/states の appTitle で伝えてくる。未指定時は既定の "VK Terminals"。
var appTitle = "VK Terminals";

function renderAppTitle(title) {
  var t = typeof title === "string" ? title.trim() : "";
  appTitle = t || "VK Terminals";
  if (appTitleHeading) appTitleHeading.textContent = appTitle;
  document.title = appTitle + " - Remote";
}

function renderAppVersion(version) {
  if (!appVersionFooter) return;
  var v = typeof version === "string" ? version.trim() : "";
  if (!v) {
    appVersionFooter.textContent = "";
    appVersionFooter.classList.remove("show");
    return;
  }
  appVersionFooter.textContent = appTitle + " v" + v;
  appVersionFooter.classList.add("show");
}

// 残り時間（ms）→「◯時間◯分後にリセット」
function fmtRemainingJa(ms) {
  if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "まもなくリセット";
  var totalMin = Math.floor(ms / 60000);
  var h = Math.floor(totalMin / 60);
  var m = totalMin % 60;
  if (h > 0) return h + "時間" + m + "分後にリセット";
  if (m > 0) return m + "分後にリセット";
  return "まもなくリセット";
}

// epoch ms →「金 18:59 にリセット」（ローカル時刻）
function fmtResetDayTimeJa(ms) {
  var d = new Date(ms);
  var wd = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  var hh = String(d.getHours()).padStart(2, "0");
  var mm = String(d.getMinutes()).padStart(2, "0");
  return wd + " " + hh + ":" + mm + " にリセット";
}

// 公式データ 1 区分（セッション / 週間）の行を更新する。
// mode: "remaining" は残り時間表示、"datetime" はリセット日時表示。
function renderOauthRow(prefix, entry, mode) {
  var sec = document.getElementById(prefix + "-sec");
  if (!sec) return;
  var pct = entry && typeof entry.percent === "number" && isFinite(entry.percent)
    ? Math.max(0, Math.min(100, entry.percent)) : null;
  if (pct === null) { sec.hidden = true; return; }
  sec.hidden = false;
  document.getElementById(prefix + "-pct").textContent = Math.round(pct) + "% 使用済み";
  var fill = document.getElementById(prefix + "-fill");
  fill.style.width = pct + "%";
  // 公式% のみ閾値カラー（〜70% 青 / 70〜90% アンバー / 90%〜 赤）
  fill.className = "u-fill" + (pct >= 90 ? " level-crit" : pct >= 70 ? " level-warn" : "");
  // SR 向け progressbar の現在値を更新（role / min / max は HTML 側で静的付与済み）
  var track = document.getElementById(prefix + "-track");
  if (track) track.setAttribute("aria-valuenow", String(Math.round(pct)));
  var resetEl = document.getElementById(prefix + "-reset");
  if (entry.resetAtMs && isFinite(entry.resetAtMs)) {
    resetEl.textContent = mode === "remaining"
      ? fmtRemainingJa(entry.resetAtMs - Date.now())
      : fmtResetDayTimeJa(entry.resetAtMs);
  } else {
    resetEl.textContent = "";
  }
}

function renderUsage(usage) {
  if (!usageCard) return;
  var oauthBox = document.getElementById("usage-oauth");
  var lineRow = document.getElementById("usage-line");
  var barRow = document.getElementById("usage-bar");
  var noteRow = document.getElementById("usage-note");

  // 公式 usage API 取得時: 2 バー表示（フォールバック行は隠す）
  if (usage && usage.source === "oauth" && (usage.session || usage.weekly)) {
    renderOauthRow("uo-session", usage.session, "remaining");
    renderOauthRow("uo-weekly", usage.weekly, "datetime");
    oauthBox.hidden = false;
    lineRow.hidden = true;
    barRow.hidden = true;
    noteRow.hidden = true;
    usageCard.classList.add("show");
    return;
  }

  // フォールバック（トランスクリプト集計）: 従来表示
  oauthBox.hidden = true;
  if (!usage || !usage.mobileText) {
    usageCard.classList.remove("show");
    return;
  }
  lineRow.hidden = false;
  document.getElementById("usage-text").textContent = usage.mobileText;
  // ピーク比（バー）行は utilization がある時だけ表示。無い時は 0% 誤読を避けて行ごと隠す。
  if (usage.barText) {
    document.getElementById("usage-marks").textContent = usage.bar || "";
    document.getElementById("usage-percent").textContent = usage.barText;
    noteRow.textContent = usage.peakNote || "";
    barRow.hidden = false;
    noteRow.hidden = !usage.peakNote;
  } else {
    barRow.hidden = true;
    noteRow.hidden = true;
  }
  usageCard.classList.add("show");
}

// Codex 使用量カード（issue #218）。PC 版サイドバー（renderCodexUsageView）と対称に描画する。
//   - usage が falsy または usage.empty === true のときはカードごと隠す（Codex 未使用ユーザー）。
//   - session / weekly は Claude カードと同じ renderOauthRow を流用（prefix "co-session" / "co-weekly"）。
//   - tokens（{ todayText, weeklyText }）があれば「今日 ◯ / 今週 ◯ トークン」を表示。
//   - stale === true のときは直近値表示中の注記を出す（PC 版と対称）。
// 文字列は textContent で入れるので XSS 面も安全。
function renderCodexUsage(usage) {
  if (!codexUsageCard) return;
  // データ無し・空スナップショットはカードごと非表示にする。
  if (!usage || usage.empty === true) {
    codexUsageCard.classList.remove("show");
    return;
  }

  var oauthBox = document.getElementById("codex-usage-oauth");
  var staleNote = document.getElementById("co-stale-note");
  var tokensBox = document.getElementById("co-tokens");

  // 直近取得値を表示している旨の注記（PC 版 renderCodexUsageView と同文）。
  if (usage.stale === true) {
    staleNote.textContent = "直近に取得した値を表示しています（最新の取得に一時的に失敗しました）";
    staleNote.hidden = false;
  } else {
    staleNote.textContent = "";
    staleNote.hidden = true;
  }

  // セッション% / 週間% の 2 バー（Claude カードと同じ描画関数を流用）。
  if (usage.session || usage.weekly) {
    renderOauthRow("co-session", usage.session, "remaining");
    renderOauthRow("co-weekly", usage.weekly, "datetime");
    oauthBox.hidden = false;
  } else {
    oauthBox.hidden = true;
  }

  // トークン数（今日 / 今週）。PC 版 buildCodexTokenUsageSection の表記に合わせる。
  if (usage.tokens) {
    var today = usage.tokens.todayText ? usage.tokens.todayText : "0";
    var weekly = usage.tokens.weeklyText ? usage.tokens.weeklyText : "0";
    document.getElementById("co-tokens-today").textContent = "今日 " + today;
    document.getElementById("co-tokens-weekly").textContent = "今週 " + weekly + " トークン";
    tokensBox.hidden = false;
  } else {
    tokensBox.hidden = true;
  }

  codexUsageCard.classList.add("show");
}

function render(data) {
  renderAppTitle(data.appTitle);
  renderAppVersion(data.version);
  renderUsage(data.usage);
  renderCodexUsage(data.codexUsage);
  var terms = data.terminals || {};
  var keys = Object.keys(terms);
  var termById = {};
  keys.forEach(function(paneId) {
    termById[getTermId(paneId, terms[paneId])] = terms[paneId];
  });
  var orderedTermIds = syncPaneOrder(terms);

  var seen = {};
  orderedTermIds.forEach(function(termId) {
    var t = termById[termId];
    if (!t) return;
    seen[termId] = true;
    var c = ensureCard(termId);
    var st = t.status || "idle";
    c.dot.dataset.status = st;
    c.badge.dataset.status = st;
    var statusView = statusPresentation.getStatusPresentation(st);
    c.badge.textContent = statusView.label;
    c.badge.hidden = !statusView.label;
    if (statusView.ariaLabel) {
      c.badge.setAttribute("aria-label", statusView.ariaLabel);
    } else {
      c.badge.removeAttribute("aria-label");
    }
    // displayTitle = apiTitle || taskTitle（main 側 getDisplayTitle と同じ値）。
    // 旧 t.title は存在しないフィールドで常に空だったため、必ず "Terminal N" に
    // フォールバックしていた不具合を修正（issue: モバイル側でタスク名が出ない）。
    var title = t.displayTitle || t.apiTitle || t.taskTitle || "";
    c.name.textContent = title.trim() ? title : ("Terminal " + termId);
    c.closeLocked = isCloseLocked(t);
    c.killBtn.classList.toggle("is-locked", c.closeLocked);
    if (c.closeLocked) {
      c.killBtn.textContent = "🔒 保護中（閉じられません）";
      c.killBtn.setAttribute("aria-disabled", "true");
      c.killBtn.setAttribute("aria-label", "このペインは保護されています（閉じられません）");
      c.killBtn.setAttribute("title", "このペインは保護されています（閉じられません）");
    } else {
      c.killBtn.textContent = "✕ ターミナルを終了";
      c.killBtn.removeAttribute("aria-disabled");
      c.killBtn.setAttribute("aria-label", (c.name.textContent || ("Terminal " + termId)) + " を終了する（実行中プロセスを停止）");
      c.killBtn.removeAttribute("title");
    }
    c.cwd.textContent = t.cwdShort || t.cwd || "";
    // タイトルリンクは PC 版と同じく apiUrl（issue / 任意 URL）を使う。
    // PR リンクボタンは apiPrUrl を使い、両者を独立して判定する。
    if (isSafeHttpUrl(t.apiUrl)) {
      c.title.href = t.apiUrl;
      c.title.target = "_blank";
      c.title.rel = "noopener noreferrer";
      c.title.classList.add("is-link");
      c.title.setAttribute("aria-label", c.name.textContent + " のリンクを新しいタブで開く");
    } else {
      c.title.removeAttribute("href");
      c.title.removeAttribute("target");
      c.title.removeAttribute("rel");
      c.title.classList.remove("is-link");
      c.title.removeAttribute("aria-label");
    }
    // PR リンク（issue #53）。安全な http(s) URL のときだけ href にセットして表示、
    // そうでなければ href を空にして非表示にする。
    if (isSafeHttpUrl(t.apiPrUrl)) {
      var prPresentation = prBadge.getPrBadgePresentation(t.apiPrMerged, { external: false });
      c.prLink.href = t.apiPrUrl;
      c.prLink.title = t.apiPrUrl;
      c.prLink.classList.add("show");
      c.prLink.classList.toggle("merged", prPresentation.merged);
      c.prLink.setAttribute("aria-label", prPresentation.ariaLabel);
      c.prIcon.textContent = prPresentation.icon;
    } else {
      var hiddenPrPresentation = prBadge.getPrBadgePresentation(false, { external: false });
      c.prLink.removeAttribute("href");
      c.prLink.removeAttribute("title");
      c.prLink.classList.remove("show");
      c.prLink.classList.remove("merged");
      c.prLink.setAttribute("aria-label", hiddenPrPresentation.ariaLabel);
      c.prIcon.textContent = hiddenPrPresentation.icon;
    }
    // 罫線・装飾行を除去してから末尾を切り出し、読める直近出力を残す。
    var cleaned = sanitizeMobilePreviewText(stripAnsi(t.lastLines || ""))
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    var next = tail(cleaned, 4000);
    if (next !== c.lastText) {
      var stick = (c.pre.scrollHeight - c.pre.scrollTop - c.pre.clientHeight) <= 24;
      c.pre.textContent = next;
      c.lastText = next;
      if (stick) c.pre.scrollTop = c.pre.scrollHeight;
    }
    // 折り畳み状態を毎回当て直す（再描画・端末の消失→復活をまたいで一致させる）
    syncCollapseUI(c, termId);
  });
  // 消えた端末のカードを削除
  Object.keys(cards).forEach(function(termId) {
    if (!seen[termId]) { cards[termId].root.remove(); delete cards[termId]; }
  });
  // CSS order で並び替え（DOM移動をやめてモバイルでの入力フォーカス消失を防ぐ）
  applyPaneOrder();

  if (keys.length === 0) {
    if (!document.getElementById("empty")) {
      var e = document.createElement("div"); e.className = "empty"; e.id = "empty";
      e.textContent = "稼働中のターミナルがありません";
      list.appendChild(e);
    }
  } else {
    var e = document.getElementById("empty"); if (e) e.remove();
  }

  var d = new Date(data.updatedAt || Date.now());
  var hh = String(d.getHours()).padStart(2, "0");
  var mm = String(d.getMinutes()).padStart(2, "0");
  var ss = String(d.getSeconds()).padStart(2, "0");
  document.getElementById("meta").textContent = keys.length + "台 · " + hh + ":" + mm + ":" + ss;
}

async function poll() {
  try {
    var responses = await Promise.all([
      fetch("/api/states", { cache: "no-store" }),
      fetch("/api/widgets", { cache: "no-store" })
    ]);
    if (!responses[0].ok) throw new Error("/api/states HTTP " + responses[0].status);
    if (!responses[1].ok) throw new Error("/api/widgets HTTP " + responses[1].status);
    var payloads = await Promise.all([
      responses[0].json(),
      responses[1].json()
    ]);
    var data = payloads[0];
    lastWidgetPayload = payloads[1] || null;
    render(data);
    // fromPoll=true: ネイティブ select ピッカー操作中の再描画を避ける。
    renderWidget(true);
    // 初回描画でカードが #list に入った後に一度だけスクロール位置を復元する。
    // 2 回目以降のポーリング再描画では呼ばない（ユーザーのスクロール操作と競合させない）。
    restoreScrollOnce();
    showErr("");
  } catch (e) {
    document.getElementById("meta").textContent = "接続エラー";
    showErr("状態取得に失敗: " + e.message);
  }
}

// ペイン追加ボタン（issue #217）。
// useDefaults: true を明示して POST /api/new-pane を呼ぶ。この経路だけ renderer 側で
// cwd/noClaude 省略時に config 既定値（newPaneStartupDir / !newPaneAutoLaunchClaude）が
// 補われ、デスクトップの「＋」ボタンと同じ挙動になる（他の API 呼び出し元は非影響）。
var addPaneBtn = document.getElementById("add-pane-btn");
var addPaneIcon = addPaneBtn ? addPaneBtn.querySelector(".add-pane-icon") : null;
var addPaneLabel = addPaneBtn ? addPaneBtn.querySelector(".add-pane-label") : null;
var addPaneInFlight = false;
var ADD_PANE_TIMEOUT_MS = 8000;

function setAddPaneBusy(busy) {
  if (!addPaneBtn) return;
  addPaneInFlight = busy;
  addPaneBtn.disabled = busy;
  // アクセシブル名は aria-label で「ペインを追加」に固定し、in-flight は aria-busy で伝える。
  if (busy) addPaneBtn.setAttribute("aria-busy", "true");
  else addPaneBtn.removeAttribute("aria-busy");
  if (addPaneLabel) addPaneLabel.textContent = busy ? "追加中…" : "ペインを追加";
  if (addPaneIcon) addPaneIcon.hidden = busy;
}

async function requestNewPane() {
  if (addPaneInFlight) return;
  setAddPaneBusy(true);
  // ハング対策のタイムアウト。応答が来なくても必ず解除＋エラー表示する。
  var settled = false;
  var timer = setTimeout(function () {
    if (settled) return;
    settled = true;
    setAddPaneBusy(false);
    showErr("追加失敗: タイムアウト");
  }, ADD_PANE_TIMEOUT_MS);
  try {
    var res = await fetch("/api/new-pane", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ useDefaults: true })
    });
    var j = await res.json().catch(function () { return {}; });
    if (settled) return; // タイムアウト後に遅れて届いた応答は無視（多重解除・上書きを防ぐ）
    settled = true;
    clearTimeout(timer);
    if (!res.ok || !j.ok) {
      setAddPaneBusy(false);
      showErr("追加失敗: " + (j.error || res.status));
      return;
    }
    showErr("");
    // 次ポーリング（約2秒）を待たず即再取得して新カードを早く描画する。
    await poll();
    // 新しい termId のカードへスクロール（この時点で描画済みなら）。
    var newId = j.termId != null ? String(j.termId) : "";
    if (newId && cards[newId] && cards[newId].root && typeof cards[newId].root.scrollIntoView === "function") {
      cards[newId].root.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    setAddPaneBusy(false);
  } catch (e) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    setAddPaneBusy(false);
    showErr("追加失敗: " + e.message);
  }
}

if (addPaneBtn) addPaneBtn.addEventListener("click", requestNewPane);

// 自己再帰 setTimeout で逐次実行を保証（setInterval だと前回 fetch 完了前に
// 次が走り、古い結果が新しい結果を上書きしうるため）。
(function loop() {
  poll().finally(function () { setTimeout(loop, 2000); });
})();
