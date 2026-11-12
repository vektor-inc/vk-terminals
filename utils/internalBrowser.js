'use strict';

const { WebContentsView, session } = require('electron');
const { PARTITION, validateBrowserBounds, isBrowserUrl } = require('./internalBrowserPolicy');

function navigationUrl(detail) {
  return typeof detail === 'string' ? detail : detail?.url;
}

function createInternalBrowser(win) {
  const browserSession = session.fromPartition(PARTITION);
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: details.resourceType === 'mainFrame' && !isBrowserUrl(details.url) });
  });
  let view = null;
  let bounds = null;
  let visible = false;
  let modalCount = 0;
  let currentUrl = '';

  function publish() {
    if (!win.isDestroyed()) win.webContents.send('internal-browser:state', {
      url: currentUrl,
      loading: !!view && view.webContents.isLoading(),
      canGoBack: !!view && view.webContents.navigationHistory.canGoBack(),
      canGoForward: !!view && view.webContents.navigationHistory.canGoForward(),
    });
  }

  function syncBounds() {
    if (!view) return;
    view.setBounds(visible && modalCount === 0 && bounds ? bounds : { x: 0, y: 0, width: 0, height: 0 });
  }

  function navigate(url) {
    if (!isBrowserUrl(url)) return false;
    if (!view) {
      view = new WebContentsView({ webPreferences: {
        partition: PARTITION, sandbox: true, nodeIntegration: false, contextIsolation: true,
        webSecurity: true, allowRunningInsecureContent: false,
      } });
      win.contentView.addChildView(view);
      const contents = view.webContents;
      contents.on('will-navigate', (event, detail) => { if (!isBrowserUrl(navigationUrl(detail || event))) event.preventDefault(); });
      contents.on('will-frame-navigate', event => { if (!isBrowserUrl(navigationUrl(event))) event.preventDefault(); });
      contents.on('will-redirect', (event, detail) => { if (!isBrowserUrl(navigationUrl(detail || event))) event.preventDefault(); });
      contents.setWindowOpenHandler(({ url: destination }) => {
        if (isBrowserUrl(destination)) navigate(destination);
        return { action: 'deny' };
      });
      contents.on('did-start-loading', publish);
      contents.on('did-stop-loading', publish);
      contents.on('did-navigate', (_event, detail) => { currentUrl = navigationUrl(detail) || currentUrl; publish(); });
      contents.on('did-navigate-in-page', (_event, detail) => { currentUrl = navigationUrl(detail) || currentUrl; publish(); });
      contents.on('did-fail-load', (_event, code, _description, destination, isMainFrame) => {
        if (isMainFrame && code !== -3) win.webContents.send('internal-browser:error', { url: destination });
      });
      browserSession.webRequest.onCompleted((details) => {
        if ((details.webContentsId === contents.id || details.webContents?.id === contents.id) && details.resourceType === 'mainFrame'
          && details.statusCode === 404 && isBrowserUrl(details.url)
          && new URL(details.url).hostname === 'github.com') {
          win.webContents.send('internal-browser:github-404');
        }
      });
    }
    currentUrl = url;
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

module.exports = { createInternalBrowser, navigationUrl };
