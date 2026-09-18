'use strict';
// 静的ファイル配信の一覧（issue #396 安藤のセキュリティレビュー指摘・LOW-9）に関するテスト。
// 「main.js が配信する表」と「utils/apiAuth.js が認証を免除する集合」が食い違わないこと
// （両方が utils/staticRoutes.js の同じ一覧を参照していること）を確認する。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { STATIC_FILES, SPECIAL_EXEMPT_PATHS, resolveStaticFilePath, allExemptStaticPaths } = require('../utils/staticRoutes');
const { isAuthExemptPath } = require('../utils/apiAuth');

const APP_ROOT = path.join(__dirname, '..');

test('STATIC_FILES の全エントリが実在するファイルを指す（typo・移動漏れの検出）', () => {
  for (const [urlPath, entry] of Object.entries(STATIC_FILES)) {
    const resolved = resolveStaticFilePath(APP_ROOT, entry);
    assert.ok(fs.existsSync(resolved), `${urlPath} の実体 ${resolved} が存在しない`);
  }
});

test('STATIC_FILES の全エントリが contentType を持つ', () => {
  for (const [urlPath, entry] of Object.entries(STATIC_FILES)) {
    assert.equal(typeof entry.contentType, 'string', `${urlPath} に contentType が無い`);
    assert.ok(entry.contentType.length > 0, `${urlPath} の contentType が空文字`);
  }
});

test('allExemptStaticPaths() は SPECIAL_EXEMPT_PATHS と STATIC_FILES のキーをすべて含む', () => {
  const paths = allExemptStaticPaths();
  for (const p of SPECIAL_EXEMPT_PATHS) {
    assert.ok(paths.includes(p), `${p} が allExemptStaticPaths() に含まれない`);
  }
  for (const p of Object.keys(STATIC_FILES)) {
    assert.ok(paths.includes(p), `${p} が allExemptStaticPaths() に含まれない`);
  }
});

test('isAuthExemptPath: allExemptStaticPaths() の全パスが GET で免除される（表と免除集合が同じ正から導かれていることの回帰確認）', () => {
  for (const p of allExemptStaticPaths()) {
    assert.equal(isAuthExemptPath('GET', p), true, `${p} が認証免除されていない`);
  }
});

test('isAuthExemptPath: STATIC_FILES に含まれない任意のパスは免除されない', () => {
  assert.equal(isAuthExemptPath('GET', '/not-a-real-static-file.js'), false);
});
