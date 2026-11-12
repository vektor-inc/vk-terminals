'use strict';

function isInternalBrowserSender(event, win) {
  return !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
}

module.exports = { isInternalBrowserSender };
