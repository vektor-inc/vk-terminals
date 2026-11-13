'use strict';

const electron = require('electron');
const { PARTITION, validateBrowserBounds, isBrowserUrl, isNavigationUrl } = require('./internalBrowserPolicy');

function createInternalBrowser(win, { WebContentsView, session, dialog } = electron) {
  const browserSession = session.fromPartition(PARTITION);
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: details.resourceType === 'mainFrame' && !isNavigationUrl(details.url) });
  });
  let view = null;
  let attached = false;
  let bounds = null;
  let visible = false;
  let modalCount = 0;
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
  const retiredLoaders = new Set();
  let debuggerAvailable = true;
  // Electron 44.3 の loadURL Promise も ID のないイベントを監視するため、
  // CDP Page.navigate が返す loaderId と Page.lifecycleEvent を相関する。
  let activeLoad = null;
  let navigationReady = null;
  // 応答待ちと未配送の download を操作オブジェクトで追跡する。
  const downloadCandidates = new Set();
  const seenDownloadItems = new WeakSet();
  const normalizeDownloadUrl = url => {
    try { return new URL(url).href; } catch { return ''; }
  };
  const cancelDownload = (event, item, contents) => {
    event.preventDefault();
    // 同じ DownloadItem の再配送で live 通知を重ねない。
    if (item && seenDownloadItems.has(item)) return;
    if (item) seenDownloadItems.add(item);
    const chain = item?.getURLChain?.() || [];
    const urls = chain.map(normalizeDownloadUrl).filter(Boolean);
    // native の Page.downloadWillBegin は frameId/guid だけで loaderId がなく、
    // 世代を特定できないため Page.navigate 応答のある操作だけを候補にする。
    const candidates = [...downloadCandidates].filter(load => urls.includes(normalizeDownloadUrl(load.url)));
    const load = candidates.length === 1 ? candidates[0] : null;
    // DownloadItem に loaderId はない。URL は候補の絞り込みだけに使い、
    // 同一 URL の旧コマンドが残る場合は現在操作へ帰属させない。
    if ((contents && contents !== view?.webContents) || !load || load !== activeLoad
      || load.noticeReceived || (load.done && !load.downloadConfirmed)) {
      if (load && (!contents || contents === view?.webContents)) {
        load.noticeReceived = true;
        if (load.downloadConfirmed) downloadCandidates.delete(load);
      }
      sendDownloadNotice(false);
      return;
    }
    load.noticeReceived = true;
    if (load.downloadConfirmed) { downloadCandidates.delete(load); sendDownloadNotice(true); }
    else load.pendingDownloadNotice = true;
  };
  browserSession.on('will-download', cancelDownload);

  function sendDownloadNotice(canOpenFromToolbar) {
    if (!win.isDestroyed()) win.webContents.send('internal-browser:download-blocked', { canOpenFromToolbar });
  }

  function publish() {
    const contents = view?.webContents;
    const available = contents && !contents.isDestroyed?.();
    if (!win.isDestroyed()) win.webContents.send('internal-browser:state', {
      url: currentUrl,
      pendingUrl,
      downloadUrl,
      failedUrl,
      github404Url,
      navigationResult,
      navigationRequestId,
      navigationOperationId,
      loading: !!available && contents.isLoading(),
      canGoBack: !!available && contents.navigationHistory.canGoBack(),
      canGoForward: !!available && contents.navigationHistory.canGoForward(),
    });
  }

  function supersedeNavigation() {
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
    if (previous?.loaderId) retiredLoaders.add(previous.loaderId);
    for (const loaderId of previous?.commits.keys() || []) retiredLoaders.add(loaderId);
    for (const request of previous?.requests.values() || []) retiredLoaders.add(request.loaderId);
    activeLoad = null;
    return previous;
  }

  function syncBounds() {
    if (!view || view.webContents.isDestroyed?.()) return;
    // 0 サイズでも描画が残るため、非表示時は親ビューから外す。
    if (!visible || modalCount > 0 || !bounds) {
      if (attached) {
        const restoreFocus = view.webContents.isFocused();
        win.contentView.removeChildView(view);
        attached = false;
        if (restoreFocus && win.isFocused()) win.webContents.focus();
      }
      return;
    }
    view.setBounds(bounds);
    if (!attached) { win.contentView.addChildView(view); attached = true; }
  }

  function navigate(url, fromPage = false, requestId) {
    if (!(fromPage ? isNavigationUrl(url) : isBrowserUrl(url))) return false;
    if (requestId !== undefined && (!Number.isSafeInteger(requestId) || requestId <= 0)) return false;
    if (!view) {
      view = new WebContentsView({ webPreferences: {
        partition: PARTITION, sandbox: true, nodeIntegration: false, contextIsolation: true,
        webSecurity: true, allowRunningInsecureContent: false,
      } });
      const contents = view.webContents;
      // この専用ビューの CDP 接続は遷移追跡だけに使う。
      const initializeCommand = (method, params) => {
        if (!debuggerAvailable || contents.isDestroyed?.()) return Promise.reject(new Error('Navigation debugger unavailable'));
        return contents.debugger.sendCommand(method, params);
      };
      try {
        contents.debugger.attach('1.3');
        navigationReady = initializeCommand('Page.enable')
          .then(() => initializeCommand('Page.setLifecycleEventsEnabled', { enabled: true }))
          .then(() => initializeCommand('Network.enable'))
          .then(() => initializeCommand('Page.getFrameTree'))
          .then(({ frameTree }) => { if (frameTree) mainFrameId = frameTree.frame.id; });
        // 初期化中に閉じても未処理の rejection を残さない。
        navigationReady.catch(() => { debuggerAvailable = false; });
      } catch (error) {
        debuggerAvailable = false;
        navigationReady = Promise.reject(error);
        navigationReady.catch(() => {});
      }
      contents.debugger.on('message', (_event, method, params) => {
        const load = activeLoad;
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
          load.requests.set(params.requestId, { loaderId: params.loaderId, frameId: params.frameId });
        } else if (method === 'Network.loadingFailed') {
          const request = load.requests.get(params.requestId);
          if (load.native && request && load.loaderId && request.loaderId === load.loaderId && request.frameId === load.frameId) {
            load.finish(new Error(params.canceled ? 'ERR_ABORTED' : params.errorText));
          }
        } else if (method === 'Network.responseReceived' && params.type === 'Document') {
          // WebRequest の request id は CDP の requestId と互換ではない。
          if (!load.responses.has(params.loaderId)) load.responses.set(params.loaderId, new Map());
          load.responses.get(params.loaderId).set(params.frameId, params.response);
          load.updateGithub404();
        } else if (method === 'Page.frameNavigated' && !params.frame.parentId) {
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
        } else if (method === 'Page.navigatedWithinDocument') {
          if (params.frameId !== mainFrameId) return;
          // URL のない Electron イベントではなく、現在文書の URL を読み直す。
          const url = contents.getURL();
          if (!isNavigationUrl(url)) return;
          if (load.native && !load.done && (!load.loaderId || load.sameDocument)) {
            load.finish(null, url);
          } else if (load.done && navigationResult === 'completed' && url !== currentUrl) {
            beginLoad(url, true, undefined, { native: true });
            activeLoad.finish(null, url);
          }
        } else if (method === 'Page.lifecycleEvent' && params.name === 'load') {
          if (retiredLoaders.has(params.loaderId)) return;
          if (load.loaderId && load.loaderId !== params.loaderId) return;
          load.loaded.set(params.loaderId, params.frameId);
        } else return;
        load.completeIfLoaded();
      });
      contents.debugger.on('detach', () => {
        debuggerAvailable = false;
        activeLoad?.finish?.(new Error('Navigation debugger detached'));
      });
      contents.on('destroyed', () => {
        debuggerAvailable = false;
        activeLoad?.finish?.(new Error('Navigation contents destroyed'));
      });
      contents.on('will-navigate', event => {
        if (!isNavigationUrl(event.url)) { event.preventDefault(); return; }
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
          activeLoad?.finish(new Error('ERR_ABORTED'));
        }
      });
      contents.setWindowOpenHandler(({ url: destination }) => {
        if (isNavigationUrl(destination)) navigate(destination, true);
        return { action: 'deny' };
      });
      contents.on('did-start-loading', publish);
      contents.on('did-stop-loading', publish);
      contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
        if (!isMainFrame || !activeLoad || navigationResult !== 'completed') return;
        const url = contents.getURL();
        if (isNavigationUrl(url) && url !== currentUrl) {
          beginLoad(url, true, undefined, { native: true });
          activeLoad.finish(null, url);
        }
      });
    }
    const load = beginLoad(url, fromPage, requestId);
    const contents = view.webContents;
    navigationReady.then(async () => {
      if (activeLoad !== load || load.done) return;
      if (!debuggerAvailable) throw new Error('Navigation debugger unavailable');
      load.started = true;
      downloadCandidates.add(load);
      const result = await contents.debugger.sendCommand('Page.navigate', { url });
      load.downloadConfirmed = result.isDownload === true;
      if (!load.downloadConfirmed) downloadCandidates.delete(load);
      if (activeLoad !== load || load.done) {
        if (load.noticeReceived) downloadCandidates.delete(load);
        if (result.loaderId) retiredLoaders.add(result.loaderId);
        return;
      }
      if (result.isDownload) { load.finishDownload(); return; }
      if (result.errorText) { load.finish(new Error(result.errorText)); return; }
      // 同一文書内の遷移は loaderId を返さず、コマンド応答時に反映済みとなる。
      if (!result.loaderId) {
        const committedUrl = contents.getURL();
        load.finish(isNavigationUrl(committedUrl) ? null : new Error('Navigation URL unavailable'), committedUrl);
        return;
      }
      load.loaderId = result.loaderId;
      load.frameId = result.frameId;
      load.completeIfLoaded();
    }).catch(error => { downloadCandidates.delete(load); load.finish(error); });
    syncBounds();
    publish();
    return true;
  }

  function beginLoad(url, fromPage, requestId, { native = false, stopPrevious = !native } = {}) {
    const previous = supersedeNavigation();
    // アプリが次の遷移を開始する場合だけ、旧ロードを事前に止める。
    if (stopPrevious && previous?.started && !previous.done) view.webContents.stop();
    failedUrl = ''; github404Url = ''; downloadUrl = '';
    pendingUrl = fromPage ? '' : url;
    navigationRequestId = fromPage ? null : requestId ?? null;
    navigationOperationId++;
    const contents = view.webContents;
    const load = {
      url, native, done: false, started: native, commits: new Map(), loaded: new Map(),
      requests: new Map(), responses: new Map(),
    };
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
      load.done = true;
      pendingUrl = '';
      if (error) {
        navigationResult = error.message.includes('ERR_ABORTED') ? 'cancelled' : 'failed';
        if (navigationResult === 'failed') failedUrl = load.url;
      } else {
        currentUrl = committedUrl;
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
      downloadUrl = load.url;
      pendingUrl = '';
      navigationResult = 'download-blocked';
      publish();
      load.flushDownloadNotice(true);
      if (load.noticeReceived) downloadCandidates.delete(load);
    };
    load.completeIfLoaded = () => {
      if (activeLoad !== load || !load.loaderId) return;
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
    if (!debuggerAvailable) load.finish(new Error('Navigation debugger unavailable'));
    return load;
  }

  function action(name) {
    if (!view || view.webContents.isDestroyed?.()) return false;
    const history = view.webContents.navigationHistory;
    if (name === 'back' && history.canGoBack()) {
      beginLoad(currentUrl, true, undefined, { native: true, stopPrevious: true });
      history.goBack();
    } else if (name === 'forward' && history.canGoForward()) {
      beginLoad(currentUrl, true, undefined, { native: true, stopPrevious: true });
      history.goForward();
    } else if (name === 'reload') {
      if (failedUrl) return navigate(failedUrl, true);
      beginLoad(currentUrl, true, undefined, { native: true, stopPrevious: true });
      view.webContents.reload();
    } else return false;
    return true;
  }

  function destroy() {
    activeLoad?.flushDownloadNotice(false);
    downloadCandidates.clear();
    activeLoad = null;
    browserSession.removeListener('will-download', cancelDownload);
    if (!view) return;
    debuggerAvailable = false;
    if (attached) win.contentView.removeChildView(view);
    attached = false;
    if (!view.webContents.isDestroyed?.()) view.webContents.close({ waitForBeforeUnload: false });
    view = null;
  }

  return {
    navigate, action, destroy,
    setBounds(rect) { bounds = validateBrowserBounds(rect, win.getContentBounds()); syncBounds(); return !!bounds; },
    setVisible(value) { visible = value === true; syncBounds(); },
    setModalCount(value) { if (!Number.isInteger(value) || value < 0) return; modalCount = value; syncBounds(); },
    publish,
  };
}

module.exports = { createInternalBrowser };
