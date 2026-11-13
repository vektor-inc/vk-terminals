'use strict';
const { EventEmitter } = require('node:events');

// CDP のコマンド応答と loader 付きイベントを別々に制御する。
function installBrowserLoad(contents) {
  let currentUrl = '';
  let pending = null;
  contents.loads = [];
  contents.getURL = () => currentUrl;
  contents.commitInPage = url => {
    currentUrl = new URL(url).href;
    contents.emit('did-navigate-in-page', {}, currentUrl, true);
  };
  const debuggerConnection = new EventEmitter();
  debuggerConnection.attach = () => {};
  debuggerConnection.sendCommand = (method, { url } = {}) => {
    if (method !== 'Page.navigate') return Promise.resolve({});
    contents.requestedUrl = url;
    return new Promise((resolve, reject) => {
      pending = { url, resolve, reject, loaderId: `loader-${contents.loads.length}`, frameId: 'main' };
      contents.loads.push(pending);
    });
  };
  contents.debugger = debuggerConnection;
  contents.stop = () => pending?.resolve({ frameId: 'main', errorText: 'net::ERR_ABORTED' });
  contents.complete = async url => {
    await flushBrowserLoads();
    currentUrl = new URL(url).href;
    contents.emit('did-navigate', {}, currentUrl);
    const committed = new URL(currentUrl);
    const urlFragment = committed.hash;
    committed.hash = '';
    debuggerConnection.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main', loaderId: pending.loaderId, url: committed.href, urlFragment } });
    debuggerConnection.emit('message', {}, 'Page.lifecycleEvent', { name: 'load', loaderId: pending.loaderId, frameId: 'main' });
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
