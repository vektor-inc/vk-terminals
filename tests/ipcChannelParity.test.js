'use strict';
// main.js の ipcMain.handle(...) と preload.js の許可リスト（INVOKE_CHANNELS）の対応を
// 検証する（issue #313 レビュー対応・テスト-2）。
//
// 経緯: main.js に settings:api-token-info / settings:reissue-api-token の
// ipcMain.handle を追加したが、preload.js の INVOKE_CHANNELS への追加を忘れていた
// （preload.js 自身に「main 側にハンドラを足したら、ここにも足すこと」と明記されている
// のに、である）。renderer 側は preload の許可リストに無いチャンネルへの invoke を
// silently reject し、呼び出し側の catch (_e) { return null; } が何も起きなかったかの
// ように握りつぶすため、単体テストが 400 件以上緑のまま素通りした。
//
// main.js は Electron に依存するため require できない（tests/apiAuth.test.js 等と同じ
// 事情）。ここではソースコードをテキストとして読み、正規表現でチャンネル名を抽出して
// 突き合わせる。Electron を起動しない軽量な静的チェックにすることで、今後 IPC
// チャンネルを追加・削除するたびに必ず走る回帰テストにする。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

// main.js が ipcMain.handle(...) で登録している全チャンネル名。
function extractHandleChannels(source) {
  return [...source.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]);
}

// preload.js の `const INVOKE_CHANNELS = new Set([...])` から要素を抽出する。
function extractInvokeChannels(source) {
  const match = source.match(/const INVOKE_CHANNELS = new Set\(\[([\s\S]*?)\]\)/);
  if (!match) return null;
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('前提: main.js から ipcMain.handle のチャンネルを抽出できる', () => {
  const channels = extractHandleChannels(mainSource);
  // 抽出そのものが 0 件だと、正規表現がずれて何もチェックしていないのに全部緑になる
  // （まさに重大-1 が起きた形）ため、抽出できていること自体を先に確認する。
  assert.ok(channels.length > 0, 'ipcMain.handle の抽出结果が空。正規表現がずれている可能性がある');
});

test('main.js の ipcMain.handle チャンネルはすべて preload.js のどこかに文字列として現れる', () => {
  // 「INVOKE_CHANNELS に載っている」だけでなく、shell:open-external /
  // clipboard:write-text のように専用ラッパー（contextBridge 経由の shell.openExternal /
  // clipboard.writeText）で直接 ipcRenderer.invoke(channel, ...) しているチャンネルも
  // 正当に許可されているため、判定は「preload.js のソースにチャンネル名の文字列
  // リテラルが存在するか」で行う（INVOKE_CHANNELS への内包を強制しない）。
  const handleChannels = extractHandleChannels(mainSource);
  const missing = handleChannels.filter((channel) => !preloadSource.includes(`'${channel}'`));
  assert.deepEqual(
    missing,
    [],
    `preload.js のどこにも現れないチャンネル（renderer から呼べない）: ${missing.join(', ')}`
  );
});

test('preload.js の INVOKE_CHANNELS は main.js に存在しないチャンネルを含まない（死んだエントリの検出）', () => {
  const invokeChannels = extractInvokeChannels(preloadSource);
  assert.ok(invokeChannels, 'preload.js の INVOKE_CHANNELS 定義を抽出できなかった（定義の書式が変わった可能性）');
  const handleChannelSet = new Set(extractHandleChannels(mainSource));
  const stale = invokeChannels.filter((channel) => !handleChannelSet.has(channel));
  assert.deepEqual(
    stale,
    [],
    `main.js に対応する ipcMain.handle が無い INVOKE_CHANNELS エントリ: ${stale.join(', ')}`
  );
});

test('settings:api-token-info と settings:reissue-api-token が preload.js の INVOKE_CHANNELS にある（重大-1 の直接的な回帰チェック）', () => {
  const invokeChannels = extractInvokeChannels(preloadSource) || [];
  assert.ok(invokeChannels.includes('settings:api-token-info'));
  assert.ok(invokeChannels.includes('settings:reissue-api-token'));
});
