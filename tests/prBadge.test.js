'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getPrBadgePresentation } = require('../renderer/prBadge');

test('getPrBadgePresentation: prMerged true で merged クラス・aria・非色アイコンを返す', () => {
  const presentation = getPrBadgePresentation(true);

  assert.match(presentation.className, /\bmerged\b/);
  assert.equal(presentation.ariaLabel, 'マージ済みのプルリクエストを開く（外部ブラウザ）');
  assert.equal(presentation.icon, '✓');
});

test('getPrBadgePresentation: prMerged true 以外は従来 PR 表示を返す', () => {
  const presentation = getPrBadgePresentation('true');

  assert.equal(presentation.className, 'pane-badge pane-task-title-pr');
  assert.equal(presentation.ariaLabel, 'プルリクエストを開く（外部ブラウザ）');
  assert.equal(presentation.icon, '↗');
});
