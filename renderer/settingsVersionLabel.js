'use strict';

// Node（require）とブラウザ（<script>）の両方から使える UMD 形式。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKSettingsVersionLabel = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

// 設定ディスクリプタの表示名を優先し、不正な値ならアプリ版の既定表示へ戻す。
function getSettingsVersionLabel(versionLabel, appVersion) {
  if (typeof versionLabel === 'string' && versionLabel.trim() !== '') {
    return versionLabel;
  }
  return appVersion ? `VK Terminals v${appVersion}` : '';
}

return { getSettingsVersionLabel };
});
