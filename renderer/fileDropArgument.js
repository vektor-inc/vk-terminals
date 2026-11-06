// Node と renderer の両方から、ドロップ先シェル用の引用処理を利用する。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKFileDropArgument = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function quoteFileDropArgument(value, platform) {
    // Windows の既定シェル PowerShell では、引用符内のバックスラッシュは通常文字。
    if (/^Win/i.test(platform)) {
      return `'${String(value).replace(/'/g, "''")}'`;
    }
    // POSIX 系と fish の双方で、引用符とバックスラッシュを元のまま渡す。
    return `'${String(value).replace(/[\\']/g, (char) => `'\\${char}'`)}'`;
  }

  return { quoteFileDropArgument };
});
