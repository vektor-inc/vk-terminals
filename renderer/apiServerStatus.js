// API サーバーの実行状態を、設定パネルで表示する文言へ変換する。
//
// Node（単体テスト）と renderer の両方から使えるよう、画面・IPC・ファイル I/O に
// 依存しない純粋関数だけを置く。
'use strict';

function normalizeHost(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '127.0.0.1';
}

function formatApiUrl(host, port) {
  const normalizedHost = normalizeHost(host);
  const urlHost = normalizedHost.includes(':') && !normalizedHost.startsWith('[')
    ? `[${normalizedHost}]`
    : normalizedHost;
  return `http://${urlHost}:${port}/`;
}

function getApiServerStatusPresentation(status) {
  const safeStatus = status && typeof status === 'object' ? status : {};
  const port = Number.isInteger(safeStatus.port) ? safeStatus.port : 13847;

  if (safeStatus.phase !== 'listening' && safeStatus.phase !== 'error') {
    return {
      tone: 'neutral',
      label: '確認中',
      message: '確認中',
      address: '',
      copy: false,
    };
  }

  if (safeStatus.phase === 'error') {
    if (safeStatus.errorCode === 'EADDRINUSE') {
      return {
        tone: 'error',
        label: 'エラー',
        message: `ポート ${port} が他のプログラムに使われているため、API サーバーが起動していません。vk-terminals を二重に起動している場合は片方を終了してください。他のプログラムが使っている場合は、環境変数 VK_TERMINALS_API_PORT で別のポート番号を指定してください。`,
        address: '',
        copy: false,
      };
    }
    const errorCode = typeof safeStatus.errorCode === 'string' && safeStatus.errorCode
      ? safeStatus.errorCode
      : '不明';
    return {
      tone: 'error',
      label: 'エラー',
      message: `起動時にエラーが発生しました（エラーコード: ${errorCode}）。API ホストの値を確認してください。`,
      address: '',
      copy: false,
    };
  }

  const startupHost = normalizeHost(safeStatus.startupHost);
  const savedHost = normalizeHost(safeStatus.savedHost);
  const actualHost = normalizeHost(safeStatus.actualHost);
  const address = formatApiUrl(actualHost, port);

  // 起動時の値と現在保存されている値が違えば、実際の bind 結果より先に
  // 「保存後、未再起動」を案内する。フォールバックと見た目が同じ 127.0.0.1 でも、
  // 必要な操作（再起動だけ / Tailscale 接続後に再起動）を取り違えないため。
  if (startupHost !== savedHost) {
    return {
      tone: 'warning',
      label: '注意',
      message: `保存した API ホスト（${savedHost}）は次回起動から反映されます。今は ${actualHost} で待ち受けているのでスマートフォンからは開けません。vk-terminals を再起動してください。`,
      address,
      copy: actualHost !== '0.0.0.0',
    };
  }

  if (actualHost !== startupHost) {
    return {
      tone: 'warning',
      label: '注意',
      message: `設定した API ホスト（${startupHost}）がこのパソコンに割り当てられていないため、${actualHost} で待ち受けています。パソコンを Tailscale に接続してから vk-terminals を再起動してください。`,
      address,
      copy: actualHost !== '0.0.0.0',
    };
  }

  if (actualHost === '0.0.0.0') {
    return {
      tone: 'info',
      label: '補足',
      message: 'すべてのネットワークで待ち受けています。0.0.0.0 の部分をこのパソコンのアドレスに置き換えて開いてください。',
      address,
      copy: false,
    };
  }

  if (actualHost === '127.0.0.1' || actualHost === '::1') {
    return {
      tone: 'info',
      label: '補足',
      message: 'このパソコンからのみ開けます。外出先から開くには、下の方法 1 か 2 を使ってください。',
      address,
      copy: true,
    };
  }

  return {
    tone: 'success',
    label: '正常',
    message: 'スマートフォンが同じ tailnet につながっていれば、このアドレスで開けます。',
    address,
    copy: true,
  };
}

module.exports = {
  formatApiUrl,
  getApiServerStatusPresentation,
};
