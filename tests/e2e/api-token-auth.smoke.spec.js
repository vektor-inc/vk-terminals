const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// HTTP API のアクセストークン認証（issue #313）の統合テスト。
//
// tests/apiAuth.test.js は utils/apiAuth.js の純粋関数だけを検証しており、
// main.js の httpServer に実際に配線されているかどうかは誰も確認していなかった
// （レビュー指摘・重大-1: preload.js への配線忘れが単体テスト 408 件が緑のまま
// 素通りした実例）。ここでは実際に Electron アプリを起動し、生の HTTP リクエストで
// 認証ゲートの配線を確かめる。
//
// apiRequireAuthAlways: true で起動する。apiHost は既定の 127.0.0.1 のままだが、
// この設定により待ち受けアドレスに関わらず認証が必須になる（shouldRequireAuth の
// requireAlways 分岐）。

test.describe.serial('HTTP API のアクセストークン認証（issue #313）', () => {
  let app;
  let win;
  let tmpRoot;
  let tmpHome;
  let apiPort;
  let token;

  test.beforeAll(async () => {
    apiPort = await getFreePort();
    ({ app, win, tmpRoot, tmpHome } = await launchAppAndWait({
      port: apiPort,
      prefix: 'vk-terminals-e2e-api-token-auth-',
      config: { apiRequireAuthAlways: true },
    }));

    // ensureApiToken() は app.whenReady() より前（モジュール読み込み時）に走るため、
    // 初期描画（#sidebar 待ち）が終わった時点で ~/.vk-terminals/config.json への
    // 書き込みも完了している。ヘルパーが事前にこのファイルを作成しているため、
    // resolveTokenConfigPath() の探索候補（DATA_DIR/config.json が最優先）はこの
    // ファイルに一致し、トークンもここへ書き戻される。
    const configPath = path.join(tmpHome, '.vk-terminals', 'config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    token = config.apiToken;
    expect(typeof token, `config.json に apiToken が無い: ${raw}`).toBe('string');
    expect(token.length).toBe(64);
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test('1. トークン無しの GET /api/states は 401', async () => {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/states`);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('unauthorized');
  });

  test('2. Authorization: Bearer <正しいトークン> 付きの GET /api/states は 200', async () => {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/states`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty('terminals');
  });

  test('3-4. GET /?token=<正しいトークン> は 302 + Set-Cookie を返し、Location にトークンが残らない', async () => {
    const res = await fetch(`http://127.0.0.1:${apiPort}/?token=${token}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toBe('/');
    // リダイレクト先にトークンそのものが含まれない（issue #313 必須条件）。
    expect(location.includes(token)).toBe(false);
    expect(location.includes('token')).toBe(false);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
  });

  test('5. GET /api/health は認証なしで 200', async () => {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/health`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  test('6. 認証必須の状態でも GET / は認証なしで 200 を返し mobile.html を配信する（重大-2 の回帰チェック）', async () => {
    // トークンも Cookie も付けない。ページ本体は静的ファイルとして誰でも読める必要がある
    // （画面側の JS が /api/* の 401 を検知して確定文言を出す設計そのものが、ページ自体を
    // 読み込めなければ成立しないため）。
    const res = await fetch(`http://127.0.0.1:${apiPort}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<html');
    expect(body.toLowerCase()).toContain('auth-expired');
  });

  test('7. GET /mobile.js も認証なしで 200 を返す（ページ本体を構成する静的ファイル）', async () => {
    const res = await fetch(`http://127.0.0.1:${apiPort}/mobile.js`);
    expect(res.status).toBe(200);
  });

  test('8. 誤ったトークンの GET /?token=... は 401', async () => {
    const res = await fetch(`http://127.0.0.1:${apiPort}/?token=wrong-token-value`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(401);
  });

  test('9. Cookie 経由でも認証を通過できる', async () => {
    const registerRes = await fetch(`http://127.0.0.1:${apiPort}/?token=${token}`, {
      redirect: 'manual',
    });
    const setCookie = registerRes.headers.get('set-cookie');
    const cookiePair = setCookie.split(';')[0]; // "vk_terminals_token=<value>"
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/states`, {
      headers: { Cookie: cookiePair },
    });
    expect(res.status).toBe(200);
  });
});
