'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getSettingsVersionLabel } = require('../renderer/settingsVersionLabel');

test('getSettingsVersionLabel: 指定された文字列をそのまま返す', () => {
  assert.equal(getSettingsVersionLabel('VK Orchestrator v0.57.1', '1.81.0'), 'VK Orchestrator v0.57.1');
});

test('getSettingsVersionLabel: 未指定ならアプリ版の既定表示を返す', () => {
  assert.equal(getSettingsVersionLabel(undefined, '1.81.0'), 'VK Terminals v1.81.0');
});

test('getSettingsVersionLabel: 空文字と空白のみなら既定表示を返す', () => {
  assert.equal(getSettingsVersionLabel('', '1.81.0'), 'VK Terminals v1.81.0');
  assert.equal(getSettingsVersionLabel(' \n\t ', '1.81.0'), 'VK Terminals v1.81.0');
});

test('getSettingsVersionLabel: 文字列以外なら既定表示を返す', () => {
  for (const value of [123, null, {}, []]) {
    assert.equal(getSettingsVersionLabel(value, '1.81.0'), 'VK Terminals v1.81.0');
  }
});

test('getSettingsVersionLabel: versionLabel も appVersion も無ければ空文字を返す', () => {
  assert.equal(getSettingsVersionLabel(undefined, undefined), '');
});

test('設定画面は HTML を含む versionLabel を escText でエスケープして描画する', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.match(
    appSource,
    /settingsVersionLabel\s*\?\s*`<span class="settings-version">\$\{escText\(settingsVersionLabel\)\}<\/span>`/
  );
  assert.equal(getSettingsVersionLabel('<img src=x onerror=alert(1)>', '1.81.0'), '<img src=x onerror=alert(1)>');
});
