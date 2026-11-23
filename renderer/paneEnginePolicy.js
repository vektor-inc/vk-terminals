// 手動で追加するペインのエンジンを、元ペインの作成元に応じて決める。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VKPaneEnginePolicy = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function withInheritedEngine(options, sourcePane, initialEngine, initialCodexModel) {
    // 外部 API が作った自動処理用ペインからは、通常ペインへエンジンを引き継がない。
    if (sourcePane && sourcePane.createdByAutomation !== true && sourcePane.engine) {
      return { ...options, engine: sourcePane.engine };
    }
    return initialEngine === 'codex'
      ? { ...options, engine: 'codex', ...(initialCodexModel ? { model: initialCodexModel } : {}) }
      : options;
  }

  return { withInheritedEngine };
});
