const { test, expect } = require('@playwright/test');
const http = require('node:http');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// main.js の HTTP サーバー入口に Host 許可リストゲートが実際に配線され、
// 既定の認証不要構成では接続先と異なる Host が拒否されることを確認する。
// fetch() では Host を指定できないため、Node の生の HTTP リクエストを使う。
//
// issue #347: Node の http.request は既定でレスポンス待ちに上限を持たない
// （fetch と同じ種類の問題）。接続はできたが応答が返らない状態になると
// 無期限に戻らず、テストの持ち時間 120 秒をそのまま使い切ってしまう。
// AbortSignal.timeout() で 1 リクエストあたりの上限を明示する。
function requestHealth(port, hostHeader, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      host: '127.0.0.1',
      port,
      path: '/api/health',
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (hostHeader) options.headers = { Host: hostHeader };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', (error) => {
      // AbortSignal.timeout() が発火すると素の `AbortError: The operation was
      // aborted` だけが飛んでくる。どのリクエストが何 ms で諦めたのかが読み取れる
      // 形に包み替える（issue #347 の趣旨に揃える）。
      if (error.name === 'AbortError') {
        reject(new Error(
          `GET /api/health（Host: ${hostHeader ?? '(既定)'}）が ${timeoutMs}ms 以内に応答しなかった`,
        ));
        return;
      }
      reject(error);
    });
    req.end();
  });
}

test('既定構成では通常の Host を許可し、許可リスト外の Host を 403 で拒否する', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchAppAndWait({
    port,
    prefix: 'vk-terminals-e2e-api-host-allowlist-',
  });

  try {
    // Host を上書きしない通常のリクエストが通り、常に 403 の実装ではないことを担保する。
    const allowed = await requestHealth(port);
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.body).ok).toBe(true);

    // 接続先は 127.0.0.1 のまま、Host だけを攻撃者の名前に変えてゲートを通す。
    const forbidden = await requestHealth(port, 'evil.example.com');
    expect(forbidden.status).toBe(403);
    expect(JSON.parse(forbidden.body).error).toBe('forbidden host');
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
