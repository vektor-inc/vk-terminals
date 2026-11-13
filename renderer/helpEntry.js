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
  function mount(container, { invoke, openGuide, openDocument }) {
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
      documentButton.disabled = true;
      status.textContent = '';
      try {
        const opened = await openGuide(() => { status.textContent = 'ガイドを起動しています…'; });
        if (opened && opened.helpStatus) renderStatus(opened.helpStatus);
        if (opened === false) status.textContent = '';
      } catch (_) {
        status.textContent = 'ガイドを起動できませんでした。「AI に相談」を押して再試行してください。';
      } finally {
        busy = false;
        ai.disabled = false;
        retry.disabled = false;
        documentButton.disabled = false;
        // 非表示になる操作から、次に使える操作へフォーカスを引き継ぐ。
        if (container.isConnected) (ai.hidden ? retry : ai).focus();
      }
    });
    let busy = false;
    const retry = button('再確認', check);
    retry.hidden = true;
    const documentButton = button('ドキュメント', async () => {
      if (busy) return;
      busy = true;
      documentButton.disabled = true;
      ai.disabled = true;
      retry.disabled = true;
      try {
        const opened = await openDocument(
          () => { status.textContent = 'ドキュメントを読み込んでいます…'; },
          () => { status.textContent = '未保存の変更を保存するか選んでください。'; },
        );
        if (opened === false) status.textContent = 'ドキュメントを開く操作をキャンセルしました。';
      } catch (error) { status.textContent = `${error?.message?.includes('再試行してください') ? error.message : 'ドキュメントを開けませんでした。'} もう一度押してください。`;  }
      finally {
        busy = false; documentButton.disabled = false; ai.disabled = false; retry.disabled = false;
        if (container.isConnected) documentButton.focus();
      }
    });
    container.append(documentButton, ai, status, retry);
    // 初回表示と再確認で同じ結果表示を使う。起動直前の状態変化もここへ返す。
    function renderStatus(result) {
      ai.hidden = !result.engine;
      retry.hidden = !!result.engine;
      status.textContent = result.engine ? '' : result.engines.map((item) =>
        `${item.engine === 'claude' ? 'Claude Code' : 'Codex'}: ${item.state === 'unknown' ? '確認できませんでした。' : ''}${item.reason}\n${item.preparation}`).join('\n\n');
    }
    async function check() {
      if (busy) return;
      const restoreFocus = document.activeElement === retry || document.activeElement === ai;
      busy = true;
      ai.disabled = true;
      retry.disabled = true;
      documentButton.disabled = true;
      status.textContent = '利用状況を確認しています…';
      try {
        const result = await invoke('help:check');
        renderStatus(result);
      } catch (_) {
        ai.hidden = true;
        retry.hidden = false;
        status.textContent = '利用状況を確認できませんでした。「再確認」を押してください。';
      } finally {
        busy = false;
        ai.disabled = false;
        retry.disabled = false;
        documentButton.disabled = false;
        if (restoreFocus) (ai.hidden ? retry : ai).focus();
      }
    }
    // 非表示のタブを組み立てただけではホストへ問い合わせない。
    let shown = false;
    return { show() { if (!shown) { shown = true; check(); } } };
  }
  return { TAB_ID, insertTab, mount };
});
