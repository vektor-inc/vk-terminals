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

test('getPrBadgePresentation: external false でモバイル用 aria と merged 判定を返す', () => {
  const mergedPresentation = getPrBadgePresentation(true, { external: false });
  const normalPresentation = getPrBadgePresentation(false, { external: false });

  assert.equal(mergedPresentation.ariaLabel, 'マージ済みのプルリクエストを開く');
  assert.equal(mergedPresentation.icon, '✓');
  assert.equal(mergedPresentation.merged, true);
  assert.equal(normalPresentation.ariaLabel, 'プルリクエストを開く');
  assert.equal(normalPresentation.icon, '↗');
  assert.equal(normalPresentation.merged, false);
});

test('getPrBadgePresentation: external 省略時は従来どおり外部ブラウザ aria を返す', () => {
  const presentation = getPrBadgePresentation(false);

  assert.equal(presentation.ariaLabel, 'プルリクエストを開く（外部ブラウザ）');
  assert.equal(presentation.merged, false);
});

test('getPrBadgePresentation: external true で外部ブラウザ aria を返す', () => {
  const presentation = getPrBadgePresentation(true, { external: true });

  assert.equal(presentation.ariaLabel, 'マージ済みのプルリクエストを開く（外部ブラウザ）');
  assert.equal(presentation.merged, true);
});
