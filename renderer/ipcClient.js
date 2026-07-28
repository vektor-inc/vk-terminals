// ─── renderer 側の薄い中継レイヤ（issue #268） ────────────────────────────────
//
// preload が contextBridge で公開した window.vkBridge のプロパティは、renderer 側から
// 差し替えられない（凍結された proxy として渡ってくる）。一方 e2e の何本かは
// 「ipcRenderer.invoke を差し替えて main の応答をモックする」やり方で書かれている。
//
// そこで renderer 世界に差し替え可能な中継オブジェクトを 1 枚挟み、renderer/app.js は
// 必ずこちらを経由して呼ぶ。テストは window.VKIpc.invoke を差し替える。
//
// ⚠ この中継はあくまで renderer 世界のただのオブジェクトで、差し替えられても
//    権限は増えない。権限境界は preload 側のチャンネル許可リストであってここではない。
//    許可外のチャンネルはこの中継を通しても vkBridge が拒否する。
(function (root) {
  'use strict';

  const bridge = root.vkBridge;
  if (!bridge) {
    // preload が読み込まれていない（設定ミス）ときに、原因の分からない
    // TypeError の連鎖ではなく 1 行で分かるエラーにする。
    throw new Error('[vk-terminals] preload bridge (window.vkBridge) が見つかりません');
  }

  root.VKIpc = {
    invoke: (channel, ...args) => bridge.ipc.invoke(channel, ...args),
    send: (channel, ...args) => bridge.ipc.send(channel, ...args),
    // 戻り値は unsubscribe 関数。解除はこれを呼ぶ（off(channel, listener) は無い。
    // contextBridge 越しでは渡した関数の同一性が保てないため／理由は preload.js を参照）。
    on: (channel, listener) => bridge.ipc.on(channel, listener),
  };

  root.VKShell = {
    openExternal: (url) => bridge.shell.openExternal(url),
    beep: () => bridge.shell.beep(),
  };

  root.VKClipboard = {
    // Promise<boolean> を返す（書き込みは main プロセスで行う）。
    writeText: (text) => bridge.clipboard.writeText(text),
  };

  // エージェントルーム（issue #58）のスプライト SVG。renderer から fs が使えないため
  // preload が読んだ中身をそのまま渡す。renderer/agentRoom.js が参照する。
  root.VKAgentRoomSprites = bridge.agentRoomSprites || {};
})(window);
