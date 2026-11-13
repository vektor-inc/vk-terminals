'use strict';
const { EventEmitter } = require('node:events');

// CDP のコマンド応答と loader 付きイベントを別々に制御する。
function installBrowserLoad(contents) {
  let currentUrl = '';
  let pending = null;
  contents.loads = [];
  contents.getURL = () => currentUrl;
  contents.setDocumentUrl = url => { currentUrl = new URL(url).href; };
  const message = (method, params) => contents.debugger.emit('message', {}, method, params);
  contents.startNative = (url, loaderId) => {
    message('Page.frameStartedNavigating', { frameId: 'main', loaderId, url, navigationType: 'differentDocument' });
    message('Network.requestWillBeSent', { type: 'Document', frameId: 'main', loaderId, requestId: `request-${loaderId}`, request: { url } });
  };
  contents.commitDocument = (url, loaderId, type = 'Navigation') => {
    contents.setDocumentUrl(url);
    const committed = new URL(currentUrl);
    const urlFragment = committed.hash;
    committed.hash = '';
    message('Page.frameNavigated', { frame: { id: 'main', loaderId, url: committed.href, urlFragment }, type });
  };
  contents.loadDocument = loaderId => message('Page.lifecycleEvent', { name: 'load', loaderId, frameId: 'main' });
  contents.respond = (loaderId, url, status = 200, frameId = 'main') => message('Network.responseReceived', { type: 'Document', loaderId, frameId, requestId: `request-${loaderId}`, response: { url, status } });
  contents.commitInPage = url => {
    currentUrl = new URL(url).href;
    message('Page.navigatedWithinDocument', { frameId: 'main', url: currentUrl, navigationType: 'historyApi' });
    contents.emit('did-navigate-in-page', {}, currentUrl, true);
  };
  const debuggerConnection = new EventEmitter();
  debuggerConnection.attach = () => {};
  contents.commands = [];
  debuggerConnection.sendCommand = (method, { url } = {}) => {
    contents.commands.push(method);
    if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'main', loaderId: 'initial', url: 'about:blank' } } });
    if (method !== 'Page.navigate') return Promise.resolve({});
    contents.requestedUrl = url;
    return new Promise((resolve, reject) => {
      pending = { url, resolve, reject, loaderId: `loader-${contents.loads.length}`, requestId: `request-${contents.loads.length}`, frameId: 'main' };
      contents.loads.push(pending);
      message('Network.requestWillBeSent', { type: 'Document', frameId: 'main', loaderId: pending.loaderId, requestId: pending.requestId, request: { url } });
    });
  };
  contents.debugger = debuggerConnection;
  contents.stop = () => pending?.resolve({ frameId: 'main', errorText: 'net::ERR_ABORTED' });
  contents.complete = async url => {
    await flushBrowserLoads();
    contents.commitDocument(url, pending.loaderId);
    contents.emit('did-navigate', {}, currentUrl);
    contents.loadDocument(pending.loaderId);
    pending.resolve({ frameId: 'main', loaderId: pending.loaderId });
    await flushBrowserLoads();
  };
  contents.download = async () => {
    pending.resolve({ frameId: 'main', isDownload: true });
    await flushBrowserLoads();
  };
  contents.fail = async (code, url) => {
    await flushBrowserLoads();
    contents.emit('did-fail-load', {}, code, 'failed', url, true);
    pending.resolve({ frameId: 'main', errorText: code === -3 ? 'net::ERR_ABORTED' : 'net::ERR_NAME_NOT_RESOLVED' });
    await flushBrowserLoads();
  };
}

async function flushBrowserLoads() {
  await new Promise(resolve => setImmediate(resolve));
}

module.exports = { installBrowserLoad, flushBrowserLoads };
