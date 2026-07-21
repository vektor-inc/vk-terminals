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
  function isSafeHttpUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    if (url.length > MAX_SAFE_HTTP_URL_LENGTH) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (_e) {
      return false;
    }
  }

  return {
    MAX_SAFE_HTTP_URL_LENGTH,
    isSafeHttpUrl,
  };
});
