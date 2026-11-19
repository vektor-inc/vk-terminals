'use strict';
// タブのファビコンを main 側で取得して data URL に変える処理（issue #644）の検証。
// 取得先の制限（HTTP(S) のみ）・大きさの上限・待ち時間の上限・画像でない応答の除外を確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FAVICON_MAX_BYTES, isFaviconUrl, isLocalHostname, isAllowedFaviconTarget, pickFaviconUrl, detectFaviconType, fetchFaviconDataUrl,
} = require('../utils/internalBrowserFavicon');

const PAGE = 'https://example.com/page';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

// fetch 互換の応答を作る。本文は chunks を順に流す。
function response({ status = 200, type = 'image/png', length, location, url = 'https://example.com/favicon.png', chunks = [PNG] } = {}) {
  const headers = new Map([['content-type', type]]);
  if (length !== undefined) headers.set('content-length', String(length));
  if (location !== undefined) headers.set('location', location);
  let index = 0;
  return {
    ok: status >= 200 && status < 300, status, url,
    headers: { get: name => headers.get(name) ?? null },
    body: { getReader: () => ({
      read: async () => index < chunks.length ? { done: false, value: new Uint8Array(chunks[index++]) } : { done: true },
      cancel: async () => {},
    }) },
  };
}

test('取得してよいのは認証情報を含まない HTTP(S) の URL だけ', () => {
  assert.equal(isFaviconUrl('https://example.com/favicon.ico'), true);
  assert.equal(isFaviconUrl('http://127.0.0.1:3000/icon.png'), true);
  for (const url of ['file:///etc/passwd', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'vk-terminals-help://guide/',
    'https://user:pass@example.com/favicon.ico', `https://example.com/${'a'.repeat(2100)}`, '', null]) {
    assert.equal(isFaviconUrl(url), false, String(url).slice(0, 40));
  }
  assert.equal(pickFaviconUrl(['data:image/png;base64,AAAA', 'file:///a.ico', 'https://example.com/b.ico', 'https://example.com/c.ico']), 'https://example.com/b.ico');
  assert.equal(pickFaviconUrl([]), '');
  assert.equal(pickFaviconUrl(undefined), '');
});

test('画像の種類は先頭のバイトで判定し、SVG は宣言と本文が揃うときだけ受け付ける', () => {
  assert.equal(detectFaviconType(PNG, 'application/octet-stream'), 'image/png');
  assert.equal(detectFaviconType(Buffer.from([0, 0, 1, 0, 1]), 'image/vnd.microsoft.icon'), 'image/x-icon');
  assert.equal(detectFaviconType(Buffer.from('GIF89a'), 'image/gif'), 'image/gif');
  assert.equal(detectFaviconType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'), 'image/jpeg');
  assert.equal(detectFaviconType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '), 'image/webp'), 'image/webp');
  assert.equal(detectFaviconType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml'), 'image/svg+xml');
  // 宣言だけ SVG・本文が HTML のものや、画像でない本文は受け付けない
  assert.equal(detectFaviconType(Buffer.from('<html></html>'), 'image/svg+xml'), '');
  assert.equal(detectFaviconType(Buffer.from('<svg></svg>'), 'text/html'), '');
  assert.equal(detectFaviconType(Buffer.from('<html></html>'), 'image/png'), '');
});

test('取得した画像を data URL にし、Cookie などの認証情報は送らない', async () => {
  const requests = [];
  const dataUrl = await fetchFaviconDataUrl('https://example.com/favicon.png', {
    pageUrl: PAGE, fetch: async (url, options) => { requests.push({ url, options }); return response(); },
  });
  assert.equal(dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.redirect, 'manual');
  assert.ok(requests[0].options.signal);
});

test('取得先・応答が条件に合わないときは空文字を返す', async () => {
  const fetchOnce = value => async () => value;
  // HTTP(S) 以外は取得しない
  let called = false;
  assert.equal(await fetchFaviconDataUrl('file:///etc/passwd', { fetch: async () => { called = true; return response(); } }), '');
  assert.equal(called, false);
  // 失敗応答・画像でない宣言
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', { pageUrl: PAGE, fetch: fetchOnce(response({ status: 404 })) }), '');
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', { pageUrl: PAGE, fetch: fetchOnce(response({ type: 'text/html' })) }), '');
  // 宣言は画像でも本文が画像でないもの・空の本文
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', { pageUrl: PAGE, fetch: fetchOnce(response({ chunks: [Buffer.from('<html>')] })) }), '');
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', { pageUrl: PAGE, fetch: fetchOnce(response({ chunks: [] })) }), '');
  // fetch が失敗しても例外は投げない
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', { pageUrl: PAGE, fetch: async () => { throw new Error('offline'); } }), '');
});

test('大きすぎるファビコンは、宣言の長さでも本文の途中でも打ち切る', async () => {
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', {
    pageUrl: PAGE, fetch: async () => response({ length: FAVICON_MAX_BYTES + 1 }),
  }), '');
  const big = Buffer.concat([PNG, Buffer.alloc(FAVICON_MAX_BYTES)]);
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', {
    pageUrl: PAGE, fetch: async () => response({ chunks: [big.subarray(0, 1000), big.subarray(1000)] }),
  }), '');
  // 上限ちょうどまでは受け付ける
  const exact = Buffer.concat([PNG, Buffer.alloc(100 - PNG.length)]);
  assert.match(await fetchFaviconDataUrl('https://example.com/a.png', {
    pageUrl: PAGE, fetch: async () => response({ chunks: [exact] }), maxBytes: 100,
  }), /^data:image\/png;base64,/);
});

test('応答が来ないときは待ち時間の上限で打ち切る', async () => {
  const started = Date.now();
  const dataUrl = await fetchFaviconDataUrl('https://example.com/slow.png', {
    pageUrl: PAGE, timeoutMs: 30,
    fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  assert.equal(dataUrl, '');
  assert.ok(Date.now() - started < 1000);
});

test('端末・社内側のホスト名を見分ける', () => {
  for (const host of ['localhost', 'app.localhost', 'printer.local', 'wiki.internal', 'nas.lan', 'router.home.arpa', 'intranet',
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '[::1]', '[fd00::1]', '[fe80::1]', '[::ffff:7f00:1]', '']) {
    assert.equal(isLocalHostname(host), true, host);
  }
  for (const host of ['example.com', 'github.com', '8.8.8.8', '172.32.0.1', '[2001:4860:4860::8888]']) {
    assert.equal(isLocalHostname(host), false, host);
  }
});

test('外部のページから端末・社内側へは取りに行かず、ローカルのページが自分のホストのアイコンを取るのは許す', () => {
  assert.equal(isAllowedFaviconTarget('https://cdn.example.net/icon.png', PAGE), true);
  for (const url of ['http://127.0.0.1:8080/icon.png', 'http://localhost/icon.png', 'http://192.168.1.10/icon.png',
    'http://[::1]/icon.png', 'http://intranet/icon.png', 'http://0x7f.1/icon.png']) {
    assert.equal(isAllowedFaviconTarget(url, PAGE), false, url);
  }
  // ローカルのページは同じホストのアイコンだけ取れる（別のポートでもよい）
  assert.equal(isAllowedFaviconTarget('http://localhost:3001/icon.png', 'http://localhost:3000/'), true);
  assert.equal(isAllowedFaviconTarget('http://127.0.0.1/icon.png', 'http://localhost:3000/'), false);
  assert.equal(isAllowedFaviconTarget('http://192.168.1.2/icon.png', 'http://192.168.1.1/'), false);
  // ページが HTTP(S) でない（組み込みの案内ページなど）ときは内側を取りに行かない
  assert.equal(isAllowedFaviconTarget('http://localhost/icon.png', 'vk-terminals-help://guide/'), false);
  assert.equal(isAllowedFaviconTarget('http://localhost/icon.png', ''), false);
});

test('許されない取得先には 1 回も送らない', async () => {
  let called = 0;
  const dataUrl = await fetchFaviconDataUrl('http://127.0.0.1:9000/admin', { pageUrl: PAGE, fetch: async () => { called++; return response(); } });
  assert.equal(dataUrl, '');
  assert.equal(called, 0);
});

test('リダイレクトは送る前に毎回取得先を確かめ、内側・HTTP(S) 以外・回数超過では止める', async () => {
  const run = async (routes, start = 'https://example.com/favicon.ico') => {
    const requested = [];
    const dataUrl = await fetchFaviconDataUrl(start, {
      pageUrl: PAGE,
      fetch: async url => { requested.push(url); return routes[url] || response({ status: 404 }); },
    });
    return { dataUrl, requested };
  };
  // 外部どうしのリダイレクト（相対の Location を含む）はたどる
  const followed = await run({
    'https://example.com/favicon.ico': response({ status: 301, location: '/static/icon.png' }),
    'https://example.com/static/icon.png': response({ status: 302, location: 'https://cdn.example.net/icon.png' }),
    'https://cdn.example.net/icon.png': response(),
  });
  assert.match(followed.dataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(followed.requested, ['https://example.com/favicon.ico', 'https://example.com/static/icon.png', 'https://cdn.example.net/icon.png']);
  // 内側への転送先には送らない
  const internal = await run({ 'https://example.com/favicon.ico': response({ status: 302, location: 'http://169.254.169.254/latest' }) });
  assert.deepEqual(internal, { dataUrl: '', requested: ['https://example.com/favicon.ico'] });
  // HTTP(S) 以外・Location なし・回数超過
  assert.equal((await run({ 'https://example.com/favicon.ico': response({ status: 302, location: 'file:///etc/passwd' }) })).requested.length, 1);
  assert.equal((await run({ 'https://example.com/favicon.ico': response({ status: 302 }) })).dataUrl, '');
  const loop = await run({ 'https://example.com/favicon.ico': response({ status: 302, location: '/favicon.ico' }) });
  assert.equal(loop.dataUrl, '');
  assert.equal(loop.requested.length, 6);
});

test('途中で断った応答も、終わり方によらず通信を打ち切る', async () => {
  for (const options of [{ status: 404 }, { type: 'text/html' }, { length: FAVICON_MAX_BYTES + 1 }]) {
    let signal;
    const dataUrl = await fetchFaviconDataUrl('https://example.com/a.png', {
      pageUrl: PAGE, fetch: async (_url, init) => { signal = init.signal; return response(options); },
    });
    assert.equal(dataUrl, '');
    assert.equal(signal.aborted, true, JSON.stringify(options));
  }
});
