'use strict';

const electron = require('electron');
const { pathToFileURL } = require('node:url');
const { isSafeHelpDocument } = require('./helpFeature');
const { PARTITION, HELP_URL, isHelpUrl, validateBrowserBounds, isBrowserUrl, isNavigationUrl } = require('./internalBrowserPolicy');

function createInternalBrowser(win, { WebContentsView, session, dialog, helpDocumentPath = null } = electron) {
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
  const cancelDownload = (event, item) => {
    event.preventDefault();
    // 保留中の遷移と異なるダウンロードへ古い URL を渡さない。
    let matchesPendingUrl = false;
    try {
      const originalUrl = item.getURLChain?.()[0] || item.getURL?.();
      matchesPendingUrl = isBrowserUrl(pendingUrl) && new URL(originalUrl).href === new URL(pendingUrl).href;
    } catch {}
    downloadUrl = matchesPendingUrl ? pendingUrl : '';
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
        if (restoreFocus && win.isFocused()) win.webContents.focus();
      }
      return;
    }
    view.setBounds(bounds);
    if (!attached) { win.contentView.addChildView(view); attached = true; }
  }

  function openHelp() { return isHelpUrl(HELP_URL) ? loadPage(HELP_URL, { waitForLoad: true }) : false; }

  function navigate(url) { return isBrowserUrl(url) ? loadPage(url) : false; }

  function loadPage(url, { fromPage = false, waitForLoad = false } = {}) {
    if (fromPage && !isNavigationUrl(url)) return false;
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
        if (isNavigationUrl(destination)) loadPage(destination, { fromPage: true });
        return { action: 'deny' };
      });
      contents.on('did-start-loading', publish);
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
    const contents = view.webContents;
    let completed;
    if (waitForLoad) {
      // 前ページの中断で loadURL が拒否されても、案内自身の結果だけを待つ。
      completed = new Promise((resolve, reject) => {
        const cleanup = () => {
          contents.removeListener('did-finish-load', finish);
          contents.removeListener('did-fail-load', fail);
          contents.removeListener('did-stop-loading', stop);
          contents.removeListener('destroyed', destroyed);
        };
        const finish = () => {
          if (!isHelpUrl(contents.getURL())) return;
          cleanup();
          resolve(true);
        };
        const fail = (_event, code, description, destination, isMainFrame) => {
          // 再読み込みによる中断は新しい案内の失敗ではない。
          if (!isMainFrame || code === -3 || !isHelpUrl(destination)) return;
          cleanup();
          reject(new Error(`Help document load failed (${code}): ${description}`));
        };
        const stop = () => {
          // 確定前の割り込みでは失敗イベントが来ないため、停止時の URL で待機を終える。
          if (isHelpUrl(contents.getURL())) finish();
          else {
            cleanup();
            reject(new Error('Help document load interrupted'));
          }
        };
        const destroyed = () => {
          cleanup();
          reject(new Error('Help document webContents destroyed'));
        };
        contents.on('did-finish-load', finish);
        contents.on('did-fail-load', fail);
        contents.on('did-stop-loading', stop);
        contents.on('destroyed', destroyed);
      });
    }
    contents.loadURL(url).catch(() => {});
    syncBounds();
    publish();
    return completed || true;
  }

  function action(name) {
    if (!view) return false;
    const history = view.webContents.navigationHistory;
    if (name === 'back' && history.canGoBack()) history.goBack();
    else if (name === 'forward' && history.canGoForward()) history.goForward();
    else if (name === 'reload') {
      if (failedUrl) return loadPage(failedUrl, { fromPage: true });
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
    navigate, openHelp, action, destroy,
    externalUrl(source) {
      if (source !== 'current' && source !== 'failed') return null;
      const url = source === 'failed' ? failedUrl : (downloadUrl || currentUrl);
      if (!isHelpUrl(url)) return null;
      if (!isSafeHelpDocument(helpDocumentPath)) return null;
      return pathToFileURL(helpDocumentPath).href + new URL(url).hash;
    },
    setBounds(rect) { bounds = validateBrowserBounds(rect, win.getContentBounds()); syncBounds(); return !!bounds; },
    setVisible(value) { visible = value === true; syncBounds(); },
    setModalCount(value) { if (!Number.isInteger(value) || value < 0) return; modalCount = value; syncBounds(); },
    publish,
  };
}

module.exports = { createInternalBrowser };
