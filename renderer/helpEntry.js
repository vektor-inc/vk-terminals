'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VKHelpEntry = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const TAB_ID = '__terminals_help';
  function insertTab(tabs) {
    const result = tabs.filter((tab) => tab.id !== TAB_ID);
    const about = result.findIndex((tab) => tab.label === 'バージョン情報' || tab.id === 'about');
    result.splice(about < 0 ? result.length : about, 0, { id: TAB_ID, label: '使い方・ヘルプ' });
    return result;
  }
  function mount(container, { invoke, openGuide }) {
    const button = (label, action) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'settings-secondary-button';
      element.textContent = label;
      element.addEventListener('click', action);
      return element;
    };
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const ai = button('AI に相談', async () => {
      if (busy) return;
      busy = true;
      ai.disabled = true;
      retry.disabled = true;
      status.textContent = 'ガイドを起動しています…';
      try {
        const opened = await openGuide();
        if (opened === false) status.textContent = '';
      } catch (_) {
        status.textContent = 'ガイドを起動できませんでした。「AI に相談」を押して再試行してください。';
      } finally {
        busy = false;
        ai.disabled = false;
        retry.disabled = false;
      }
    });
    let busy = false;
    const retry = button('再確認', check);
    retry.hidden = true;
    const documentButton = button('ドキュメント', async () => {
      try { await invoke('help:document'); }
      catch (_) { status.textContent = 'ドキュメントを開けませんでした。もう一度押してください。'; }
    });
    container.append(documentButton, ai, status, retry);
    async function check() {
      if (busy) return;
      busy = true;
      ai.disabled = true;
      retry.disabled = true;
      status.textContent = '利用状況を確認しています…';
      try {
        const result = await invoke('help:check');
        ai.hidden = !result.engine;
        retry.hidden = !!result.engine;
        status.textContent = result.engine ? '' : result.engines.map((item) =>
          `${item.engine === 'claude' ? 'Claude Code' : 'Codex'}: ${item.state === 'unknown' ? '確認できませんでした。' : ''}${item.reason}\n${item.preparation}`).join('\n\n');
      } catch (_) {
        ai.hidden = true;
        retry.hidden = false;
        status.textContent = '利用状況を確認できませんでした。「再確認」を押してください。';
      } finally {
        busy = false;
        ai.disabled = false;
        retry.disabled = false;
      }
    }
    check();
  }
  return { TAB_ID, insertTab, mount };
});
