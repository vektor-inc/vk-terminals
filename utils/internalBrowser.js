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
  let bounds = null;
  let visible = false;
  let modalCount = 0;
  let currentUrl = '';
  let pendingUrl = '';
  const cancelDownload = (_event, item) => {
    item.cancel();
    if (!win.isDestroyed()) win.webContents.send('internal-browser:download-blocked');
  };
  browserSession.on('will-download', cancelDownload);

  function publish() {
    if (!win.isDestroyed()) win.webContents.send('internal-browser:state', {
      url: currentUrl,
      pendingUrl,
      loading: !!view && view.webContents.isLoading(),
      canGoBack: !!view && view.webContents.navigationHistory.canGoBack(),
      canGoForward: !!view && view.webContents.navigationHistory.canGoForward(),
    });
  }

  function syncBounds() {
    if (!view) return;
    view.setBounds(visible && modalCount === 0 && bounds ? bounds : { x: 0, y: 0, width: 0, height: 0 });
  }

  function navigate(url, fromPage = false) {
    if (!(fromPage ? isNavigationUrl(url) : isBrowserUrl(url))) return false;
    if (!view) {
      view = new WebContentsView({ webPreferences: {
        partition: PARTITION, sandbox: true, nodeIntegration: false, contextIsolation: true,
        webSecurity: true, allowRunningInsecureContent: false,
      } });
      win.contentView.addChildView(view);
      const contents = view.webContents;
      contents.on('will-navigate', event => { if (!isNavigationUrl(event.url)) event.preventDefault(); });
      contents.on('will-frame-navigate', event => { if (!isNavigationUrl(event.url)) event.preventDefault(); });
      contents.on('will-redirect', event => { if (!isNavigationUrl(event.url)) event.preventDefault(); });
      contents.on('will-prevent-unload', event => {
        const choice = dialog.showMessageBoxSync(win, { type: 'warning', title: 'このページを離れますか？', message: '入力中の内容は保存されない可能性があります。', buttons: ['移動する', 'このページにとどまる'], defaultId: 1, cancelId: 1 });
        if (choice === 0) event.preventDefault();
        else { pendingUrl = ''; publish(); }
      });
      contents.setWindowOpenHandler(({ url: destination }) => {
        if (isNavigationUrl(destination)) navigate(destination, true);
        return { action: 'deny' };
      });
      contents.on('did-start-loading', publish);
      contents.on('did-stop-loading', publish);
      contents.on('did-navigate', (_event, url) => { currentUrl = url; pendingUrl = ''; publish(); });
      contents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) { currentUrl = url; publish(); } });
      contents.on('did-fail-load', (_event, code, _description, destination, isMainFrame) => {
        if (isMainFrame && code !== -3) {
          pendingUrl = '';
          if (!win.isDestroyed()) win.webContents.send('internal-browser:error', { url: destination });
          publish();
        }
      });
      browserSession.webRequest.onCompleted((details) => {
        if ((details.webContentsId === contents.id || details.webContents?.id === contents.id) && details.resourceType === 'mainFrame'
          && details.statusCode === 404 && isNavigationUrl(details.url)
          && new URL(details.url).hostname === 'github.com') {
          if (!win.isDestroyed()) win.webContents.send('internal-browser:github-404');
        }
      });
    }
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
    else if (name === 'reload') view.webContents.reload();
    else return false;
    return true;
  }

  function destroy() {
    browserSession.removeListener('will-download', cancelDownload);
    if (!view) return;
    win.contentView.removeChildView(view);
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
