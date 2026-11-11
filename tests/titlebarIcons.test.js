'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const repoRoot = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'renderer', 'index.html'), 'utf8');
const iconSprite = fs.readFileSync(path.join(repoRoot, 'renderer', 'icons', 'ui.svg'), 'utf8');
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const style = fs.readFileSync(path.join(repoRoot, 'renderer', 'style.css'), 'utf8');

test('タイトルバーの操作ボタンは Lucide スプライトを読み上げ対象外で参照する', () => {
  assert.match(indexHtml, /id="menu-btn"[^>]*aria-label="メニュー"[^>]*>[\s\S]*?<svg class="titlebar-icon" aria-hidden="true"><use href="icons\/ui\.svg#menu"><\/use><\/svg>/);
  assert.match(indexHtml, /id="settings-btn"[^>]*aria-label="設定"[^>]*>[\s\S]*?<svg class="titlebar-icon" aria-hidden="true"><use href="icons\/ui\.svg#settings"><\/use><\/svg>/);
});

test('Lucide スプライトは menu と settings のみを currentColor で収録する', () => {
  const symbolIds = [...iconSprite.matchAll(/<symbol id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(symbolIds, ['menu', 'settings']);
  assert.equal((iconSprite.match(/stroke="currentColor"/g) || []).length, 2);
});

test('メニューの使用率警告ドットはアイコン化後もボタン上に表示する', () => {
  assert.match(style, /\.titlebar-menu-btn\.usage-alert-warn::after/);
  assert.match(style, /\.titlebar-menu-btn\.usage-alert-crit::after/);
  assert.match(style, /\.titlebar-menu-btn\.usage-alert-warn,[\s\S]*?position: relative;/);
});

test('Lucide のライセンス全文を同梱し README から案内する', () => {
  const license = fs.readFileSync(path.join(repoRoot, 'renderer', 'icons', 'LICENSE-lucide'), 'utf8');
  assert.match(license, /^ISC License/);
  assert.match(license, /The MIT License \(MIT\)/);
  assert.match(readme, /renderer\/icons\/LICENSE-lucide/);
});
