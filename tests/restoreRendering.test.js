'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const start = source.indexOf('function classifyRenderedRestorePanes(');
const end = source.indexOf('\nasync function initApp()', start);
assert.ok(start >= 0 && end > start);
const classify = vm.runInNewContext(`(${source.slice(start, end).trim()})`);

test('復元描画が全滅したら初期ペインへ進み、警告は一度だけ', () => {
  const result = classify([{ id: '1', paneId: 'pane-1' }], {});
  assert.deepEqual(Array.from(result.ready), []);
  assert.deepEqual(Array.from(result.abandoned), ['1']);
  assert.equal(result.needsInitialPane, true);
  assert.equal(result.warningCount, 1);
  assert.match(source.slice(end), /if \(Object\.keys\(terminals\)\.length\) return;[\s\S]*?showRestoreWarning\(restored\?\.missing\)/);
});

test('一部描画できたら失敗した番号のみ除外する', () => {
  const result = classify([{ id: '1', paneId: 'pane-1' }, { id: '2', paneId: 'pane-2' }], { 'pane-1': {} });
  assert.deepEqual(Array.from(result.ready), ['1']);
  assert.deepEqual(Array.from(result.abandoned), ['2']);
  assert.equal(result.needsInitialPane, false);
  assert.equal(result.warningCount, 1);
});

// 復元ペインが残る場合は、設定に関係なく initApp の初期ペイン作成へ進まない。
test('復元に成功した場合は初期ペインを追加しない', () => {
  const initApp = source.slice(end, source.indexOf("VKIpc.on('terminal:request-new-pane'", end));
  assert.match(initApp, /if \(Object\.keys\(terminals\)\.length\) return;/);
  assert.ok(initApp.indexOf('if (Object.keys(terminals).length) return;') < initApp.indexOf('if (!openAsSetupPane && !openInitialPane)'));
});
