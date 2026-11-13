// 外部リンクに使う URL の安全判定を共有する。
//
// Node（require）とブラウザ（mobile.html の <script>）の両方から使える UMD 形式。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKUrlSafety = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_SAFE_HTTP_URL_LENGTH = 2048;

  // href / shell.openExternal に渡せる URL を http(s) のみに制限する。
  function isHttpUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (_e) {
      return false;
    }
  }

  function isSafeHttpUrl(url) {
    return typeof url === 'string' && url.length <= MAX_SAFE_HTTP_URL_LENGTH && isHttpUrl(url);
  }

  // アドレス欄の入力を URL または検索先に変換し、開けない入力は渡さない。
  function resolveBrowserAddress(input) {
    if (typeof input !== 'string') return { url: null, error: 'empty' };
    const value = input.trim();
    if (!value) return { url: null, error: 'empty' };

    let url;
    if (/^https?:\/\//i.test(value)) url = value;
    else if (/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?:[/?#][^\s]*)?$/i.test(value)) url = `http://${value}`;
    // 社内・ローカルのアドレスを外部の検索サービスへ送らないよう、IPv4 アドレスと
    // ポート番号付きの 1 語のホスト名は http:// を補って開く。
    else if (/^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?::\d{1,5})?(?:[/?#][^\s]*)?$/.test(value)
      || /^[a-z\d](?:[a-z\d-]*[a-z\d])?:\d{1,5}(?:[/?#][^\s]*)?$/i.test(value)) url = `http://${value}`;
    else if (!/\s/.test(value) && /^[^:/?#@]+(?::\d{1,5})?(?:[/?#].*)?$/.test(value)) {
      // URL パーサーの IDN 正規化後にホストを判定し、検索語をドメインと誤認しない。
      const authority = value.split(/[/?#]/, 1)[0];
      const host = /^([^:/?#@]+)(?::\d{1,5})?$/.exec(authority)?.[1];
      try {
        const hostname = new URL(`https://${host}`).hostname;
        url = /^(?:[a-z\d-]+\.)+[a-z][a-z\d-]+$/i.test(hostname)
          ? `https://${value}` : `https://www.google.com/search?q=${encodeURIComponent(value)}`;
      } catch (_e) {
        url = `https://www.google.com/search?q=${encodeURIComponent(value)}`;
      }
    }
    else url = `https://www.google.com/search?q=${encodeURIComponent(value)}`;

    // URL 候補は候補そのものを、検索語はエンコード後の検索 URL を検査する。
    // 形式が不正な URL を、検索 URL の長さだけで長すぎると案内しない。
    if (!isHttpUrl(url)) return { url: null, error: 'invalid' };
    if (url.length > MAX_SAFE_HTTP_URL_LENGTH) return { url: null, error: 'too-long' };
    return { url, error: null };
  }

  function normalizeBrowserAddress(input) {
    return resolveBrowserAddress(input).url;
  }

  return {
    MAX_SAFE_HTTP_URL_LENGTH,
    isHttpUrl,
    isSafeHttpUrl,
    resolveBrowserAddress,
    normalizeBrowserAddress,
  };
});
