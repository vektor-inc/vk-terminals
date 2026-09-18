"use strict";

// モバイルページ（renderer/mobile.html）用の Service Worker（issue #396）。
// ページを閉じていても Web Push の通知を受け取り、タップされたらモバイルページに
// フォーカスする。main.js が GET /sw.js でこのファイルをそのまま配信する
// （ルート直下で配信するため、既定のスコープが '/' になり Service-Worker-Allowed
// ヘッダーは不要）。
//
// このファイルは Service Worker 専用のグローバルスコープで実行されるため、
// mobile.js とは実行コンテキストが別（DOM に触れない・window が無い）。
// ロジックをできるだけ薄く保ち、通知の中身の組み立て（タイトル・本文・tag）は
// すべて main.js 側（utils/notificationTrigger.js の buildNotificationPayload）が
// 済ませたペイロードをそのまま表示するだけにする（issue の指示どおり、通知には
// ペイン名と種別以外の情報を含めない設計を Service Worker 側でも壊さないため）。

self.addEventListener("install", function () {
  // 即座に有効化する（既存タブへの介入は controllerchange 相当の影響が無いため待たない）。
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    // JSON でないペイロードは想定していないが、パース失敗時も通知自体は出す
    // （内容不明の通知を出さずに黙って捨てると「届いたはずが来ない」と誤解されるため）。
    data = {};
  }
  var title = (data && data.title) || "VK Terminals";
  var body = (data && data.body) || "";
  var tag = (data && data.tag) || "vk-terminals";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      tag: tag,
      // 同じ tag の通知は上書きする（issue #396: 同じペインの通知が積み重なって
      // 鳴り続けないようにする）。renotify は既定 false のままにし、上書き時に
      // 再度バイブレーション・音を鳴らさない（連続する状態変化での過剰な通知を避ける）。
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
    })
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(function (clientList) {
        for (var i = 0; i < clientList.length; i++) {
          var client = clientList[i];
          if ("focus" in client) return client.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow("/");
        return undefined;
      })
  );
});
