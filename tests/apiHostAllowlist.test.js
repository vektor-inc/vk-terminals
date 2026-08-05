'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldRequireAuth } = require('../utils/apiAuth');
const { isAllowedApiHost, parseHostHeader } = require('../utils/apiHostAllowlist');

const isAllowed = (hostHeader, overrides = {}) => isAllowedApiHost({
  hostHeader,
  apiHost: '127.0.0.1',
  actualHost: '127.0.0.1',
  authRequired: false,
  ...overrides,
});

test('ループバックリテラル各種を許可する', () => {
  for (const host of [
    '127.0.0.1',
    '127.1.2.3:13847',
    '[::1]:13847',
    '[::ffff:127.0.0.1]:13847',
  ]) {
    assert.equal(isAllowed(host), true, host);
  }
});

test('localhost は末尾ドット・大文字小文字・ポートの有無を問わず許可する', () => {
  for (const host of ['localhost', 'localhost.:13847', 'LoCaLhOsT:13847']) {
    assert.equal(isAllowed(host), true, host);
  }
});

test('localhost やループバックを一部に含む別名は拒否する', () => {
  for (const host of [
    'localhost.evil.com:13847',
    'localhost.evil.com.',
    'evil-localhost',
    'notlocalhost',
    '127.0.0.1.evil.com',
  ]) {
    assert.equal(isAllowed(host), false, host);
  }
});

test('設定した apiHost と実際の待ち受けアドレスを正規化して許可する', () => {
  assert.equal(isAllowed('TERMINAL.EXAMPLE.COM:13847', {
    apiHost: 'terminal.example.com.',
    actualHost: '192.168.1.23',
  }), true);
  assert.equal(isAllowed('192.168.1.23:13847', {
    apiHost: '100.101.102.103',
    actualHost: '192.168.1.23',
  }), true);
});

test('Host ヘッダのポートと IPv6 の角括弧を正規化する', () => {
  assert.equal(parseHostHeader('example.com:13847'), 'example.com');
  assert.equal(parseHostHeader('[2001:db8::1]:13847'), '2001:db8::1');
  assert.equal(parseHostHeader('[localhost]'), '');
  assert.equal(isAllowed('[2001:DB8::1]:13847', {
    apiHost: '2001:db8::1',
    actualHost: '2001:db8::1',
  }), true);
});

test('Host ヘッダが無い・空・配列・不正形式なら拒否する', () => {
  for (const host of [undefined, '', '   ', ['127.0.0.1'], 'example.com:not-a-port', '::1']) {
    assert.equal(isAllowed(host), false, String(host));
  }
});

test('認証不要の構成では許可リストに無いホストを拒否する', () => {
  assert.equal(isAllowed('evil.example.com:13847'), false);
});

test('authRequired を省略した場合は許可リストと照合する', () => {
  assert.equal(isAllowedApiHost({ hostHeader: 'evil.example.com:13847', apiHost: '127.0.0.1', actualHost: '127.0.0.1' }), false);
});

test('apiHost が :: でも実際の待ち受けがループバックなら許可リストで拒否する', () => {
  assert.equal(isAllowed('evil.example.com:13847', {
    apiHost: '::',
    actualHost: '127.0.0.1',
  }), false);
});

test('認証必須の構成では有効な外部ホスト名を許可する', () => {
  for (const authConfig of [
    { actualHost: '100.101.102.103', requireAlways: false },
    { actualHost: '127.0.0.1', requireAlways: true },
  ]) {
    assert.equal(isAllowed('mymac.tail1234.ts.net', {
      actualHost: authConfig.actualHost,
      authRequired: shouldRequireAuth(authConfig),
    }), true);
  }
});

test('ワイルドカードアドレスで待ち受けた場合は認証を必須にする', () => {
  assert.deepEqual(['0.0.0.0', '::'].map((actualHost) => shouldRequireAuth({ actualHost })), [true, true]);
});

test('角括弧で囲った IPv4 は不正な Host として扱う', () => {
  assert.equal(parseHostHeader('[127.0.0.1]'), '');
});

test('認証必須の構成でも Host ヘッダが無い・空・不正形式なら拒否する', () => {
  for (const host of [undefined, '', '   ', ['mymac.tail1234.ts.net'], 'example.com:not-a-port', '[localhost]']) {
    assert.equal(isAllowed(host, { authRequired: true }), false, String(host));
  }
});
