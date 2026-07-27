'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatApiUrl,
  getApiServerStatusPresentation,
} = require('../renderer/apiServerStatus');

const listening = (overrides = {}) => ({
  phase: 'listening',
  port: 13847,
  startupHost: '127.0.0.1',
  savedHost: '127.0.0.1',
  actualHost: '127.0.0.1',
  ...overrides,
});

test('既定の 127.0.0.1 は、このパソコンだけで開ける補足として表示する', () => {
  assert.deepEqual(getApiServerStatusPresentation(listening()), {
    tone: 'info',
    label: '補足',
    message: 'このパソコンからのみ開けます。外出先から開くには、下の方法 1 か 2 を使ってください。',
    address: 'http://127.0.0.1:13847/',
    copy: true,
  });
});

test('指定したアドレスで待ち受けている場合は正常として表示する', () => {
  assert.deepEqual(getApiServerStatusPresentation(listening({
    startupHost: '100.101.102.103',
    savedHost: '100.101.102.103',
    actualHost: '100.101.102.103',
  })), {
    tone: 'success',
    label: '正常',
    message: 'スマートフォンが同じ tailnet につながっていれば、このアドレスで開けます。',
    address: 'http://100.101.102.103:13847/',
    copy: true,
  });
});

test('0.0.0.0 は置き換えが必要な補足として表示し、コピーさせない', () => {
  assert.deepEqual(getApiServerStatusPresentation(listening({
    startupHost: '0.0.0.0',
    savedHost: '0.0.0.0',
    actualHost: '0.0.0.0',
  })), {
    tone: 'info',
    label: '補足',
    message: 'すべてのネットワークで待ち受けています。0.0.0.0 の部分をこのパソコンのアドレスに置き換えて開いてください。',
    address: 'http://0.0.0.0:13847/',
    copy: false,
  });
});

test('保存後に未再起動なら、起動時設定との差から再起動を案内する', () => {
  const result = getApiServerStatusPresentation(listening({
    savedHost: '100.101.102.103',
  }));
  assert.equal(result.tone, 'warning');
  assert.equal(result.label, '注意');
  assert.equal(result.address, 'http://127.0.0.1:13847/');
  assert.equal(result.copy, true);
  assert.match(result.message, /保存した API ホスト（100\.101\.102\.103）は次回起動から反映/);
  assert.match(result.message, /vk-terminals を再起動してください/);
});

test('起動時設定と保存値が同じで実アドレスが違えば、フォールバックとして案内する', () => {
  const result = getApiServerStatusPresentation(listening({
    startupHost: '100.101.102.103',
    savedHost: '100.101.102.103',
    actualHost: '127.0.0.1',
  }));
  assert.equal(result.tone, 'warning');
  assert.equal(result.label, '注意');
  assert.equal(result.address, 'http://127.0.0.1:13847/');
  assert.match(result.message, /このパソコンに割り当てられていない/);
  assert.match(result.message, /Tailscale に接続してから/);
});

test('ポート使用中は API サーバーが起動していないエラーを表示する', () => {
  const result = getApiServerStatusPresentation({
    phase: 'error',
    port: 13847,
    errorCode: 'EADDRINUSE',
  });
  assert.equal(result.tone, 'error');
  assert.equal(result.label, 'エラー');
  assert.equal(result.address, '');
  assert.equal(result.copy, false);
  assert.match(result.message, /ポート 13847 が他のプログラムに使われている/);
  assert.match(result.message, /VK_TERMINALS_API_PORT/);
});

test('その他の起動エラーはエラーコードと API ホスト確認を表示する', () => {
  assert.deepEqual(getApiServerStatusPresentation({
    phase: 'error',
    port: 13847,
    errorCode: 'EACCES',
  }), {
    tone: 'error',
    label: 'エラー',
    message: '起動時にエラーが発生しました（エラーコード: EACCES）。API ホストの値を確認してください。',
    address: '',
    copy: false,
  });
});

test('確定前は中立の確認中を表示する', () => {
  assert.deepEqual(getApiServerStatusPresentation({ phase: 'pending', port: 13847 }), {
    tone: 'neutral',
    label: '確認中',
    message: '確認中',
    address: '',
    copy: false,
  });
});

test('IPv6 アドレスは URL のホスト部分を角括弧で囲む', () => {
  assert.equal(formatApiUrl('::1', 13847), 'http://[::1]:13847/');
  assert.equal(
    getApiServerStatusPresentation(listening({
      startupHost: '::1',
      savedHost: '::1',
      actualHost: '::1',
    })).address,
    'http://[::1]:13847/'
  );
});
