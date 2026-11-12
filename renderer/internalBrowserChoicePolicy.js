'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VKInternalBrowserChoicePolicy = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function shouldShowBrowserChoice(event, lastClickWasDrag) {
    return !event || !(event.button > 0 || event.detail > 1 || (event.detail > 0 && lastClickWasDrag));
  }
  return { shouldShowBrowserChoice };
});
