'use strict';
// main.js（Electron 依存のため require できない）の Web Push 配線（W-1・W-2）に対する
// 回帰テスト（司の指摘・A-12）。
//
// 安藤が main.js の変更部分へ突然変異を7件当てたところ、6件が既存のテスト（すべて
// utils/notificationTrigger.js・utils/webPushKeys.js 側の純粋関数テスト）をすり抜けた。
// main.js 自身は Electron（require('electron')）に依存しているため、このリポジトリの
// テスト環境からは直接 require できない。tests/csp.test.js・tests/mobileNotifyError.test.js
// と同じ方式（ソースをテキストとして読み込み、関数本体を抽出して構造・分岐を固定する）で、
// すり抜けた6件をここで検出できるようにする。
//
// 固定する不変条件（すり抜けた変異との対応）:
//   1. ensurePushReady() は tryLoadExistingVapidKeys() の呼び出し直後に
//      `if (vapidUnavailable) return false;` を持つ（このガードを削除する変異を検出）。
//   2. tryLoadExistingVapidKeys() の形式不正・読み込み失敗の catch は
//      `vapidUnavailable = true` を代入してから return する（この代入を消す変異を検出）。
//   3. 形式不正（isValidVapidKeyPair が false）の分岐は `throw` で catch へ渡す形になって
//      おり、その場で直接 `return false` しない（W-1 の完全な巻き戻しを検出）。
//   4. handleNotificationTriggers() が computeNotificationEvents() へ渡す引数に
//      isFirstReport が含まれる（渡さなくなる変異を検出）。
//   5. handleNotificationTriggers() 内で、isFirstReport の算出（フラグを見る）が
//      notificationBaselineEstablished の更新（フラグを立てる）より先に書かれている
//      （更新を計算より前へ移動する変異を検出）。
//   6. tryLoadExistingVapidKeys() は存在判定に fs.existsSync() を使わず、
//      readFileSync() の catch で e.code === 'ENOENT' を見て「無い」を判定する
//      （司の指摘・A-8。existsSync ベースの存在判定へ戻す変異を検出）。
//
// 安藤の指摘どおり、当てて落ちることを手元で確認済み（確認後はバックアップとの差分
// 比較で main.js を元に戻している。完了報告に手順と結果を記載）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MAIN_JS_PATH = path.join(__dirname, '..', 'main.js');
const source = fs.readFileSync(MAIN_JS_PATH, 'utf8');

// 開始位置から中括弧の対応を数え、関数本体（{ を含む）をソースから丸ごと切り出す
// （tests/mobileNotifyError.test.js と同じ方式）。
function extractFunctionSource(signature) {
  const startIdx = source.indexOf(signature);
  assert.ok(startIdx !== -1, `signature not found in main.js: ${signature}`);
  const braceStart = source.indexOf('{', startIdx);
  assert.ok(braceStart !== -1, `no opening brace after signature: ${signature}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(startIdx, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting: ${signature}`);
}

const ensurePushReadySrc = extractFunctionSource('function ensurePushReady()');
const tryLoadExistingVapidKeysSrc = extractFunctionSource('function tryLoadExistingVapidKeys()');
const handleNotificationTriggersSrc = extractFunctionSource('function handleNotificationTriggers(states)');

test('ensurePushReady(): tryLoadExistingVapidKeys() の直後に vapidUnavailable ガードがある（W-1 のガード削除を検出）', () => {
  const callIdx = ensurePushReadySrc.indexOf('if (tryLoadExistingVapidKeys()) return true;');
  assert.ok(callIdx !== -1, 'tryLoadExistingVapidKeys() の呼び出しが見つからない');
  const afterCall = ensurePushReadySrc.slice(callIdx);
  const guardIdx = afterCall.indexOf('if (vapidUnavailable) return false;');
  assert.ok(guardIdx !== -1, 'tryLoadExistingVapidKeys() の後に vapidUnavailable ガードが無い（W-1 が巻き戻っている）');
  // 鍵生成（webpush.generateVAPIDKeys）より前にガードがあること。
  const generateIdx = afterCall.indexOf('webpush.generateVAPIDKeys()');
  assert.ok(generateIdx !== -1, 'generateVAPIDKeys() の呼び出しが見つからない');
  assert.ok(guardIdx < generateIdx, 'vapidUnavailable ガードが鍵生成より後にあり、無警告の上書きを防げていない');
});

test('tryLoadExistingVapidKeys(): 形式不正・読み込み失敗の catch は vapidUnavailable = true を代入する（代入の削除を検出）', () => {
  const occurrences = tryLoadExistingVapidKeysSrc.match(/vapidUnavailable = true;/g) || [];
  // ENOENT 以外の読み込みエラーの catch と、パース・形式不正の catch の2箇所。
  assert.equal(occurrences.length, 2, `vapidUnavailable = true の代入が2箇所であること（実際: ${occurrences.length}）`);
});

test('tryLoadExistingVapidKeys(): 形式不正は return false ではなく throw で catch へ渡す（W-1 の完全な巻き戻しを検出）', () => {
  const checkIdx = tryLoadExistingVapidKeysSrc.indexOf('if (!isValidVapidKeyPair(raw)) {');
  assert.ok(checkIdx !== -1, 'isValidVapidKeyPair() の形式検証が見つからない');
  const blockStart = tryLoadExistingVapidKeysSrc.indexOf('{', checkIdx);
  const blockEnd = tryLoadExistingVapidKeysSrc.indexOf('}', blockStart);
  const block = tryLoadExistingVapidKeysSrc.slice(blockStart, blockEnd + 1);
  assert.match(block, /throw new Error\(/, '形式不正のとき throw していない（return false に巻き戻っている可能性）');
  assert.doesNotMatch(block, /return false;/, '形式不正のブロックが直接 return false している（vapidUnavailable を立てる catch を経由していない）');
});

test('tryLoadExistingVapidKeys(): 存在判定は fs.existsSync() ではなく readFileSync() の ENOENT で行う（司の指摘・A-8。existsSync への巻き戻しを検出）', () => {
  assert.doesNotMatch(
    tryLoadExistingVapidKeysSrc,
    /fs\.existsSync\(WEBPUSH_KEYS_FILE\)/,
    'fs.existsSync(WEBPUSH_KEYS_FILE) が復活している（親ディレクトリが読めない場合に「無い」と誤認する経路が戻っている）'
  );
  assert.match(
    tryLoadExistingVapidKeysSrc,
    /readError(?:\s*&&\s*readError)?\.code === 'ENOENT'/,
    'readFileSync() の catch で ENOENT を判定していない'
  );
});

test('handleNotificationTriggers(): computeNotificationEvents() へ isFirstReport を渡す（渡さなくなる変異を検出）', () => {
  const callIdx = handleNotificationTriggersSrc.indexOf('computeNotificationEvents({');
  assert.ok(callIdx !== -1, 'computeNotificationEvents() の呼び出しが見つからない');
  const blockStart = handleNotificationTriggersSrc.indexOf('{', callIdx + 'computeNotificationEvents('.length);
  const blockEnd = handleNotificationTriggersSrc.indexOf('});', blockStart);
  assert.ok(blockEnd !== -1, 'computeNotificationEvents() 呼び出しの終端が見つからない');
  const argsBlock = handleNotificationTriggersSrc.slice(blockStart, blockEnd);
  assert.match(argsBlock, /\bisFirstReport\b/, 'computeNotificationEvents() の引数に isFirstReport が渡されていない');
});

test('handleNotificationTriggers(): isFirstReport の算出は notificationBaselineEstablished の更新より前に書かれている（更新を計算前へ移す変異を検出）', () => {
  const computeIdx = handleNotificationTriggersSrc.indexOf('const isFirstReport = !notificationBaselineEstablished;');
  const updateIdx = handleNotificationTriggersSrc.indexOf('notificationBaselineEstablished = true;');
  assert.ok(computeIdx !== -1, 'isFirstReport の算出行が見つからない');
  assert.ok(updateIdx !== -1, 'notificationBaselineEstablished の更新行が見つからない');
  assert.ok(
    computeIdx < updateIdx,
    'notificationBaselineEstablished の更新が isFirstReport の算出より前に来ている（起動後最初の報告を判定できなくなる）'
  );
});
