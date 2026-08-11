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

// ─── issue #363: prWaitingMerge（マージ待ち・青）3状態対応 ──────────────────

test('getPrBadgePresentation: prWaitingMerge true で awaiting-merge クラス・aria・非色アイコンを返す', () => {
  const presentation = getPrBadgePresentation(false, { prWaitingMerge: true });

  assert.equal(presentation.className, 'pane-badge pane-task-title-pr awaiting-merge');
  assert.equal(presentation.ariaLabel, 'マージ待ちのプルリクエストを開く（外部ブラウザ）');
  assert.equal(presentation.icon, '…');
  assert.equal(presentation.merged, false);
  assert.equal(presentation.waitingMerge, true);
});

test('getPrBadgePresentation: prWaitingMerge true 以外（false・未指定・文字列）は open 表示のまま', () => {
  for (const value of [false, undefined, 'true']) {
    const presentation = getPrBadgePresentation(false, { prWaitingMerge: value });
    assert.equal(presentation.className, 'pane-badge pane-task-title-pr');
    assert.equal(presentation.ariaLabel, 'プルリクエストを開く（外部ブラウザ）');
    assert.equal(presentation.icon, '↗');
    assert.equal(presentation.waitingMerge, false);
  }
});

test('getPrBadgePresentation: prMerged と prWaitingMerge が同時に true のときは prMerged を優先する', () => {
  const presentation = getPrBadgePresentation(true, { prWaitingMerge: true });

  assert.equal(presentation.className, 'pane-badge pane-task-title-pr merged');
  assert.equal(presentation.ariaLabel, 'マージ済みのプルリクエストを開く（外部ブラウザ）');
  assert.equal(presentation.icon, '✓');
  assert.equal(presentation.merged, true);
  assert.equal(presentation.waitingMerge, false);
});

test('getPrBadgePresentation: options 省略時は prWaitingMerge 未指定として open 表示を返す（後方互換）', () => {
  const presentation = getPrBadgePresentation(false);
  assert.equal(presentation.className, 'pane-badge pane-task-title-pr');
  assert.equal(presentation.waitingMerge, false);
});

test('getPrBadgePresentation: 既存2引数呼び出し getPrBadgePresentation(bool, { external }) は影響を受けない', () => {
  // options に external だけを渡す旧来の呼び出しでも prWaitingMerge は false 扱いになる。
  const presentation = getPrBadgePresentation(false, { external: false });
  assert.equal(presentation.waitingMerge, false);
  assert.equal(presentation.className, 'pane-badge pane-task-title-pr');
  assert.equal(presentation.ariaLabel, 'プルリクエストを開く');
});

test('getPrBadgePresentation: titleLabel は3状態それぞれの短いラベルを返す', () => {
  assert.equal(getPrBadgePresentation(false).titleLabel, 'PR');
  assert.equal(getPrBadgePresentation(false, { prWaitingMerge: true }).titleLabel, 'マージ待ちのPR');
  assert.equal(getPrBadgePresentation(true).titleLabel, 'マージ済みのPR');
});
