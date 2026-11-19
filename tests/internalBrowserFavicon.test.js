'use strict';
// タブのファビコンを main 側で取得して data URL に変える処理（issue #644）の検証。
// 取得先の制限（HTTP(S) のみ）・大きさの上限・待ち時間の上限・画像でない応答の除外を確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FAVICON_MAX_BYTES, isFaviconUrl, pickFaviconUrl, detectFaviconType, fetchFaviconDataUrl,
} = require('../utils/internalBrowserFavicon');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

// fetch 互換の応答を作る。本文は chunks を順に流す。
function response({ status = 200, type = 'image/png', length, url = 'https://example.com/favicon.png', chunks = [PNG] } = {}) {
  const headers = new Map([['content-type', type]]);
  if (length !== undefined) headers.set('content-length', String(length));
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
    fetch: async (url, options) => { requests.push({ url, options }); return response(); },
  });
  assert.equal(dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.credentials, 'omit');
  assert.ok(requests[0].options.signal);
});

test('取得先・応答が条件に合わないときは空文字を返す', async () => {
  const fetchOnce = value => async () => value;
  // HTTP(S) 以外は取得しない
  let called = false;
  assert.equal(await fetchFaviconDataUrl('file:///etc/passwd', { fetch: async () => { called = true; return response(); } }), '');
  assert.equal(called, false);
  // 失敗応答・HTTP(S) 以外へのリダイレクト・画像でない宣言
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', { fetch: fetchOnce(response({ status: 404 })) }), '');
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', { fetch: fetchOnce(response({ url: 'file:///tmp/a.png' })) }), '');
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', { fetch: fetchOnce(response({ type: 'text/html' })) }), '');
  // 宣言は画像でも本文が画像でないもの・空の本文
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', { fetch: fetchOnce(response({ chunks: [Buffer.from('<html>')] })) }), '');
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', { fetch: fetchOnce(response({ chunks: [] })) }), '');
  // fetch が失敗しても例外は投げない
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', { fetch: async () => { throw new Error('offline'); } }), '');
});

test('大きすぎるファビコンは、宣言の長さでも本文の途中でも打ち切る', async () => {
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', {
    fetch: async () => response({ length: FAVICON_MAX_BYTES + 1 }),
  }), '');
  const big = Buffer.concat([PNG, Buffer.alloc(FAVICON_MAX_BYTES)]);
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', {
    fetch: async () => response({ chunks: [big.subarray(0, 1000), big.subarray(1000)] }),
  }), '');
  // 上限ちょうどまでは受け付ける
  const exact = Buffer.concat([PNG, Buffer.alloc(100 - PNG.length)]);
  assert.match(await fetchFaviconDataUrl('https://example.com/a.png', {
    fetch: async () => response({ chunks: [exact] }), maxBytes: 100,
  }), /^data:image\/png;base64,/);
});

test('応答が来ないときは待ち時間の上限で打ち切る', async () => {
  const started = Date.now();
  const dataUrl = await fetchFaviconDataUrl('https://example.com/slow.png', {
    timeoutMs: 30,
    fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  assert.equal(dataUrl, '');
  assert.ok(Date.now() - started < 1000);
});
