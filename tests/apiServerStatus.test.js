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
  fellBack: false,
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
    message: 'スマートフォンがこのアドレスに届くネットワーク（Tailscale の場合は同じ tailnet）につながっていれば、このアドレスで開けます。',
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
    message: '0.0.0.0 は、このパソコンのすべてのネットワークで待ち受ける指定です。アドレスの 0.0.0.0 の部分をこのパソコンのアドレスに置き換えて開いてください。Tailscale IP の調べ方は、下の「パソコンの Tailscale IP を調べる」を確認してください。',
    address: 'http://0.0.0.0:13847/',
    copy: false,
  });
});

test('保存値が実待ち受け先にも起動時設定にも未反映なら再起動を案内する', () => {
  const result = getApiServerStatusPresentation(listening({
    savedHost: '100.101.102.103',
  }));
  assert.equal(result.tone, 'warning');
  assert.equal(result.label, '注意');
  assert.equal(result.address, 'http://127.0.0.1:13847/');
  assert.equal(result.copy, true);
  assert.match(result.message, /保存した API ホスト（100\.101\.102\.103）は、まだ反映されていません/);
  assert.match(result.message, /今は起動したときの設定のまま 127\.0\.0\.1/);
  assert.match(result.message, /スマートフォンからは開けません/);
  assert.match(result.message, /保存したアドレスがこのパソコンに割り当てられた状態/);
  assert.match(result.message, /vk-terminals を再起動してください/);
});

test('未反映でも実待ち受け先が外部到達可能ならスマートフォンから開けないと断定しない', () => {
  const result = getApiServerStatusPresentation(listening({
    startupHost: '0.0.0.0',
    savedHost: '127.0.0.1',
    actualHost: '0.0.0.0',
  }));
  assert.equal(result.tone, 'warning');
  assert.doesNotMatch(result.message, /スマートフォンからは開けません/);
});

test('フォールバック事実がある場合だけ割り当てエラーとして案内する', () => {
  const result = getApiServerStatusPresentation(listening({
    startupHost: '100.101.102.103',
    savedHost: '100.101.102.103',
    actualHost: '127.0.0.1',
    fellBack: true,
  }));
  assert.equal(result.tone, 'warning');
  assert.equal(result.label, '注意');
  assert.equal(result.address, 'http://127.0.0.1:13847/');
  assert.match(result.message, /このパソコンに割り当てられていなかった/);
  assert.match(result.message, /起動したときの API ホスト/);
  assert.match(result.message, /Tailscale IP なら Tailscale に接続した状態/);
});

test('フォールバック後に保存値を実待ち受け先へ直した場合は通常表示に戻す', () => {
  const result = getApiServerStatusPresentation(listening({
    startupHost: '100.101.102.103',
    savedHost: '127.0.0.1',
    actualHost: '127.0.0.1',
    fellBack: true,
  }));
  assert.equal(result.tone, 'info');
  assert.doesNotMatch(result.message, /まだ反映されていません|割り当てられていなかった/);
});

test('localhost が ::1 に名前解決されてもフォールバック警告を出さない', () => {
  const result = getApiServerStatusPresentation(listening({
    startupHost: 'localhost',
    savedHost: 'localhost',
    actualHost: '::1',
    fellBack: false,
  }));
  assert.equal(result.tone, 'info');
  assert.equal(result.label, '補足');
  assert.equal(result.address, 'http://[::1]:13847/');
  assert.doesNotMatch(result.message, /割り当てられていな|再起動/);
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
    message: 'API サーバーの起動に失敗しました（エラーコード: EACCES）。「設定」タブの「API ホスト」の値を確認してください。',
    address: '',
    copy: false,
    showApiHostLink: true,
  });
});

test('確定前は中立の確認中を表示する', () => {
  assert.deepEqual(getApiServerStatusPresentation({ phase: 'pending', port: 13847 }), {
    tone: 'neutral',
    label: '確認中',
    message: 'API サーバーの起動を確認しています。',
    address: '',
    copy: false,
  });
});

test('確認を打ち切った状態は設定パネルを開き直す案内を表示する', () => {
  assert.deepEqual(getApiServerStatusPresentation({ phase: 'unavailable' }), {
    tone: 'warning',
    label: '確認できませんでした',
    message: 'API サーバーの起動を確認できませんでした。起動処理中の可能性があります。しばらくしてから設定パネルを開き直してください。',
    address: '',
    copy: false,
  });
});

test('IPv6 の全アドレス指定 :: は 0.0.0.0 と同じく置き換えを案内してコピーさせない', () => {
  const result = getApiServerStatusPresentation(listening({
    startupHost: '::',
    savedHost: '::',
    actualHost: '::',
  }));
  assert.equal(result.tone, 'info');
  assert.equal(result.address, 'http://[::]:13847/');
  assert.equal(result.copy, false);
  assert.match(result.message, /すべてのネットワークで待ち受ける指定/);
  assert.match(result.message, /Tailscale IP を調べる/);
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
