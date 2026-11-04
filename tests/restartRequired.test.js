'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeRestartRequired, readRestartRequired } = require('../utils/restartRequired');

const tabs = ['general', 'mobile'];
test('再起動状態は既知のタブだけを重複なしで受け取る', () => {
  assert.deepEqual(normalizeRestartRequired({ restartRequired: true, tabs: ['unknown', 'mobile', 'mobile', 'general'] }, tabs), { restartRequired: true, tabs: ['mobile', 'general'] });
  assert.deepEqual(normalizeRestartRequired({ restartRequired: true, tabs: ['unknown'] }, tabs), { restartRequired: false, tabs: [] });
  assert.deepEqual(normalizeRestartRequired({ restartRequired: false, tabs: ['general'] }, tabs), { restartRequired: false, tabs: [] });
});

test('状態ファイルが無い・壊れている場合は表示しない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-restart-test-'));
  try {
    const file = path.join(dir, 'status.json');
    assert.deepEqual(readRestartRequired(file, tabs), { restartRequired: false, tabs: [] });
    fs.writeFileSync(file, '{');
    assert.deepEqual(readRestartRequired(file, tabs), { restartRequired: false, tabs: [] });
    fs.writeFileSync(file, JSON.stringify({ restartRequired: true, tabs: ['general'] }));
    assert.deepEqual(readRestartRequired(file, tabs), { restartRequired: true, tabs: ['general'] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('更新後の再起動と設定パネルからの再起動は共通関数を呼ぶ', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const update = source.slice(source.indexOf('async function checkAndUpdate()'), source.indexOf('// ─── renderer 起動時'));
  const ipc = source.slice(source.indexOf("ipcMain.handle('app:restart',"), source.indexOf("ipcMain.handle('settings:api-server-status'"));
  assert.match(update, /await restartApplication\(\)/);
  assert.match(ipc, /return restartApplication\(\)/);
  assert.match(source, /async function restartApplication\(\)[\s\S]*?markShuttingDown\(\)[\s\S]*?await cleanupPtys\(\)[\s\S]*?app\.relaunch\(\)[\s\S]*?app\.exit\(0\)/);
});
