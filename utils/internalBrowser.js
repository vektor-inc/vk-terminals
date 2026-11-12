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
  const cancelDownload = (event) => {
    event.preventDefault();
    // アプリから開いた読み込みだけを外部ブラウザへ渡す。ページ内リンクは表示中の URL を使う。
    downloadUrl = isBrowserUrl(pendingUrl) ? pendingUrl : '';
    pendingUrl = '';
    publish();
    if (!win.isDestroyed()) win.webContents.send('internal-browser:download-blocked');
  };
  browserSession.on('will-download', cancelDownload);

  function publish() {
    if (!win.isDestroyed()) win.webContents.send('internal-browser:state', {
      url: currentUrl,
      pendingUrl,
      downloadUrl,
      failedUrl,
      github404Url,
      loading: !!view && view.webContents.isLoading(),
      canGoBack: !!view && view.webContents.navigationHistory.canGoBack(),
      canGoForward: !!view && view.webContents.navigationHistory.canGoForward(),
    });
  }

  function syncBounds() {
    if (!view) return;
    // 0 サイズでも描画が残るため、非表示時は親ビューから外す。
    if (!visible || modalCount > 0 || !bounds) {
      if (attached) {
        const restoreFocus = view.webContents.isFocused();
        win.contentView.removeChildView(view);
        attached = false;
        if (restoreFocus) win.webContents.focus();
      }
      return;
    }
    view.setBounds(bounds);
    if (!attached) { win.contentView.addChildView(view); attached = true; }
  }

  function navigate(url, fromPage = false) {
    if (!(fromPage ? isNavigationUrl(url) : isBrowserUrl(url))) return false;
    if (!view) {
      view = new WebContentsView({ webPreferences: {
        partition: PARTITION, sandbox: true, nodeIntegration: false, contextIsolation: true,
        webSecurity: true, allowRunningInsecureContent: false,
      } });
      const contents = view.webContents;
      contents.on('will-navigate', event => { if (!isNavigationUrl(event.url)) event.preventDefault(); });
      contents.on('will-frame-navigate', event => { if (!isNavigationUrl(event.url)) event.preventDefault(); });
      contents.on('will-redirect', event => { if (!isNavigationUrl(event.url)) event.preventDefault(); });
      contents.on('will-prevent-unload', event => {
        const choice = dialog.showMessageBoxSync(win, { type: 'warning', title: 'このページを離れますか？', message: 'このページを離れますか？', detail: '入力中の内容は保存されない可能性があります。', buttons: ['移動する', 'このページにとどまる'], defaultId: 1, cancelId: 1 });
        if (choice === 0) event.preventDefault();
        else { pendingUrl = ''; publish(); }
      });
      contents.setWindowOpenHandler(({ url: destination }) => {
        if (isNavigationUrl(destination)) navigate(destination, true);
        return { action: 'deny' };
      });
      contents.on('did-start-loading', () => { downloadUrl = ''; publish(); });
      contents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
        if (!isMainFrame || isInPlace) return;
        failedUrl = '';
        github404Url = '';
        downloadUrl = '';
        publish();
      });
      contents.on('did-stop-loading', publish);
      contents.on('did-navigate', (_event, url) => {
        currentUrl = url;
        pendingUrl = '';
        failedUrl = '';
        if (url !== github404Url) github404Url = '';
        publish();
      });
      contents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) { currentUrl = url; publish(); } });
      contents.on('did-fail-load', (_event, code, _description, destination, isMainFrame) => {
        if (isMainFrame && code !== -3) {
          pendingUrl = '';
          failedUrl = destination;
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
    failedUrl = '';
    github404Url = '';
    downloadUrl = '';
    pendingUrl = fromPage ? '' : url;
    view.webContents.loadURL(url).catch(() => {});
    syncBounds();
    publish();
    return true;
  }

  function action(name) {
    if (!view) return false;
    const history = view.webContents.navigationHistory;
    if (name === 'back' && history.canGoBack()) history.goBack();
    else if (name === 'forward' && history.canGoForward()) history.goForward();
    else if (name === 'reload') {
      if (failedUrl) return navigate(failedUrl, true);
      github404Url = '';
      view.webContents.reload();
      publish();
    }
    else return false;
    return true;
  }

  function destroy() {
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
