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
  // Electron 44.3 の loadURL Promise も ID のないイベントを監視するため、
  // CDP Page.navigate が返す loaderId と Page.lifecycleEvent を相関する。
  let activeLoad = null;
  let navigationReady = null;
  const cancelDownload = (event, item) => {
    event.preventDefault();
    // 保留中の遷移と異なるダウンロードへ古い URL を渡さない。
    let matchesPendingUrl = false;
    try {
      const originalUrl = item.getURLChain?.()[0] || item.getURL?.();
      matchesPendingUrl = isBrowserUrl(pendingUrl) && new URL(originalUrl).href === new URL(pendingUrl).href;
    } catch {}
    matchesPendingUrl = matchesPendingUrl && activeLoad?.started === true && !activeLoad.done;
    // 同じ URL の旧ダウンロードでも、今回の CDP 応答が download でなければ終了しない。
    if (matchesPendingUrl) {
      activeLoad.downloadNotices++;
      activeLoad.finishDownload();
    } else sendDownloadNotice(false);
  };
  browserSession.on('will-download', cancelDownload);

  function sendDownloadNotice(canOpenFromToolbar) {
    if (!win.isDestroyed()) win.webContents.send('internal-browser:download-blocked', { canOpenFromToolbar });
  }

  function flushDownloadNotices(load, canOpenFromToolbar = false) {
    while (load?.downloadNotices > 0) {
      sendDownloadNotice(canOpenFromToolbar);
      canOpenFromToolbar = false;
      load.downloadNotices--;
    }
  }


  function publish() {
    if (!win.isDestroyed()) win.webContents.send('internal-browser:state', {
      url: currentUrl,
      pendingUrl,
      downloadUrl,
      failedUrl,
      github404Url,
      navigationResult,
      navigationRequestId,
      loading: !!view && view.webContents.isLoading(),
      canGoBack: !!view && view.webContents.navigationHistory.canGoBack(),
      canGoForward: !!view && view.webContents.navigationHistory.canGoForward(),
    });
  }

  function supersedeNavigation() {
    // 別の操作へ切り替える前に、旧 Enter 要求の終了を元の ID で通知する。
    if (navigationRequestId !== null && pendingUrl && navigationResult === null) {
      navigationResult = 'superseded';
      publish();
    }
    navigationRequestId = null;
    navigationResult = null;
    pendingUrl = '';
    const previous = activeLoad;
    flushDownloadNotices(previous);
    activeLoad = null;
    if (previous?.started && !previous.done) view.webContents.stop();
  }

  function syncBounds() {
    if (!view) return;
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
      try {
        contents.debugger.attach('1.3');
        navigationReady = contents.debugger.sendCommand('Page.enable')
          .then(() => contents.debugger.sendCommand('Page.setLifecycleEventsEnabled', { enabled: true }));
      } catch (error) { navigationReady = Promise.reject(error); }
      contents.debugger.on('message', (_event, method, params) => {
        const load = activeLoad;
        if (!load || load.done) return;
        // コマンド応答より先に届くイベントも loader ごとに保持する。
        if (method === 'Page.frameNavigated' && !params.frame.parentId) {
          if (load.loaderId && load.loaderId !== params.frame.loaderId) return;
          load.commits.set(params.frame.loaderId, params.frame.url + (params.frame.urlFragment || ''));
        } else if (method === 'Page.lifecycleEvent' && params.name === 'load') {
          if (load.loaderId && load.loaderId !== params.loaderId) return;
          load.loaded.set(params.loaderId, params.frameId);
        } else return;
        load.completeIfLoaded?.();
      });
      contents.debugger.on('detach', () => {
        activeLoad?.finish?.(new Error('Navigation debugger detached'));
      });
      contents.on('will-navigate', event => {
        if (!isNavigationUrl(event.url)) { event.preventDefault(); return; }
        // will-navigate はページ起点の遷移。redirect は will-redirect として届く。
        supersedeNavigation();
        publish();
      });
      contents.on('will-frame-navigate', event => { if (!isNavigationUrl(event.url)) event.preventDefault(); });
      contents.on('will-redirect', event => {
        if (!isNavigationUrl(event.url)) event.preventDefault();
      });
      contents.on('will-prevent-unload', event => {
        const choice = dialog.showMessageBoxSync(win, { type: 'warning', title: 'このページを離れますか？', message: 'このページを離れますか？', detail: '入力中の内容は保存されない可能性があります。', buttons: ['移動する', 'このページにとどまる'], defaultId: 1, cancelId: 1 });
        if (choice === 0) event.preventDefault();
        else if (!activeLoad?.done && (activeLoad || navigationRequestId === null)) {
          if (activeLoad) activeLoad.done = true;
          pendingUrl = ''; navigationResult = 'cancelled'; publish();
          flushDownloadNotices(activeLoad);
        }
      });
      contents.setWindowOpenHandler(({ url: destination }) => {
        if (isNavigationUrl(destination)) navigate(destination, true);
        return { action: 'deny' };
      });
      contents.on('did-start-loading', publish);
      contents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
        if (!isMainFrame) return;
        // WebContents イベントには遷移 ID がない。アプリ要求は CDP の結果だけで終了する。
        if (activeLoad || navigationRequestId !== null) return;
        navigationResult = null;
        if (isInPlace) { publish(); return; }
        failedUrl = '';
        github404Url = '';
        downloadUrl = '';
        publish();
      });
      contents.on('did-stop-loading', publish);
      contents.on('did-navigate', (_event, url) => {
        if (activeLoad || navigationRequestId !== null) return;
        currentUrl = url;
        pendingUrl = '';
        failedUrl = '';
        navigationResult = 'completed';
        if (url !== github404Url) github404Url = '';
        publish();
      });
      contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
        if (isMainFrame) {
          if (activeLoad || navigationRequestId !== null) {
            // 完了後の pushState/hash 変更は、イベントの URL ではなく現在の文書から読む。
            if (activeLoad?.done && navigationResult === 'completed') {
              const committedUrl = contents.getURL();
              if (isNavigationUrl(committedUrl) && committedUrl !== currentUrl) {
                currentUrl = committedUrl;
                publish();
              }
            }
            return;
          }
          currentUrl = url;
          pendingUrl = ''; navigationResult = 'completed'; publish();
        }
      });
      contents.on('did-fail-load', (_event, code, _description, destination, isMainFrame) => {
        if (isMainFrame && code !== -3) {
          if (activeLoad || navigationRequestId !== null) return;
          pendingUrl = '';
          failedUrl = destination;
          navigationResult = 'failed';
          publish();
        }
      });
      browserSession.webRequest.onCompleted((details) => {
        if ((details.webContentsId === contents.id || details.webContents?.id === contents.id) && details.resourceType === 'mainFrame'
          && details.statusCode === 404 && isNavigationUrl(details.url)
          && new URL(details.url).hostname === 'github.com') {
          github404Url = details.url;
          publish();
        }
      });
    }
    supersedeNavigation();
    failedUrl = '';
    github404Url = '';
    downloadUrl = '';
    pendingUrl = fromPage ? '' : url;
    navigationRequestId = fromPage ? null : requestId ?? null;
    navigationResult = null;
    const load = { url, done: false, started: false, downloadNotices: 0, commits: new Map(), loaded: new Map() };
    activeLoad = load;
    const contents = view.webContents;
    load.finish = (error, committedUrl) => {
      if (activeLoad !== load || load.done) return;
      load.done = true;
      pendingUrl = '';
      if (error) {
        navigationResult = error.message.includes('ERR_ABORTED') ? 'cancelled' : 'failed';
        if (navigationResult === 'failed') failedUrl = load.url;
      } else {
        currentUrl = committedUrl;
        failedUrl = '';
        navigationResult = 'completed';
        if (currentUrl !== github404Url) github404Url = '';
      }
      if (navigationRequestId === null) activeLoad = null;
      publish();
      flushDownloadNotices(load);
    };
    load.finishDownload = () => {
      if (activeLoad !== load || load.done || !load.isDownload || !load.downloadNotices) return;
      load.done = true;
      downloadUrl = load.url;
      pendingUrl = '';
      navigationResult = 'download-blocked';
      // 操作列へ対象 URL を渡した後に、ダウンロードごとに一度だけ通知する。
      publish();
      flushDownloadNotices(load, true);
    };
    load.completeIfLoaded = () => {
      if (load.loaderId && load.loaded.get(load.loaderId) === load.frameId && load.commits.has(load.loaderId)) {
        load.finish(null, load.commits.get(load.loaderId));
      }
    };
    navigationReady.then(async () => {
      if (activeLoad !== load || load.done) return;
      load.started = true;
      const result = await contents.debugger.sendCommand('Page.navigate', { url });
      if (activeLoad !== load || load.done) return;
      if (result.isDownload) { load.isDownload = true; load.finishDownload(); return; }
      if (result.errorText) { load.finish(new Error(result.errorText)); return; }
      // 同一文書内の遷移は loaderId を返さず、コマンド応答時に反映済みとなる。
      if (!result.loaderId) { load.finish(null, contents.getURL()); return; }
      load.loaderId = result.loaderId;
      load.frameId = result.frameId;
      load.completeIfLoaded();
    }).catch(error => load.finish(error));
    syncBounds();
    publish();
    return true;
  }

  function action(name) {
    if (!view) return false;
    const history = view.webContents.navigationHistory;
    if (name === 'back' && history.canGoBack()) { supersedeNavigation(); history.goBack(); publish(); }
    else if (name === 'forward' && history.canGoForward()) { supersedeNavigation(); history.goForward(); publish(); }
    else if (name === 'reload') {
      if (failedUrl) return navigate(failedUrl, true);
      github404Url = '';
      supersedeNavigation();
      view.webContents.reload();
      publish();
    }
    else return false;
    return true;
  }

  function destroy() {
    activeLoad = null;
    browserSession.removeListener('will-download', cancelDownload);
    if (!view) return;
    if (attached) win.contentView.removeChildView(view);
    attached = false;
    view.webContents.close({ waitForBeforeUnload: false });
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
