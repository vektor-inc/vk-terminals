// 通知の抑止と、常設案内の更新を別々に判断する。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VKConfigReflectionPolicy = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function reflectionDecision({ pending, failed, restartRequired, lastMessage, lastAt, now }) {
    if (failed || typeof restartRequired !== 'boolean') return { pending: !failed && pending, message: null, partial: null };
    const message = restartRequired ? '一部の設定を反映しました' : '設定を反映しました';
    return {
      pending: false,
      partial: restartRequired,
      message: pending && (message !== lastMessage || now - lastAt >= 6000) ? message : null,
    };
  }
  return { reflectionDecision };
});
