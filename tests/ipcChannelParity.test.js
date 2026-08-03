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
// クォートはシングル/ダブル/バッククォートのいずれでも拾う（このリポジトリには
// ESLint 設定が無く、クォートの書き方が機械的に強制されていないため、シングル
// クォート決め打ちだと書き方が違うハンドラを黙って抽出漏れする・issue #313 レビュー
// 対応・修正-2）。
function extractHandleChannels(source) {
  return [...source.matchAll(/ipcMain\.handle\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
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

test('前提: ipcMain.handle( の出現回数と抽出できたチャンネル数が一致する（issue #313 レビュー対応・修正-2）', () => {
  // クォートを 3 種とも許容しても、抽出できなかった 1 件だけが漏れるケースは
  // 「件数 > 0」だけでは検出できない。ipcMain.handle( の出現回数そのものと突き合わせ、
  // クォートの書き方が想定外で 1 件でも抽出漏れがあれば気付けるようにする。
  const occurrences = (mainSource.match(/ipcMain\.handle\(/g) || []).length;
  const channels = extractHandleChannels(mainSource);
  assert.equal(
    channels.length,
    occurrences,
    'ipcMain.handle の一部を抽出できていない（クォートの書き方が違う可能性）'
  );
});

// contextBridge の専用ラッパー（shell.openExternal / clipboard.writeText）が
// INVOKE_CHANNELS を経由せず直接 ipcRenderer.invoke(channel, ...) している分だけは、
// この 2 件に限定して明示的に除外する（issue #313 レビュー対応・修正-1）。
const WRAPPER_CHANNELS = new Set(['shell:open-external', 'clipboard:write-text']);

test('main.js の ipcMain.handle チャンネルは INVOKE_CHANNELS（または専用ラッパー）で必ず呼び出し可能', () => {
  // 「preload.js のどこかに文字列として現れるか」で判定すると、間違った許可リスト
  // （例: SEND_CHANNELS）に紛れ込んだ場合を検出できない（重大-1 と同じ形の事故）。
  // INVOKE_CHANNELS への内包で判定し、専用ラッパー経由の 2 件だけを名指しで除外する。
  const handleChannels = extractHandleChannels(mainSource);
  const invokeChannels = extractInvokeChannels(preloadSource) || [];
  const allowed = new Set([...invokeChannels, ...WRAPPER_CHANNELS]);
  const missing = handleChannels.filter((channel) => !allowed.has(channel));
  assert.deepEqual(
    missing,
    [],
    `INVOKE_CHANNELS にも専用ラッパーにも無いチャンネル（renderer から呼べない）: ${missing.join(', ')}`
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
