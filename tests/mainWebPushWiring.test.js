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
//
// 追加した不変条件（安藤の7ラウンド目レビュー・B-1・B-2）:
//   7. logInvalidVapidKeyFile() は e.code の許可リスト（EACCES のみ特別扱い）で判定しない
//      （B-1。EPERM・EBUSY 等の取りこぼしを検出）。
//   8. tryLoadExistingVapidKeys() の読み込み失敗（ENOENT 以外）の catch は
//      logInvalidVapidKeyFile() を readFailed: true 付きで呼び、形式不正の catch は
//      readFailed を渡さずに呼ぶ（B-1。呼び出し元の区別が失われる変異を検出）。
//   9. logInvalidVapidKeyFile() の readFailed 側の案内は削除を勧めない（B-1）。
//   10. sanitizeFileReadErrorForLog() は utils/fileReadError.js から読み込み、main.js 内に
//       再定義していない（B-2。切り出しの巻き戻しを検出）。
//   11. loadPushSubscriptions() と logInvalidVapidKeyFile() は、ログへ渡す前に必ず
//       sanitizeFileReadErrorForLog(e) を経由する（B-2。e を直接渡す形へ戻す変異を検出）。

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
const logInvalidVapidKeyFileSrc = extractFunctionSource('function logInvalidVapidKeyFile(e, options)');
const loadPushSubscriptionsSrc = extractFunctionSource('function loadPushSubscriptions()');

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

// ─── B-1（司の指摘。安藤の7ラウンド目レビュー） ──────────────────────────────
// logInvalidVapidKeyFile() が e.code === 'EACCES' だけを権限エラーとして分岐していたため、
// EPERM・EBUSY・EIO 等の他の読み込みエラーがすべて「削除して再生成」側の案内へ落ちていた
// 問題（A-11 の取りこぼし）への回帰保護。

test('logInvalidVapidKeyFile(): e.code の許可リスト判定（EACCES のみ特別扱い）を行わない（B-1。EPERM/EBUSY 等の取りこぼしを検出）', () => {
  assert.doesNotMatch(
    logInvalidVapidKeyFileSrc,
    /e\.code === 'EACCES'/,
    "e.code === 'EACCES' の判定が残っている（EPERM 等、他のエラー種別が削除案内側へ落ちる）"
  );
});

test('tryLoadExistingVapidKeys(): 読み込み失敗（ENOENT 以外）の catch は logInvalidVapidKeyFile() を readFailed: true で呼ぶ（B-1。読み込み失敗と形式不正の呼び出し元を区別する）', () => {
  assert.match(
    tryLoadExistingVapidKeysSrc,
    /logInvalidVapidKeyFile\(readError,\s*\{\s*readFailed:\s*true\s*\}\)/,
    'readFileSync() の catch が readFailed: true を渡していない'
  );
});

test('tryLoadExistingVapidKeys(): 形式不正（JSON パース失敗・鍵の形式検証失敗）の catch は readFailed を渡さずに呼ぶ（B-1。読み込み失敗と同じ扱いに戻す変異を検出）', () => {
  const occurrences = [...tryLoadExistingVapidKeysSrc.matchAll(/logInvalidVapidKeyFile\(([^)]*)\)/g)];
  assert.equal(occurrences.length, 2, `logInvalidVapidKeyFile() の呼び出しが2箇所であること（実際: ${occurrences.length}）`);
  const readFailedCalls = occurrences.filter((m) => /readFailed/.test(m[1]));
  const otherCalls = occurrences.filter((m) => !/readFailed/.test(m[1]));
  assert.equal(readFailedCalls.length, 1, 'readFailed を渡す呼び出しが1箇所であること');
  assert.equal(otherCalls.length, 1, 'readFailed を渡さない呼び出しが1箇所であること');
});

test('logInvalidVapidKeyFile(): readFailed 側の案内は削除を勧めず、権限・入出力の修正と再起動だけを案内する（B-1）', () => {
  const ifIdx = logInvalidVapidKeyFileSrc.indexOf('if (readFailed) {');
  assert.ok(ifIdx !== -1, 'readFailed の分岐が見つからない');
  const returnIdx = logInvalidVapidKeyFileSrc.indexOf('return;', ifIdx);
  assert.ok(returnIdx !== -1, 'readFailed 分岐の return が見つからない');
  const block = logInvalidVapidKeyFileSrc.slice(ifIdx, returnIdx);
  assert.doesNotMatch(block, /delete/i, 'readFailed 側の案内に削除の案内が含まれている（形式不正側の案内と混同している）');
  assert.match(block, /restart/i, 'readFailed 側の案内に再起動の案内が含まれていない');
});

test('logInvalidVapidKeyFile(): readFailed でない場合（形式不正）は、従来どおりバックアップから復元／削除して再生成の2択を案内する（B-1）', () => {
  const ifIdx = logInvalidVapidKeyFileSrc.indexOf('if (readFailed) {');
  const returnIdx = logInvalidVapidKeyFileSrc.indexOf('return;', ifIdx);
  const afterReadFailedBlock = logInvalidVapidKeyFileSrc.slice(returnIdx);
  assert.match(afterReadFailedBlock, /restore/i, '形式不正側の案内にバックアップから復元する案内が含まれていない');
  assert.match(afterReadFailedBlock, /delete/i, '形式不正側の案内に削除して再生成する案内が含まれていない');
});

// ─── B-2（司の指摘。安藤の7ラウンド目レビュー） ──────────────────────────────
// sanitizeFileReadErrorForLog() を main.js から utils/fileReadError.js へ切り出したことへの
// 回帰保護。切り出しの巻き戻し（main.js 内への再定義）と、2つの呼び出し元（鍵ファイル側・
// 購読情報ファイル側）がこの関数を経由しなくなる変異の両方を検出する。

test('main.js: sanitizeFileReadErrorForLog は utils/fileReadError.js から読み込み、main.js 内に再定義していない（B-2。切り出しの巻き戻しを検出）', () => {
  assert.match(
    source,
    /require\(['"]\.\/utils\/fileReadError['"]\)/,
    'utils/fileReadError.js からの require が見つからない'
  );
  assert.doesNotMatch(
    source,
    /function sanitizeFileReadErrorForLog\(/,
    'main.js 内に sanitizeFileReadErrorForLog のローカル定義が残っている（utils/ への切り出しが巻き戻っている）'
  );
});

test('loadPushSubscriptions(): 読み込み失敗のログは sanitizeFileReadErrorForLog(e) を経由する（B-2。e をそのまま渡す形へ戻す変異を検出）', () => {
  assert.match(
    loadPushSubscriptionsSrc,
    /console\.error\(\s*[\s\S]*?sanitizeFileReadErrorForLog\(e\)/,
    'console.error() が sanitizeFileReadErrorForLog(e) を経由していない'
  );
});

test('logInvalidVapidKeyFile(): safeError（sanitizeFileReadErrorForLog(e) の結果）を算出してから console.error() へ渡す。e を直接渡す変異を検出（B-2）', () => {
  assert.match(
    logInvalidVapidKeyFileSrc,
    /const safeError = sanitizeFileReadErrorForLog\(e\);/,
    'safeError の算出が sanitizeFileReadErrorForLog(e) を経由していない'
  );
  const consoleErrorCalls = logInvalidVapidKeyFileSrc.match(/console\.error\(/g) || [];
  assert.equal(consoleErrorCalls.length, 2, `console.error() の呼び出しが2箇所であること（実際: ${consoleErrorCalls.length}）`);
  assert.doesNotMatch(
    logInvalidVapidKeyFileSrc,
    /console\.error\(\s*[\s\S]*?,\s*e\s*\);/,
    'console.error() が safeError ではなく e を直接渡している箇所がある'
  );
});
