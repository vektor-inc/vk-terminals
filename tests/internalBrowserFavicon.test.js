'use strict';
// タブのファビコンを main 側で取得して data URL に変える処理（issue #644）の検証。
// 取得先の制限（HTTP(S) のみ）・大きさの上限・待ち時間の上限・画像でない応答の除外を確かめる。
// 名前解決した後のアドレスの確認と、確かめたアドレスへの接続の固定は、手元で立てた HTTP サーバーで確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  FAVICON_MAX_BYTES, isFaviconUrl, isLocalHostname, isAllowedFaviconTarget, isPublicAddress, createCheckedLookup, requestFavicon,
  pickFaviconUrl, detectFaviconType, fetchFaviconDataUrl,
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

test('取得した画像を data URL にし、外部のホストへは外部のアドレスだけに接続させる', async () => {
  const requests = [];
  const dataUrl = await fetchFaviconDataUrl('https://example.com/favicon.png', {
    pageUrl: PAGE, transport: async (url, options) => { requests.push({ url, options }); return response(); },
  });
  assert.equal(dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.allowNonPublic, false);
  assert.ok(requests[0].options.signal);
});

test('取得先・応答が条件に合わないときは空文字を返す', async () => {
  const fetchOnce = value => async () => value;
  // HTTP(S) 以外は取得しない
  let called = false;
  assert.equal(await fetchFaviconDataUrl('file:///etc/passwd', { transport: async () => { called = true; return response(); } }), '');
  assert.equal(called, false);
  // 失敗応答・画像でない宣言
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', { pageUrl: PAGE, transport: fetchOnce(response({ status: 404 })) }), '');
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', { pageUrl: PAGE, transport: fetchOnce(response({ type: 'text/html' })) }), '');
  // 宣言は画像でも本文が画像でないもの・空の本文
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', { pageUrl: PAGE, transport: fetchOnce(response({ chunks: [Buffer.from('<html>')] })) }), '');
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', { pageUrl: PAGE, transport: fetchOnce(response({ chunks: [] })) }), '');
  // fetch が失敗しても例外は投げない
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', { pageUrl: PAGE, transport: async () => { throw new Error('offline'); } }), '');
});

test('大きすぎるファビコンは、宣言の長さでも本文の途中でも打ち切る', async () => {
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', {
    pageUrl: PAGE, transport: async () => response({ length: FAVICON_MAX_BYTES + 1 }),
  }), '');
  const big = Buffer.concat([PNG, Buffer.alloc(FAVICON_MAX_BYTES)]);
  assert.equal(await fetchFaviconDataUrl('https://example.com/a.png', {
    pageUrl: PAGE, transport: async () => response({ chunks: [big.subarray(0, 1000), big.subarray(1000)] }),
  }), '');
  // 上限ちょうどまでは受け付ける
  const exact = Buffer.concat([PNG, Buffer.alloc(100 - PNG.length)]);
  assert.match(await fetchFaviconDataUrl('https://example.com/a.png', {
    pageUrl: PAGE, transport: async () => response({ chunks: [exact] }), maxBytes: 100,
  }), /^data:image\/png;base64,/);
});

test('応答が来ないときは待ち時間の上限で打ち切る', async () => {
  const started = Date.now();
  const dataUrl = await fetchFaviconDataUrl('https://example.com/slow.png', {
    pageUrl: PAGE, timeoutMs: 30,
    transport: (_url, { signal }) => new Promise((_resolve, reject) => {
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
  const dataUrl = await fetchFaviconDataUrl('http://127.0.0.1:9000/admin', { pageUrl: PAGE, transport: async () => { called++; return response(); } });
  assert.equal(dataUrl, '');
  assert.equal(called, 0);
});

test('リダイレクトは送る前に毎回取得先を確かめ、内側・HTTP(S) 以外・回数超過では止める', async () => {
  const run = async (routes, start = 'https://example.com/favicon.ico') => {
    const requested = [];
    const dataUrl = await fetchFaviconDataUrl(start, {
      pageUrl: PAGE,
      transport: async url => { requested.push(url); return routes[url] || response({ status: 404 }); },
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
      pageUrl: PAGE, transport: async (_url, init) => { signal = init.signal; return response(options); },
    });
    assert.equal(dataUrl, '');
    assert.equal(signal.aborted, true, JSON.stringify(options));
  }
});

test('外部の IP アドレスを見分ける（IPv4 を埋め込んだ IPv6 は埋め込まれた IPv4 で判定する）', () => {
  for (const address of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '2001:4860:4860::8888', '2606:4700::1111']) {
    assert.equal(isPublicAddress(address), true, address);
  }
  for (const address of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fd00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1',
    '::ffff:7f00:1', '::ffff:10.0.0.1', '::7f00:1', '64:ff9b::a00:1', '2002:7f00:1::1', 'example.com', '', undefined]) {
    assert.equal(isPublicAddress(address), false, String(address));
  }
});

// dns.lookup 互換の差し替え。呼ばれた回数を数え、呼ばれるたびに次の答えを返す。
function fakeResolver(...answers) {
  const resolver = (hostname, options, callback) => {
    resolver.calls.push({ hostname, options });
    const answer = answers[Math.min(resolver.calls.length - 1, answers.length - 1)];
    setImmediate(() => answer instanceof Error ? callback(answer) : callback(null, answer.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))));
  };
  resolver.calls = [];
  return resolver;
}

const lookupWith = (lookup, options) => new Promise(resolve => {
  lookup('icon.example', options, (error, address, family) => resolve({ error, address, family }));
});

test('名前解決したアドレスが 1 つでも内側なら接続させず、確かめたアドレスをそのまま接続先に渡す', async () => {
  // 外部のアドレスだけなら、確かめたアドレスを返す（1 回だけ解決し、接続のときに解決し直さない）
  const rebinding = fakeResolver(['93.184.216.34'], ['127.0.0.1']);
  const lookup = createCheckedLookup({ allowNonPublic: false, resolve: rebinding });
  assert.deepEqual(await lookupWith(lookup, {}), { error: null, address: '93.184.216.34', family: 4 });
  assert.equal(rebinding.calls.length, 1);
  // net.connect が all: true で呼ぶ形（接続先の候補を並べて試す）でも、確かめたアドレスだけを返す
  const all = await lookupWith(createCheckedLookup({ allowNonPublic: false, resolve: fakeResolver(['93.184.216.34', '2606:4700::1111']) }), { all: true });
  assert.deepEqual(all.address, [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1111', family: 6 }]);
  // 内側のアドレスを返す DNS・外部と内側が混ざる DNS・IPv4 を埋め込んだ IPv6 は接続させない
  for (const answer of [['127.0.0.1'], ['10.0.0.8'], ['93.184.216.34', '192.168.1.1'], ['::ffff:169.254.169.254'], ['::1'], []]) {
    const result = await lookupWith(createCheckedLookup({ allowNonPublic: false, resolve: fakeResolver(answer) }), {});
    assert.ok(result.error, JSON.stringify(answer));
    assert.equal(result.address, undefined);
  }
  // 名前解決の失敗はそのまま返す
  const failed = await lookupWith(createCheckedLookup({ allowNonPublic: false, resolve: fakeResolver(new Error('ENOTFOUND')) }), {});
  assert.equal(failed.error.message, 'ENOTFOUND');
  // ローカルのページが自分のホストのアイコンを取るときは、内側のアドレスにも接続させる
  assert.deepEqual(await lookupWith(createCheckedLookup({ allowNonPublic: true, resolve: fakeResolver(['127.0.0.1']) }), {}),
    { error: null, address: '127.0.0.1', family: 4 });
});

// 手元で HTTP サーバーを立て、届いたリクエストを記録する。
async function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => { requests.push({ url: req.url, headers: req.headers }); handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { port, requests, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }) };
}

const servePng = (_req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); };

test('内側の IP アドレスを返すホスト名には、外部のページからは 1 回も送らない', async () => {
  const server = await startServer(servePng);
  try {
    for (const answer of [['127.0.0.1'], ['93.184.216.34', '127.0.0.1']]) {
      const resolve = fakeResolver(answer);
      const dataUrl = await fetchFaviconDataUrl(`http://icon.example:${server.port}/favicon.png`, { pageUrl: PAGE, resolve, timeoutMs: 2000 });
      assert.equal(dataUrl, '', JSON.stringify(answer));
      assert.equal(resolve.calls.length, 1);
    }
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

test('リダイレクト先のホスト名が内側の IP アドレスを返すときは、転送先へ送らない', async () => {
  let redirectTarget = '';
  const server = await startServer((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { location: redirectTarget }); res.end(); return; }
    servePng(req, res);
  });
  try {
    redirectTarget = `http://rebind.example:${server.port}/admin`;
    // ローカルのページが自分のホストのアイコンを取り、その応答が外部の名前へ転送する場合
    const resolve = fakeResolver(['127.0.0.1']);
    const dataUrl = await fetchFaviconDataUrl(`http://favicon.internal:${server.port}/start`, {
      pageUrl: `http://favicon.internal:${server.port}/`, resolve, timeoutMs: 2000,
    });
    assert.equal(dataUrl, '');
    assert.deepEqual(server.requests.map(request => request.url), ['/start']);
    assert.deepEqual(resolve.calls.map(call => call.hostname), ['favicon.internal', 'rebind.example']);
  } finally { await server.close(); }
});

test('ローカルのページの自分のホストのアイコンは、確かめたアドレスへ接続して取得し、Cookie などは送らない', async () => {
  const server = await startServer(servePng);
  try {
    // favicon.internal はこのテストの差し替えでしか解決できない名前。取得できたことが、確かめたアドレスへ接続した証拠になる
    const resolve = fakeResolver(['127.0.0.1']);
    const dataUrl = await fetchFaviconDataUrl(`http://favicon.internal:${server.port}/favicon.png`, {
      pageUrl: `http://favicon.internal:${server.port}/`, resolve, timeoutMs: 2000,
    });
    assert.equal(dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);
    assert.equal(resolve.calls.length, 1);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].headers.cookie, undefined);
    assert.equal(server.requests[0].headers.authorization, undefined);
    assert.equal(server.requests[0].headers['accept-encoding'], 'identity');
  } finally { await server.close(); }
});

test('IP アドレスを直接書いた URL も、外部のアドレスでなければ接続しない', async () => {
  const server = await startServer(servePng);
  try {
    await assert.rejects(requestFavicon(`http://127.0.0.1:${server.port}/favicon.png`, { signal: new AbortController().signal, allowNonPublic: false }));
    await assert.rejects(requestFavicon(`http://[::ffff:127.0.0.1]:${server.port}/favicon.png`, { signal: new AbortController().signal, allowNonPublic: false }));
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

test('実際の通信でも、大きすぎる本文と応答の来ない取得先は打ち切る', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/big.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.concat([PNG, Buffer.alloc(FAVICON_MAX_BYTES)])); return; }
    // /slow.png には応答しない
  });
  try {
    const page = `http://favicon.internal:${server.port}/`;
    assert.equal(await fetchFaviconDataUrl(`${page}big.png`, { pageUrl: page, resolve: fakeResolver(['127.0.0.1']), timeoutMs: 2000 }), '');
    const started = Date.now();
    assert.equal(await fetchFaviconDataUrl(`${page}slow.png`, { pageUrl: page, resolve: fakeResolver(['127.0.0.1']), timeoutMs: 50 }), '');
    assert.ok(Date.now() - started < 1000);
  } finally { await server.close(); }
});
