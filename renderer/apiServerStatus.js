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

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1';
}

function isWildcardHost(host) {
  return host === '0.0.0.0' || host === '::';
}

function getApiServerStatusPresentation(status) {
  const safeStatus = status && typeof status === 'object' ? status : {};
  const port = Number.isInteger(safeStatus.port) ? safeStatus.port : 13847;

  if (safeStatus.phase === 'unavailable') {
    return {
      tone: 'warning',
      label: '確認できませんでした',
      message: 'API サーバーの起動を確認できませんでした。起動処理中の可能性があります。しばらくしてから設定パネルを開き直してください。',
      address: '',
      copy: false,
    };
  }

  if (safeStatus.phase !== 'listening' && safeStatus.phase !== 'error') {
    return {
      tone: 'neutral',
      label: '確認中',
      message: 'API サーバーの起動を確認しています。',
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
      message: `API サーバーの起動に失敗しました（エラーコード: ${errorCode}）。「設定」タブの「API ホスト」の値を確認してください。`,
      address: '',
      copy: false,
      showApiHostLink: true,
    };
  }

  const startupHost = normalizeHost(safeStatus.startupHost);
  const savedHost = normalizeHost(safeStatus.savedHost);
  const actualHost = normalizeHost(safeStatus.actualHost);
  const address = formatApiUrl(actualHost, port);

  // 保存値が実際の待ち受け先と一致していれば、フォールバック後に実アドレスへ設定を
  // 直したケースなので「未反映」とは案内しない。起動時設定との一致も見ることで、
  // localhost → ::1 のような正常な名前解決を未反映と誤認しない。
  if (savedHost !== actualHost && savedHost !== startupHost) {
    const loopbackNote = isLoopbackHost(actualHost)
      ? 'この状態ではスマートフォンからは開けません。'
      : '';
    return {
      tone: 'warning',
      label: '注意',
      message: `保存した API ホスト（${savedHost}）は、まだ反映されていません。今は起動したときの設定のまま ${actualHost} で待ち受けています。${loopbackNote}保存したアドレスがこのパソコンに割り当てられた状態（ホスト名なら名前解決できる状態）にしてから、vk-terminals を再起動してください。`,
      address,
      copy: !isWildcardHost(actualHost),
    };
  }

  if (safeStatus.fellBack === true && savedHost !== actualHost) {
    return {
      tone: 'warning',
      label: '注意',
      message: `起動したときの API ホスト（${startupHost}）がこのパソコンに割り当てられていなかったため、${actualHost} で待ち受けています。この状態ではスマートフォンからは開けません。そのアドレスがパソコンに割り当てられた状態（Tailscale IP なら Tailscale に接続した状態）にしてから、vk-terminals を再起動してください。`,
      address,
      copy: !isWildcardHost(actualHost),
    };
  }

  if (isWildcardHost(actualHost)) {
    return {
      tone: 'info',
      label: '補足',
      message: `${actualHost} は、このパソコンのすべてのネットワークで待ち受ける指定です。アドレスの ${actualHost} の部分をこのパソコンのアドレスに置き換えて開いてください。Tailscale IP の調べ方は、下の「パソコンの Tailscale IP を調べる」を確認してください。`,
      address,
      copy: false,
    };
  }

  if (isLoopbackHost(actualHost)) {
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
    message: 'スマートフォンがこのアドレスに届くネットワーク（Tailscale の場合は同じ tailnet）につながっていれば、このアドレスで開けます。',
    address,
    copy: true,
  };
}

module.exports = {
  formatApiUrl,
  getApiServerStatusPresentation,
};
