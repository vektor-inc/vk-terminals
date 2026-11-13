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
  let navigationResult = null;
  let navigationRequestId = null;
  let navigationOperationId = 0;
  let mainFrameId = null;
  let documentLoaderId = null;
  let document404Url = '';
  let helpReturnUrl = '';
  let helpForwardUrl = '';
  const retiredLoaders = new Set();
  let debuggerAvailable = true;
  // Electron 44.3 の loadURL Promise も ID のないイベントを監視するため、
  // CDP Page.navigate が返す loaderId と Page.lifecycleEvent を相関する。
  let activeLoad = null;
  let navigationReady = null;
  let navigationInitialized = false;
  // 応答待ちの現在操作だけを保持し、終了・置換時に解放する。
  const downloadCandidates = new Set();
  const seenDownloadItems = new WeakSet();
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
  const cancelDownload = (event, item, contents) => {
    event.preventDefault();
    // 同じ DownloadItem の再配送で live 通知を重ねない。
    if (item && seenDownloadItems.has(item)) return;
    if (item) seenDownloadItems.add(item);
    const chain = item?.getURLChain?.() || [];
    const urls = chain.map(normalizeDownloadUrl).filter(Boolean);
    // native の Page.downloadWillBegin は frameId/guid だけで loaderId がなく、
    // 世代を特定できないため Page.navigate 応答のある操作だけを候補にする。
    // 終了済み候補は保持せず、現在の結果待ち／確定済み download だけを見る。
    const candidates = [...downloadCandidates, ...(activeLoad?.done && activeLoad.downloadConfirmed ? [activeLoad] : [])]
      .filter(load => urls.includes(normalizeDownloadUrl(load.downloadSourceUrl)));
    const load = candidates.length === 1 ? candidates[0] : null;
    if ((contents && contents !== view?.webContents) || !load || load !== activeLoad
      || load.noticeReceived || load.downloadAmbiguous) {
      // 同一 URL の旧通知と区別できない配送は一般案内として消費する。
      // 現在候補も消費し、次の要求へ曖昧さを持ち越さない。
      if (!contents || contents === view?.webContents) {
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
  };
  browserSession.on('will-download', cancelDownload);

  function sendDownloadNotice(canOpenFromToolbar) {
    if (!win.isDestroyed()) win.webContents.send('internal-browser:download-blocked', { canOpenFromToolbar });
  }

  function publish() {
    const contents = view?.webContents;
    const available = contents && !contents.isDestroyed?.();
    const history = available ? contents.navigationHistory : null;
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
      canGoBack: !!available && (canUseHelpReturn() || canMoveHistory(history, -1, 'canGoBack')),
      canGoForward: !!available && (canUseHelpForward() || canMoveHistory(history, 1, 'canGoForward')),
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
        if (activeLoad?.native && !activeLoad.done && activeLoad.historyTarget
          && activeLoad.acceptsHistoryUrl(event.url)) return;
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
      contents.setWindowOpenHandler(({ url: destination }) => {
        if (isNavigationUrl(destination)) navigate(destination, true);
        return { action: 'deny' };
      });
      contents.on('did-start-loading', publish);
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
    navigationOperationId++;
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

  function destroy() {
    activeLoad?.cancelHelp?.();
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
