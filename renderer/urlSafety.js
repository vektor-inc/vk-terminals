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
  function normalizeBrowserAddress(input) {
    if (typeof input !== 'string') return null;
    const value = input.trim();
    if (!value) return null;

    let url;
    if (/^https?:\/\//i.test(value)) url = value;
    else if (/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?:[/?#][^\s]*)?$/i.test(value)) url = `http://${value}`;
    else if (/^(?:[a-z\d-]+\.)+[a-z][a-z\d-]+(?::\d{1,5})?(?:[/?#][^\s]*)?$/i.test(value)) url = `https://${value}`;
    else url = `https://www.google.com/search?q=${encodeURIComponent(value)}`;

    return isSafeHttpUrl(url) ? url : null;
  }

  return {
    MAX_SAFE_HTTP_URL_LENGTH,
    isHttpUrl,
    isSafeHttpUrl,
    normalizeBrowserAddress,
  };
});
