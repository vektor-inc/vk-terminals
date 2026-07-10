'use strict';

function getPrBadgePresentation(prMerged) {
  const merged = prMerged === true;
  return {
    className: 'pane-badge pane-task-title-pr' + (merged ? ' merged' : ''),
    ariaLabel: merged
      ? 'マージ済みのプルリクエストを開く（外部ブラウザ）'
      : 'プルリクエストを開く（外部ブラウザ）',
    icon: merged ? '✓' : '↗',
  };
}

module.exports = {
  getPrBadgePresentation,
};
