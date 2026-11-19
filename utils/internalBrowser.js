'use strict';

const electron = require('electron');
const { pathToFileURL } = require('node:url');
const { isSafeHelpDocument } = require('./helpFeature');
const { PARTITION, HELP_URL, isHelpUrl, validateBrowserBounds, isBrowserUrl, isNavigationUrl, isAllowedBrowserPermission } = require('./internalBrowserPolicy');
const { MAX_TABS, toTabMatchKey, pickTabAfterClose, shouldForegroundOpenedTab } = require('./internalBrowserTabPolicy');
const { pickFaviconUrl, fetchFaviconDataUrl, isAllowedFaviconTarget } = require('./internalBrowserFavicon');

const normalizeDownloadUrl = url => {
  try { return new URL(url).href; } catch { return ''; }
};

const isSameDocumentUrl = (left, right) => {
  try {
    const a = new URL(left);
    const b = new URL(right);
    a.hash = '';
    b.hash = '';
    return a.href === b.href;
  } catch (_error) {
    return false;
  }
};

/**
 * タブ 1 つ分のページ（WebContentsView 1 つ）と、その表示状態・遷移の追跡を作る。
 * 表示位置・表示可否・セッション単位の検査はタブ全体の管理層（createInternalBrowser）が持つ。
 *
 * @param {number} id タブ番号
 * @param {object} host 管理層から渡す依存
 * @param {object} host.win 親の BrowserWindow
 * @param {Function} host.WebContentsView Electron の WebContentsView
 * @param {object} host.dialog Electron の dialog
 * @param {string|null} host.helpDocumentPath 外部ブラウザで開く案内ファイルのパス
 * @param {Function} host.nextOperationId タブ全体で通しの操作番号を払い出す
 * @param {Function} host.sendState (tab, state) 状態を画面へ送る
 * @param {Function} host.sendDownloadNotice (tab, canOpenFromToolbar) ダウンロード停止案内を画面へ送る
 * @param {Function} host.syncBounds 選んでいるタブのページを表示位置へ付け外しする
 * @param {Function} host.releaseView (view) 画面に付いていれば外す
 * @param {Function} host.openFromPage (tab, url, disposition) ページの新しいタブ要求を開く
 * @param {Function} host.sendTabs タブの一覧（タイトル・ファビコンなど）を画面へ送る
 * @param {Function} host.fetchFavicon (url, pageUrl) ファビコンを data URL にして返す
 * @returns {object} タブの操作
 */
function createBrowserTab(id, host) {
  const { win, WebContentsView, dialog, helpDocumentPath = null } = host;
  let view = null;
  let currentUrl = '';
  let pendingUrl = '';
  let downloadUrl = '';
  let failedUrl = '';
  let github404Url = '';
  let navigationResult = null;
  let navigationRequestId = null;
  let navigationOperationId = 0;
  let mainFrameId = null;
  let documentLoaderId = null;
  let document404Url = '';
  let helpReturnUrl = '';
  let helpForwardUrl = '';
  // タブの行に出すページタイトルとファビコン（data URL）。文書が替わったら消す。
  let title = '';
  let favicon = '';
  let faviconSourceUrl = '';
  const retiredLoaders = new Set();
  let debuggerAvailable = true;
  // Electron 44.3 の loadURL Promise も ID のないイベントを監視するため、
  // CDP Page.navigate が返す loaderId と Page.lifecycleEvent を相関する。
  let activeLoad = null;
  let navigationReady = null;
  let navigationInitialized = false;
  // 応答待ちの現在操作だけを保持し、終了・置換時に解放する。
  const downloadCandidates = new Set();
  // native の Page.downloadWillBegin は frameId/guid だけで loaderId がなく、
  // 世代を特定できないため Page.navigate 応答のある操作だけを候補にする。
  // 終了済み候補は保持せず、現在の結果待ち／確定済み download だけを見る。
  const findDownloadCandidates = urls => [
    ...downloadCandidates, ...(activeLoad?.done && activeLoad.downloadConfirmed ? [activeLoad] : []),
  ].filter(load => urls.includes(normalizeDownloadUrl(load.downloadSourceUrl)));

  /**
   * 管理層がこのタブへ振り分けたダウンロードを、遷移操作と突き合わせて案内を出す。
   *
   * @param {string[]} urls 正規化済みのダウンロード URL の経路
   * @param {boolean} fromOtherContents どのタブのページにも属さない配送か
   */
  function handleDownload(urls, fromOtherContents) {
    const candidates = findDownloadCandidates(urls);
    const load = candidates.length === 1 ? candidates[0] : null;
    if (fromOtherContents || !load || load !== activeLoad
      || load.noticeReceived || load.downloadAmbiguous) {
      // 同一 URL の旧通知と区別できない配送は一般案内として消費する。
      // 現在候補も消費し、次の要求へ曖昧さを持ち越さない。
      if (!fromOtherContents) {
        for (const candidate of candidates) {
          candidate.noticeReceived = true;
          candidate.flushDownloadNotice(false);
          downloadCandidates.delete(candidate);
        }
      }
      sendDownloadNotice(false);
      return;
    }
    load.noticeReceived = true;
    downloadCandidates.delete(load);
    if (load.downloadConfirmed) sendDownloadNotice(load.canOpenDownloadFromToolbar);
    else load.pendingDownloadNotice = true;
  }

  function sendDownloadNotice(canOpenFromToolbar) {
    host.sendDownloadNotice(tab, canOpenFromToolbar);
  }

  function syncBounds() {
    host.syncBounds();
  }

  /**
   * 状態を画面へ送る。selected はタブを選んだときの送り直しで、画面はこの通知をそのタブの正として扱う。
   *
   * @param {object} [options]
   * @param {boolean} [options.selected] タブを選んだときの送り直しか
   */
  function publish({ selected = false } = {}) {
    const contents = view?.webContents;
    const available = contents && !contents.isDestroyed?.();
    const history = available ? contents.navigationHistory : null;
    host.sendState(tab, {
      url: currentUrl,
      pendingUrl,
      downloadUrl,
      failedUrl,
      github404Url,
      navigationResult,
      navigationRequestId,
      navigationOperationId,
      loading: !!available && contents.isLoading(),
      canGoBack: !!available && (canUseHelpReturn() || canMoveHistory(history, -1, 'canGoBack')),
      canGoForward: !!available && (canUseHelpForward() || canMoveHistory(history, 1, 'canGoForward')),
      ...(selected === true ? { selected: true } : {}),
    });
  }

  function supersedeNavigation(nextUrl) {
    activeLoad?.cancelHelp?.(nextUrl);
    // 旧操作の終了だけを通知し、既に始まったページ起点の新遷移は止めない。
    if (activeLoad && !activeLoad.done && navigationResult === null) {
      navigationResult = 'superseded';
      publish();
    }
    navigationRequestId = null;
    navigationResult = null;
    pendingUrl = '';
    const previous = activeLoad;
    previous?.flushDownloadNotice(false);
    downloadCandidates.delete(previous);
    if (previous?.loaderId) retiredLoaders.add(previous.loaderId);
    for (const loaderId of previous?.commits.keys() || []) retiredLoaders.add(loaderId);
    for (const request of previous?.requests.values() || []) retiredLoaders.add(request.loaderId);
    activeLoad = null;
    return previous;
  }

  function ensureView() {
    if (!view) {
      view = new WebContentsView({ webPreferences: {
        partition: PARTITION, sandbox: true, nodeIntegration: false, contextIsolation: true,
        webSecurity: true, allowRunningInsecureContent: false,
      } });
      const contents = view.webContents;
      // この専用ビューの CDP 接続は遷移追跡だけに使う。
      contents.debugger?.on('message', (_event, method, params) => {
        const load = activeLoad;
        if (load?.help) return;
        if (method === 'Page.navigatedWithinDocument') {
          if (params.frameId === mainFrameId) syncCurrentDocumentUrl(contents);
          return;
        }
        if (!load || (load.done && navigationResult !== 'completed')) return;
        if (method === 'Page.frameStartedNavigating' && load.native && !load.done
          && params.frameId === mainFrameId) {
          load.loaderId = params.loaderId;
          load.frameId = params.frameId;
          load.url = params.url;
          load.sameDocument = ['sameDocument', 'historySameDocument'].includes(params.navigationType);
          retiredLoaders.delete(params.loaderId);
        } else if (method === 'Network.requestWillBeSent' && params.type === 'Document'
          && (!mainFrameId || params.frameId === mainFrameId) && !retiredLoaders.has(params.loaderId)) {
          if (load.native && !load.loaderId && !load.done) {
            load.loaderId = params.loaderId;
            load.frameId = params.frameId;
            load.url = params.request.url;
          }
          // redirectResponse の URL は直前の送信元。再利用される requestId を
          // request.url で更新し、コマンド応答より先に届く最終遷移先も保持する。
          load.requests.set(params.requestId, {
            loaderId: params.loaderId, frameId: params.frameId, url: params.request.url,
          });
        } else if (method === 'Network.loadingFailed') {
          const request = load.requests.get(params.requestId);
          if (request) request.error = new Error(params.canceled ? 'ERR_ABORTED' : params.errorText);
        } else if (method === 'Network.responseReceived' && params.type === 'Document') {
          // WebRequest の request id は CDP の requestId と互換ではない。
          if (!load.responses.has(params.loaderId)) load.responses.set(params.loaderId, new Map());
          load.responses.get(params.loaderId).set(params.frameId, params.response);
          load.updateGithub404();
        } else if (method === 'Page.frameNavigated' && !params.frame.parentId) {
          if (!isNavigationUrl(params.frame.url)) return;
          if (load.native && !load.loaderId && params.type === 'BackForwardCacheRestore') {
            load.loaderId = params.frame.loaderId;
            load.frameId = params.frame.id;
            retiredLoaders.delete(load.loaderId);
          }
          if (retiredLoaders.has(params.frame.loaderId)) return;
          if (load.loaderId && load.loaderId !== params.frame.loaderId) return;
          load.commits.set(params.frame.loaderId, {
            frameId: params.frame.id, url: params.frame.url + (params.frame.urlFragment || ''),
          });
          if (load.native && params.type === 'BackForwardCacheRestore') {
            load.loaded.set(params.frame.loaderId, params.frame.id);
          }
        } else if (method === 'Page.lifecycleEvent' && params.name === 'load') {
          if (retiredLoaders.has(params.loaderId)) return;
          if (load.loaderId && load.loaderId !== params.loaderId) return;
          load.loaded.set(params.loaderId, params.frameId);
        } else return;
        load.completeIfLoaded();
      });
      contents.debugger?.on('detach', () => {
        debuggerAvailable = false;
        if (!activeLoad?.help) activeLoad?.finish?.(new Error('Navigation debugger detached'));
      });

      contents.on('will-navigate', event => {
        if (!isNavigationUrl(event.url)) { event.preventDefault(); return; }
        // back/forward が起こす will-navigate は action() で開始済みの操作に属する。
        // ここで置き換えると custom scheme から戻る際の did-stop 補完が失われる。
        if (activeLoad?.native && !activeLoad.done
          && (activeLoad.acceptsHistoryUrl(event.url)
            || (isHelpUrl(activeLoad.historyTarget) && isHelpUrl(event.url)))) return;
        if (activeLoad?.syntheticHelpBack && !activeLoad.done && activeLoad.url === event.url) return;
        helpForwardUrl = '';
        if (isHelpUrl(event.url)) {
          event.preventDefault();
          loadHelp(event.url).catch(() => {});
          return;
        }
        if (!navigationReady) {
          event.preventDefault();
          navigate(event.url, true);
          return;
        }
        // ページ起点の新遷移は既に始まっているので stop しない。
        beginLoad(event.url, true, undefined, { native: true });
      });
      contents.on('will-frame-navigate', event => { if (!isNavigationUrl(event.url)) event.preventDefault(); });
      contents.on('will-redirect', event => {
        if (!isNavigationUrl(event.url)) event.preventDefault();
      });
      contents.on('will-prevent-unload', event => {
        const choice = dialog.showMessageBoxSync(win, { type: 'warning', title: 'このページを離れますか？', message: 'このページを離れますか？', detail: '入力中の内容は保存されない可能性があります。', buttons: ['移動する', 'このページにとどまる'], defaultId: 1, cancelId: 1 });
        if (choice === 0) event.preventDefault();
        else if (!activeLoad?.done && (activeLoad || navigationRequestId === null)) {
          activeLoad?.cancelHelp?.();
          activeLoad?.finish(new Error('ERR_ABORTED'));
        }
      });
      // target="_blank" と window.open は新しいウィンドウを作らず、新しいタブで開く（issue #644）。
      contents.setWindowOpenHandler(({ url: destination, disposition }) => {
        if (isNavigationUrl(destination)) host.openFromPage(tab, destination, disposition);
        return { action: 'deny' };
      });
      contents.on('page-title-updated', (_event, nextTitle) => {
        const value = typeof nextTitle === 'string' ? nextTitle.slice(0, 300) : '';
        if (value === title) return;
        title = value;
        host.sendTabs();
      });
      contents.on('page-favicon-updated', (_event, favicons) => updateFavicon(pickFaviconUrl(favicons)));
      // 別の文書へ移ったら、前のページのタイトルとファビコンを残さない。
      contents.on('did-navigate', () => {
        if (!title && !favicon && !faviconSourceUrl) return;
        title = '';
        updateFavicon('');
      });
      contents.on('did-start-loading', () => publish());
      contents.on('did-stop-loading', () => {
        publish();
        const load = activeLoad;
        const url = contents.getURL();
        // カスタムスキームを含む履歴復帰では did-navigate と CDP lifecycleEvent の
        // どちらも欠ける場合がある。停止時の実文書 URL を最後の確定経路にする。
        if (load?.native && load.historyTarget && !load.done
          && load.acceptsHistoryUrl(url) && isNavigationUrl(url)) load.finish(null, url);
      });
      contents.on('did-navigate', (_event, url) => {
        if (activeLoad?.help && isHelpUrl(url) && contents.getURL() === url) {
          currentUrl = url;
          failedUrl = '';
          publish();
        } else if (activeLoad?.native && activeLoad.historyTarget && !activeLoad.done && activeLoad.acceptsHistoryUrl(url)
          && isNavigationUrl(url) && contents.getURL() === url) {
          // 履歴復帰では CDP の lifecycleEvent が届かないことがあるため、Electron が
          // メイン文書の commit を通知した時点で操作とアドレスを確定する。
          activeLoad.finish(null, url);
        }
      });
      contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
        if (isMainFrame) syncCurrentDocumentUrl(contents);
      });
    }
  }

  // 取得中に別のアイコンへ替わった場合は、古い取得結果を使わない。
  function updateFavicon(url) {
    if (url === faviconSourceUrl) { host.sendTabs(); return; }
    faviconSourceUrl = url;
    favicon = '';
    host.sendTabs();
    if (!url) return;
    Promise.resolve(host.fetchFavicon(url, currentUrl)).then(dataUrl => {
      if (faviconSourceUrl !== url || !view) return;
      favicon = typeof dataUrl === 'string' ? dataUrl : '';
      host.sendTabs();
    }, () => {});
  }

  function initializeNavigation() {
    if (navigationReady) return;
    const contents = view.webContents;
    contents.on('destroyed', () => {
      debuggerAvailable = false;
      activeLoad?.finish?.(new Error('Navigation contents destroyed'));
    });
    const initializeCommand = (method, params) => {
      if (!debuggerAvailable || contents.isDestroyed?.()) return Promise.reject(new Error('Navigation debugger unavailable'));
      return contents.debugger.sendCommand(method, params);
    };
    try {
      // 新規 WebContentsView にはまだ renderer がない。先にローカルの空文書を
      // 作らないと renderer 側の CDP 初期化応答を待ったまま Page.navigate に進めない。
      // 対象 URL は全ドメインの監視準備後にだけ開き、Network の先着イベントも拾う。
      navigationReady = (contents.getURL() ? Promise.resolve() : contents.loadURL('about:blank')).then(() => {
        if (!debuggerAvailable || contents.isDestroyed?.()) throw new Error('Navigation debugger unavailable');
        contents.debugger.attach('1.3');
        return initializeCommand('Page.enable');
      })
        .then(() => initializeCommand('Page.setLifecycleEventsEnabled', { enabled: true }))
        .then(() => initializeCommand('Network.enable'))
        .then(() => initializeCommand('Page.getFrameTree'))
        .then(({ frameTree }) => {
          if (frameTree) mainFrameId = frameTree.frame.id;
          navigationInitialized = true;
        });
      // 初期化中に閉じても未処理の rejection を残さない。
      navigationReady.catch(() => { debuggerAvailable = false; });
    } catch (error) {
      debuggerAvailable = false;
      navigationReady = Promise.reject(error);
      navigationReady.catch(() => {});
    }
  }

  function navigate(url, fromPage = false, requestId, { syntheticHelpBack = false } = {}) {
    if (!(fromPage ? isNavigationUrl(url) : isBrowserUrl(url))) return false;
    if (requestId !== undefined && (!Number.isSafeInteger(requestId) || requestId <= 0)) return false;
    if (isHelpUrl(url)) { loadHelp(url).catch(() => {}); return true; }
    if (!syntheticHelpBack) helpForwardUrl = '';
    ensureView();
    initializeNavigation();
    const load = beginLoad(url, fromPage, requestId, { syntheticHelpBack });
    const contents = view.webContents;
    navigationReady.then(async () => {
      if (activeLoad !== load || load.done) return;
      if (!debuggerAvailable) throw new Error('Navigation debugger unavailable');
      load.started = true;
      downloadCandidates.add(load);
      const result = await contents.debugger.sendCommand('Page.navigate', { url });
      load.downloadResponsePending = false;
      load.downloadConfirmed = result.isDownload === true;
      if (!load.downloadConfirmed) downloadCandidates.delete(load);
      if (activeLoad !== load || load.done) {
        downloadCandidates.delete(load);
        if (result.loaderId) retiredLoaders.add(result.loaderId);
        return;
      }
      load.loaderId = result.loaderId;
      load.frameId = result.frameId;
      if (result.isDownload) { load.finishDownload(); return; }
      if (result.errorText) { load.finish(new Error(result.errorText)); return; }
      // 同一文書内の遷移は loaderId を返さず、コマンド応答時に反映済みとなる。
      if (!result.loaderId) {
        const committedUrl = contents.getURL();
        load.finish(isNavigationUrl(committedUrl) ? null : new Error('Navigation URL unavailable'), committedUrl);
        return;
      }
      load.completeIfLoaded();
    }).catch(error => { downloadCandidates.delete(load); load.finish(error); });
    syncBounds();
    publish();
    return true;
  }

  function navigateFromHelp(url) {
    if (!isNavigationUrl(url) || isHelpUrl(url)) return false;
    ensureView();
    initializeNavigation();
    const contents = view.webContents;
    const load = beginLoad(url, true, undefined, {
      native: true, stopPrevious: true, historyTarget: url, syntheticHelpBack: true,
    });
    load.started = true;
    try {
      Promise.resolve(contents.loadURL(url)).then(() => {
        if (activeLoad !== load || load.done) return;
        const committedUrl = contents.getURL();
        load.finish(isNavigationUrl(committedUrl) ? null : new Error('Navigation URL unavailable'), committedUrl);
      }).catch(error => load.finish(error));
    } catch (error) {
      load.finish(error);
    }
    syncBounds();
    return true;
  }

  function openHelp() { return loadHelp(HELP_URL); }

  function loadHelp(url) {
    if (!isHelpUrl(url)) return false;
    if (isNavigationUrl(currentUrl) && !isHelpUrl(currentUrl)) helpReturnUrl = currentUrl;
    helpForwardUrl = '';
    ensureView();
    const load = beginLoad(url, false, undefined, { help: true });
    const contents = view.webContents;
    const completed = new Promise((resolve, reject) => {
      const cleanup = () => {
        contents.removeListener('did-finish-load', finish);
        contents.removeListener('did-fail-load', fail);
        contents.removeListener('did-stop-loading', stop);
        contents.removeListener('destroyed', destroyed);
        load.cancelHelp = null;
        load.rejectHelp = null;
      };
      const finish = () => {
        if (!load.started || activeLoad !== load || !isHelpUrl(contents.getURL())) return;
        cleanup();
        load.finish(null, contents.getURL());
        resolve(true);
      };
      const rejectLoad = error => {
        cleanup();
        load.finish(error);
        reject(error);
      };
      load.rejectHelp = rejectLoad;
      const fail = (_event, code, description, destination, isMainFrame) => {
        if (!load.started || !isMainFrame || code === -3 || !isHelpUrl(destination) || activeLoad !== load) return;
        rejectLoad(new Error(`Help document load failed (${code}): ${description}`));
      };
      const stop = () => {
        if (!load.started || activeLoad !== load) return;
        if (isHelpUrl(contents.getURL())) finish();
        else rejectLoad(new Error('Help document load interrupted'));
      };
      const destroyed = () => rejectLoad(new Error('Help document webContents destroyed'));
      load.cancelHelp = nextUrl => {
        cleanup();
        // Reopening a committed guide preserves the original wait contract.
        if (isHelpUrl(nextUrl) && isHelpUrl(contents.getURL())) resolve(true);
        else reject(new Error('Help document load interrupted'));
      };
      contents.on('did-finish-load', finish);
      contents.on('did-fail-load', fail);
      contents.on('did-stop-loading', stop);
      contents.on('destroyed', destroyed);
    });
    // Electron may reject the previous loadURL promise on a reload. The guide's
    // main-frame events above decide this operation's result.
    const start = () => {
      if (activeLoad !== load || load.done) return;
      load.started = true;
      try { contents.loadURL(url).catch(() => {}); }
      catch (error) { load.rejectHelp(error); }
    };
    // Do not abort the initial about:blank/CDP handshake with the guide load.
    if (navigationReady && !navigationInitialized) navigationReady.catch(() => {}).then(start);
    else start();
    syncBounds();
    publish();
    return completed;
  }

  function syncCurrentDocumentUrl(contents) {
    if (contents.isDestroyed?.()) return;
    const load = activeLoad;
    const url = contents.getURL();
    const clearedHelpForward = !!helpForwardUrl && !(load?.syntheticHelpBack && !load.done);
    if (clearedHelpForward) helpForwardUrl = '';
    if (load?.help) {
      if (isHelpUrl(url) && load.done) { currentUrl = url; publish(); }
      else if (clearedHelpForward) publish();
      return;
    }
    if (!debuggerAvailable || !load || !isNavigationUrl(url)) {
      if (clearedHelpForward) publish();
      return;
    }
    if (load.native && !load.done && (!load.loaderId || load.sameDocument)) {
      // loader を相関できない履歴補完だけは開始時の対象 URL と照合する。
      // sameDocument の loader が一致する場合は replaceState 後の実 URL を採用する。
      if (load.historyTarget && !load.loaderId && !load.acceptsHistoryUrl(url)) return;
      load.finish(null, url);
    } else if (load.done && url !== currentUrl) {
      // 終了結果とは独立して、残った現在文書の変更を新しい操作として公開する。
      // 両イベントの二重配送は、確定済み URL との比較で抑止する。
      beginLoad(url, true, undefined, { native: true });
      activeLoad.finish(null, url);
    } else if (clearedHelpForward) publish();
  }

  function beginLoad(url, fromPage, requestId, {
    native = false, stopPrevious = !native, help = false, historyTarget = '', syntheticHelpBack = false,
  } = {}) {
    const previous = supersedeNavigation(url);
    // アプリが次の遷移を開始する場合だけ、旧ロードを事前に止める。
    if (stopPrevious && previous?.started && !previous.done) view.webContents.stop?.();
    failedUrl = ''; github404Url = ''; downloadUrl = '';
    pendingUrl = fromPage ? '' : url;
    navigationRequestId = fromPage ? null : requestId ?? null;
    // 画面が古い通知を捨てる判定に使うため、番号はタブ全体で通しにする。
    navigationOperationId = host.nextOperationId();
    const contents = view.webContents;
    const load = {
      url, sourceUrl: currentUrl, downloadSourceUrl: url, native, help, historyTarget, syntheticHelpBack,
      done: false, started: native,
      downloadResponsePending: !native && !help,
      downloadAmbiguous: !!previous && normalizeDownloadUrl(previous.downloadSourceUrl) === normalizeDownloadUrl(url)
        && previous.started && !previous.noticeReceived
        && (previous.downloadResponsePending || previous.downloadConfirmed),
      commits: new Map(), loaded: new Map(),
      requests: new Map(), responses: new Map(),
    };
    load.canOpenDownloadFromToolbar = !fromPage && requestId !== undefined && !load.downloadAmbiguous;
    load.acceptsHistoryUrl = candidate => !load.historyTarget || candidate === load.historyTarget;
    activeLoad = load;
    load.flushDownloadNotice = canOpenFromToolbar => {
      if (!load.pendingDownloadNotice) return;
      load.pendingDownloadNotice = false;
      sendDownloadNotice(canOpenFromToolbar);
    };
    load.updateGithub404 = () => {
      if (activeLoad !== load || !documentLoaderId) return;
      const isCurrentDocument = load.loaderId === documentLoaderId && load.frameId === mainFrameId;
      if (!isCurrentDocument && !(load.done && navigationResult === 'completed' && !load.loaderId)) return;
      const response = load.responses.get(documentLoaderId)?.get(mainFrameId);
      if (!response) return;
      const { status, url: responseUrl } = response;
      const next404Url = status === 404 && isNavigationUrl(responseUrl)
        && new URL(responseUrl).hostname === 'github.com' ? responseUrl : '';
      document404Url = next404Url;
      if (github404Url !== next404Url) { github404Url = next404Url; publish(); }
    };
    load.finish = (error, committedUrl) => {
      if (activeLoad !== load || load.done) return;
      if (!error && !isNavigationUrl(committedUrl)) error = new Error('Navigation URL unavailable');
      load.done = true;
      downloadCandidates.delete(load);
      pendingUrl = '';
      if (error) {
        navigationResult = error.message.includes('ERR_ABORTED') ? 'cancelled' : 'failed';
        if (navigationResult === 'failed') {
          const destination = load.documentRequest()?.url || load.url;
          failedUrl = isNavigationUrl(destination) ? destination : '';
        }
      } else {
        currentUrl = committedUrl;
        if (load.help || (load.historyTarget && !load.loaderId
          && !isSameDocumentUrl(load.sourceUrl, committedUrl))) {
          documentLoaderId = null;
          document404Url = '';
        }
        if (!load.loaderId || load.sameDocument) github404Url = document404Url;
        failedUrl = '';
        navigationResult = 'completed';
      }
      publish();
      load.flushDownloadNotice(false);
    };
    load.finishDownload = () => {
      if (activeLoad !== load || load.done) return;
      load.done = true;
      downloadCandidates.delete(load);
      downloadUrl = load.canOpenDownloadFromToolbar ? load.downloadSourceUrl : '';
      pendingUrl = '';
      navigationResult = 'download-blocked';
      publish();
      load.flushDownloadNotice(load.canOpenDownloadFromToolbar);
    };
    // loader とメインフレームの両方が確定するまで、先着イベントを採用しない。
    // download 候補照合・完了 URL にはこの暫定文書 URL を使わない。
    load.documentRequest = () => {
      if (!load.loaderId || load.frameId !== mainFrameId) return null;
      return [...load.requests.values()].reverse().find(request => request.loaderId === load.loaderId
        && request.frameId === load.frameId && isNavigationUrl(request.url));
    };
    load.completeIfLoaded = () => {
      if (activeLoad !== load || !load.loaderId) return;
      const request = load.documentRequest();
      // Page.navigate の応答前の ERR_ABORTED は download の可能性もある。
      if (request?.error && (load.native || !load.downloadResponsePending)) {
        load.finish(request.error); return;
      }
      const commit = load.commits.get(load.loaderId);
      if (!commit || commit.frameId !== load.frameId) return;
      mainFrameId = load.frameId;
      if (documentLoaderId !== load.loaderId) document404Url = '';
      documentLoaderId = load.loaderId;
      load.updateGithub404();
      if (load.loaded.get(load.loaderId) === load.frameId) {
        // load 前の canonical/hash 更新を現在の文書から確定する。旧イベント URL は使わない。
        const actualUrl = contents.getURL();
        load.finish(null, isNavigationUrl(actualUrl) ? actualUrl : commit.url);
      }
    };
    publish();
    if (!help && !debuggerAvailable) load.finish(new Error('Navigation debugger unavailable'));
    return load;
  }

  function action(name) {
    if (!view || view.webContents.isDestroyed?.()) return false;
    const history = view.webContents.navigationHistory;
    if (name === 'back') {
      // The guide is loaded through loadURL, so Electron's active history index
      // can lag after several same-document and cross-document Back operations.
      // At the guide base, use the page captured when the guide was opened.
      if (canUseHelpReturn()) {
        const forwardUrl = currentUrl;
        helpForwardUrl = forwardUrl;
        const started = navigateFromHelp(helpReturnUrl);
        if (!started) helpForwardUrl = '';
        return started;
      }
      if (history.canGoBack()) {
        const target = getHistoryTarget(history, -1);
        if (target !== null) {
          const historyTarget = target?.url || '';
          beginLoad(historyTarget || currentUrl, true, undefined, { native: true, stopPrevious: true, historyTarget });
          moveHistory(history, 'goBack', target);
          return true;
        }
      }
      return false;
    } else if (name === 'forward') {
      if (history.canGoForward()) {
        const target = getHistoryTarget(history, 1);
        if (target !== null) {
          const historyTarget = target?.url || '';
          beginLoad(historyTarget || currentUrl, true, undefined, { native: true, stopPrevious: true, historyTarget });
          moveHistory(history, 'goForward', target);
          return true;
        }
      }
      if (!canUseHelpForward()) return false;
      const url = helpForwardUrl;
      loadHelp(url).catch(() => {});
      return true;
    } else if (name === 'reload') {
      // 初期化待ちの要求を native reload で置換すると Page.navigate が失われる。
      // HTTP(S) 文書がまだない間は元の URL と Enter の requestId を保持して拒否する。
      if (failedUrl) {
        if (!isNavigationUrl(failedUrl)) return false;
        if (isHelpUrl(failedUrl)) { loadHelp(failedUrl).catch(() => {}); return true; }
        return navigate(failedUrl, true);
      }
      if (isHelpUrl(currentUrl)) { loadHelp(currentUrl).catch(() => {}); return true; }
      if (!isNavigationUrl(currentUrl)) return false;
      beginLoad(currentUrl, true, undefined, { native: true, stopPrevious: true });
      view.webContents.reload();
    } else return false;
    return true;
  }

  function canUseHelpReturn() {
    return currentUrl === HELP_URL && isNavigationUrl(helpReturnUrl) && !isHelpUrl(helpReturnUrl);
  }

  function canUseHelpForward() {
    return isHelpUrl(helpForwardUrl) && currentUrl === helpReturnUrl;
  }

  function getHistoryTarget(history, offset) {
    try {
      const entries = history.getAllEntries?.();
      const activeIndex = history.getActiveIndex?.();
      if (!Number.isInteger(activeIndex) || !Array.isArray(entries)) return undefined;
      const activeUrl = entries[activeIndex]?.url;
      if (typeof activeUrl !== 'string') return undefined;
      const documentUrl = view?.webContents.getURL?.();
      const referenceUrl = isNavigationUrl(documentUrl) ? documentUrl : activeUrl;
      let index = activeIndex + offset;
      if (!entries[index]) return undefined;
      while (entries[index]?.url === referenceUrl) index += offset;
      const url = entries[index]?.url;
      return isNavigationUrl(url) ? { url, index, adjacentIndex: activeIndex + offset } : undefined;
    } catch (_error) {
      return undefined;
    }
  }

  function canMoveHistory(history, offset, fallbackMethod) {
    const target = getHistoryTarget(history, offset);
    return target === undefined ? history[fallbackMethod]() : !!target;
  }

  function moveHistory(history, method, target) {
    if (target && target.index !== target.adjacentIndex && typeof history.goToIndex === 'function') {
      history.goToIndex(target.index);
    } else {
      history[method]();
    }
  }

  // タブを代表する URL。読み込み中なら読み込み先、失敗なら失敗先、それ以外は表示中の URL。
  function getTabUrl() {
    return pendingUrl || failedUrl || currentUrl;
  }

  function isEmpty() {
    return !currentUrl && !pendingUrl && !failedUrl && !downloadUrl && !(activeLoad && !activeLoad.done);
  }

  function destroy() {
    faviconSourceUrl = '';
    activeLoad?.cancelHelp?.();
    activeLoad?.flushDownloadNotice(false);
    downloadCandidates.clear();
    activeLoad = null;
    if (!view) return;
    debuggerAvailable = false;
    host.releaseView(view);
    if (!view.webContents.isDestroyed?.()) view.webContents.close({ waitForBeforeUnload: false });
    view = null;
  }

  const tab = {
    id,
    navigate, openHelp, action, destroy, publish, handleDownload,
    externalUrl(source) {
      if (source !== 'current' && source !== 'failed') return null;
      const url = source === 'failed' ? failedUrl : (downloadUrl || currentUrl);
      if (!isHelpUrl(url)) return null;
      if (!isSafeHelpDocument(helpDocumentPath)) return null;
      return pathToFileURL(helpDocumentPath).href + new URL(url).hash;
    },
    getView() { return view; },
    /**
     * タブの行に出す情報。url はタブを代表する URL（getTabUrl）。
     *
     * @returns {object} { id, title, url, favicon, loading, empty }
     */
    getSummary() {
      const contents = view?.webContents;
      const available = contents && !contents.isDestroyed?.();
      return {
        id, title, favicon,
        url: getTabUrl(),
        loading: !!available && contents.isLoading(),
        empty: isEmpty(),
      };
    },
    // 一度も開いていない新規タブか（読み込み中・失敗・ダウンロードの停止を含めて何も起きていない）。
    isEmpty,
    /**
     * 「アプリ内で開く」の対象と、タブを代表する URL（getTabUrl）が同じページか。
     *
     * @param {string} key toTabMatchKey で作った比較用の文字列
     * @returns {boolean} 同じページか
     */
    matchesUrl(key) {
      return !!key && toTabMatchKey(getTabUrl()) === key;
    },
    ownsContents(contents) { return !!contents && contents === view?.webContents; },
    hasDownloadCandidate(urls) { return findDownloadCandidates(urls).length > 0; },
  };
  return tab;
}

/**
 * アプリ内ブラウザ全体（タブの一覧と並び・選んでいるタブ・表示位置・表示可否・モーダル数）を管理する。
 * セッション単位の検査（権限・リクエスト・ダウンロード）はここで 1 回だけ設定する。
 * 作成時にタブを 1 つ作って選んだ状態にする。tabId を省略した操作は選んでいるタブが対象になる。
 * タブは常に 1 つ以上あり、最後のタブを閉じると空の新しいタブ 1 つに置き換える。
 *
 * @param {object} win 親の BrowserWindow
 * @param {object} deps Electron の依存（WebContentsView・session・dialog）と案内ファイルのパス。
 *   fetchFavicon はファビコンの取得（省略時はアプリ内ブラウザのセッションで取得する）
 * @returns {object} アプリ内ブラウザの操作
 */
function createInternalBrowser(win, { WebContentsView, session, dialog, helpDocumentPath = null, fetchFavicon = null } = electron) {
  const browserSession = session.fromPartition(PARTITION);
  browserSession.setPermissionRequestHandler((_contents, permission, callback) => callback(isAllowedBrowserPermission(permission)));
  browserSession.setPermissionCheckHandler((_contents, permission) => isAllowedBrowserPermission(permission));
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: details.resourceType === 'mainFrame' && !isNavigationUrl(details.url) });
  });
  const tabs = new Map();
  // 画面のタブの行と同じ並び（左から）。
  const tabOrder = [];
  let activeTab = null;
  let nextTabId = 1;
  let navigationOperationId = 0;
  let attachedView = null;
  let bounds = null;
  let visible = false;
  let modalCount = 0;
  let lastTabsPayload = '';
  let destroyed = false;
  // 同じアイコンを読み直さないよう、取得結果を少数だけ覚えておく（古いものから捨てる）。
  const faviconCache = new Map();
  const FAVICON_CACHE_LIMIT = 64;
  // 名前解決した後のアドレスを確かめ、そのアドレスに固定して接続するため、セッションの fetch ではなく専用の取得処理を使う。
  const loadFavicon = fetchFavicon || ((url, pageUrl) => fetchFaviconDataUrl(url, { pageUrl }));

  const host = {
    win, WebContentsView, dialog, helpDocumentPath,
    nextOperationId: () => ++navigationOperationId,
    // 画面はタブの一覧の通知で表示するタブを切り替えるため、一覧を状態より先に送る。
    sendState(tab, state) {
      sendTabs();
      if (!win.isDestroyed()) win.webContents.send('internal-browser:state', { ...state, tabId: tab.id, active: tab === activeTab });
    },
    sendDownloadNotice(tab, canOpenFromToolbar) {
      if (!win.isDestroyed()) win.webContents.send('internal-browser:download-blocked', { canOpenFromToolbar, tabId: tab.id, active: tab === activeTab });
    },
    syncBounds,
    releaseView(view) {
      if (attachedView !== view) return;
      win.contentView.removeChildView(view);
      attachedView = null;
    },
    openFromPage,
    sendTabs,
    fetchFavicon(url, pageUrl) {
      // 取得してよいかは、覚えた結果を使う場合も含めて毎回ページとの関係で確かめる。
      if (!isAllowedFaviconTarget(url, pageUrl)) return Promise.resolve('');
      if (faviconCache.has(url)) return faviconCache.get(url);
      const request = Promise.resolve(loadFavicon(url, pageUrl)).catch(() => '');
      faviconCache.set(url, request);
      if (faviconCache.size > FAVICON_CACHE_LIMIT) faviconCache.delete(faviconCache.keys().next().value);
      // 取得に失敗したアイコンは覚えず、次に知らされたときに取り直す。
      request.then(dataUrl => { if (!dataUrl && faviconCache.get(url) === request) faviconCache.delete(url); });
      return request;
    },
  };

  function detachView() {
    const view = attachedView;
    const restoreFocus = !view.webContents.isDestroyed?.() && view.webContents.isFocused();
    win.contentView.removeChildView(view);
    attachedView = null;
    if (restoreFocus && win.isFocused()) win.webContents.focus();
  }

  function syncBounds() {
    const view = activeTab?.getView();
    // 選んでいないタブのページは画面に付けない。
    if (attachedView && attachedView !== view) detachView();
    if (!view || view.webContents.isDestroyed?.()) return;
    // 0 サイズでも描画が残るため、非表示時は親ビューから外す。
    if (!visible || modalCount > 0 || !bounds) {
      if (attachedView) detachView();
      return;
    }
    view.setBounds(bounds);
    if (!attachedView) { win.contentView.addChildView(view); attachedView = view; }
  }

  /**
   * タブの一覧（並び順・タイトル・ファビコン・読み込み中）と選んでいるタブを画面へ送る。
   * 前回と同じ内容なら送らない。
   */
  function getTabsState() {
    return {
      tabs: tabOrder.map(id => tabs.get(id).getSummary()),
      activeTabId: activeTab?.id ?? null,
      maxTabs: MAX_TABS,
    };
  }

  function sendTabs() {
    if (destroyed || win.isDestroyed()) return;
    const payload = getTabsState();
    const serialized = JSON.stringify(payload);
    if (serialized === lastTabsPayload) return;
    lastTabsPayload = serialized;
    win.webContents.send('internal-browser:tabs', payload);
  }

  // ダウンロードはセッション単位でしか検査できないため、配送元のページからタブを特定して渡す。
  const seenDownloadItems = new WeakSet();
  const cancelDownload = (event, item, contents) => {
    event.preventDefault();
    // 同じ DownloadItem の再配送で live 通知を重ねない。
    if (item && seenDownloadItems.has(item)) return;
    if (item) seenDownloadItems.add(item);
    const chain = item?.getURLChain?.() || [];
    const urls = chain.map(normalizeDownloadUrl).filter(Boolean);
    let owner = null;
    if (contents) owner = [...tabs.values()].find(tab => tab.ownsContents(contents)) || null;
    else {
      // 配送元のページが分からないときは、URL が一致する操作を持つタブが 1 つだけならそのタブとする。
      const matched = [...tabs.values()].filter(tab => tab.hasDownloadCandidate(urls));
      if (matched.length === 1) owner = matched[0];
    }
    const target = owner || activeTab;
    if (!target) return;
    target.handleDownload(urls, !!contents && !owner);
  };
  browserSession.on('will-download', cancelDownload);

  /**
   * タブを 1 つ作って一覧に足す（選びはしない）。上限に達しているときは作らない。
   * タブの一覧は、このあと選ぶ・開く処理の中で送る（前に出すタブが後ろに開いたように一瞬見える通知を送らない）。
   *
   * @param {object} [options]
   * @param {number} [options.afterTabId] このタブのすぐ右に置く（省略時は末尾）
   * @returns {number|null} 作ったタブの番号（上限のときは null）
   */
  function addTab({ afterTabId } = {}) {
    if (tabs.size >= MAX_TABS) return null;
    const id = nextTabId++;
    tabs.set(id, createBrowserTab(id, host));
    const index = afterTabId === undefined ? -1 : tabOrder.indexOf(afterTabId);
    if (index < 0) tabOrder.push(id);
    else tabOrder.splice(index + 1, 0, id);
    return id;
  }

  /**
   * 指定したタブを選び、そのタブのページを画面に付け替えて、タブの一覧と状態を送り直す。
   * 画面はタブの一覧の通知で表示するタブを切り替えるため、一覧を状態より先に送る。
   *
   * @param {number} tabId タブ番号
   * @returns {boolean} 選べたか
   */
  function selectTab(tabId) {
    const tab = resolveTab(tabId);
    if (!tab) return false;
    if (tab === activeTab) return true;
    activeTab = tab;
    syncBounds();
    sendTabs();
    tab.publish({ selected: true });
    return true;
  }

  /**
   * 空の新しいタブを末尾に作って選ぶ（タブの行の「＋」）。
   *
   * @returns {number|null} 作ったタブの番号（上限のときは null）
   */
  function newTab() {
    const id = addTab();
    if (id !== null) selectTab(id);
    return id;
  }

  /**
   * タブを閉じる。選んでいるタブを閉じたときは右隣（無ければ左隣）を選ぶ。
   * 最後の 1 つを閉じたときは、空の新しいタブ 1 つに置き換えて closedLast を返す（画面はサイドバーごと閉じる）。
   *
   * @param {number} tabId タブ番号
   * @returns {object|false} { closedLast } または閉じられなかったとき false
   */
  function closeTab(tabId) {
    if (tabId === undefined) return false;
    const tab = resolveTab(tabId);
    if (!tab) return false;
    const nextId = pickTabAfterClose(tabOrder, tab.id);
    tabs.delete(tab.id);
    tabOrder.splice(tabOrder.indexOf(tab.id), 1);
    const wasActive = tab === activeTab;
    if (wasActive) activeTab = null;
    tab.destroy();
    if (nextId === null) {
      selectTab(addTab());
      return { closedLast: true };
    }
    if (wasActive) selectTab(nextId);
    else sendTabs();
    return { closedLast: false };
  }

  /**
   * ペインの URL・issue タイトル・PR ボタンの「アプリ内で開く」。
   * 同じページのタブがあればそのタブを選ぶだけにし（読み込み直さない）、選んでいるタブが空の新規タブならそこに開き、
   * それ以外は新しいタブを末尾に開いて選ぶ。上限に達しているときは開かない。
   *
   * @param {string} url 開く URL（HTTP(S) のみ）
   * @returns {object|false} { result: 'switched' | 'opened' | 'limit', tabId } または受け付けないとき false
   */
  function openUrl(url) {
    if (!isBrowserUrl(url)) return false;
    const key = toTabMatchKey(url);
    const candidates = tabOrder.map(id => tabs.get(id)).filter(tab => tab.matchesUrl(key));
    const matched = candidates.includes(activeTab) ? activeTab : candidates[0];
    if (matched) {
      selectTab(matched.id);
      return { result: 'switched', tabId: matched.id };
    }
    if (activeTab?.isEmpty()) {
      return activeTab.navigate(url) ? { result: 'opened', tabId: activeTab.id } : false;
    }
    const id = addTab();
    if (id === null) return { result: 'limit', tabId: activeTab?.id ?? null };
    selectTab(id);
    tabs.get(id).navigate(url);
    return { result: 'opened', tabId: id };
  }

  /**
   * ページの target="_blank"・window.open の要求を、要求したタブのすぐ右の新しいタブで開く。
   * 上限のときは開かず、要求したタブに上限の案内を送る。
   *
   * @param {object} sourceTab 要求したタブ
   * @param {string} url 開く URL
   * @param {string} disposition Electron の disposition（background-tab なら後ろに開く）
   */
  function openFromPage(sourceTab, url, disposition) {
    if (destroyed || tabs.get(sourceTab.id) !== sourceTab) return;
    const id = addTab({ afterTabId: sourceTab.id });
    if (id === null) {
      if (!win.isDestroyed()) win.webContents.send('internal-browser:tab-limit', { tabId: sourceTab.id, url, active: sourceTab === activeTab });
      return;
    }
    if (shouldForegroundOpenedTab(disposition)) selectTab(id);
    // HTTP(S) は読み込み先を URL 欄に出す通常の開き方、組み込みの案内ページはページ起点の開き方にする。
    tabs.get(id).navigate(url, !isBrowserUrl(url));
  }

  /**
   * tabId から対象のタブを引く。省略時は選んでいるタブ、不正・未知の番号は null。
   *
   * @param {number|undefined} tabId タブ番号
   * @returns {object|null} タブ
   */
  function resolveTab(tabId) {
    if (tabId === undefined) return activeTab;
    if (!Number.isSafeInteger(tabId) || tabId <= 0) return null;
    return tabs.get(tabId) || null;
  }

  function destroy() {
    destroyed = true;
    browserSession.removeListener('will-download', cancelDownload);
    for (const tab of tabs.values()) tab.destroy();
  }

  activeTab = tabs.get(addTab());

  return {
    navigate(url, fromPage = false, requestId, { tabId } = {}) {
      const tab = resolveTab(tabId);
      return tab ? tab.navigate(url, fromPage, requestId) : false;
    },
    openHelp({ tabId } = {}) {
      const tab = resolveTab(tabId);
      return tab ? tab.openHelp() : false;
    },
    action(name, { tabId } = {}) {
      const tab = resolveTab(tabId);
      return tab ? tab.action(name) : false;
    },
    externalUrl(source, { tabId } = {}) {
      const tab = resolveTab(tabId);
      return tab ? tab.externalUrl(source) : null;
    },
    publish({ tabId } = {}) { resolveTab(tabId)?.publish(); },
    addTab(options) {
      const id = addTab(options);
      if (id !== null) sendTabs();
      return id;
    },
    selectTab,
    newTab,
    closeTab,
    openUrl,
    // 画面の起動時に、その時点のタブの一覧を渡す（作成時の通知は画面の読み込み前で届かないため）。
    getTabsState,
    getTabIds() { return [...tabOrder]; },
    getActiveTabId() { return activeTab?.id ?? null; },
    destroy,
    setBounds(rect) { bounds = validateBrowserBounds(rect, win.getContentBounds()); syncBounds(); return !!bounds; },
    setVisible(value) { visible = value === true; syncBounds(); },
    setModalCount(value) { if (!Number.isInteger(value) || value < 0) return; modalCount = value; syncBounds(); },
  };
}

module.exports = { createInternalBrowser, createBrowserTab };
