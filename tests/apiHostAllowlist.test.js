'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isAllowedApiHost, parseHostHeader } = require('../utils/apiHostAllowlist');

const isAllowed = (hostHeader, overrides = {}) => isAllowedApiHost({
  hostHeader,
  apiHost: '127.0.0.1',
  actualHost: '127.0.0.1',
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

test('許可リストに無い攻撃者ドメインを拒否する', () => {
  assert.equal(isAllowed('evil.example.com:13847'), false);
});

test('apiHost が全インターフェース待ち受けなら Host 検証を通す', () => {
  for (const apiHost of ['0.0.0.0', '::']) {
    assert.equal(isAllowedApiHost({
      hostHeader: '192.168.1.23:13847',
      apiHost,
      actualHost: apiHost,
    }), true, apiHost);
    assert.equal(isAllowedApiHost({ hostHeader: undefined, apiHost, actualHost: apiHost }), false, apiHost);
  }
});
