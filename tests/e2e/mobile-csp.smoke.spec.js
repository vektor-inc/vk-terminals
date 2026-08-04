const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');
const { buildMobileCsp } = require('../../utils/csp');

// issue #324: renderer/mobile.html（HTTP 配信）の CSP（Content Security Policy）
// レスポンスヘッダーの回帰テスト。
//
// renderer/index.html 側の CSP は tests/e2e/renderer-isolation.smoke.spec.js の
// securitypolicyviolation テストで実際に踏んで検証しているが、mobile.html は
// <meta> ではなく main.js の HTTP レスポンスヘッダーで配信しているため、それとは
// 別に「実際に返ってくるレスポンスのヘッダーそのもの」を検証する必要がある
// （ヘッダー名のタイポ・writeHead の分岐移動・別ルート追加時の付け忘れは、
// renderer 側の securitypolicyviolation テストでは検知できない）。

// HTTP サーバーが起きて / が 200 を返せるようになるまで待つ（他の mobile 系 spec と同じ型）。
async function waitForServer(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.status === 200) return;
    } catch (_e) { /* 起動前の失敗は吸収 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('HTTP server did not become ready in time');
}

test('GET /（mobile.html）は buildMobileCsp() と一致する Content-Security-Policy ヘッダーを返す', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchApp({ port, prefix: 'vk-terminals-e2e-mobile-csp-' });
  try {
    await waitForServer(port);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy');

    // クリックジャッキング対策（他サイトからの iframe 埋め込み拒否）の要。
    // <meta> 側（renderer/index.html）では frame-ancestors が仕様上無視されるため、
    // ここでしか固定できない。
    expect(csp).toContain("frame-ancestors 'none'");
    // 注入スクリプト対策の要。default-src 'none' が抜けると、他のディレクティブで
    // 明示していない資源種別（例: worker-src）が無制限に開いてしまう。
    expect(csp).toContain("default-src 'none'");

    // ヘッダー文字列全体を utils/csp.js の buildMobileCsp() と完全一致させ、
    // 個々の contain チェックをすり抜けるディレクティブの欠落・タイプミスも拾う。
    expect(csp).toBe(buildMobileCsp());
  } finally {
    await closeApp({ app, tmpRoot });
  }
});

// GET /mobile.css・/shared.css・/widgetContract.js 等の付随リソースは、この
// レスポンス自体が閲覧されるドキュメントではないため CSP ヘッダーを持たせていない
// （CSP はそれを読み込んだ側の文書が強制するものであり、リソース自身のレスポンス
// ヘッダーは無意味）。付け忘れの回帰テストとしては GET / の1本で十分。
