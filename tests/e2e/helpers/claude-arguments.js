const assert = require('node:assert/strict');
const path = require('node:path');

// 起動ごとのフック設定だけを検証して除き、モデルなど本来の引数を比較する。
function withoutBackgroundWorkSettings(args) {
  const remaining = [...args];
  const index = remaining.indexOf('--settings');
  if (index < 0) return remaining;
  const filename = remaining[index + 1];
  assert.equal(typeof filename, 'string');
  assert.ok(path.isAbsolute(filename), 'settings は絶対パスであること');
  assert.match(filename, /\/\.vk-terminals\/background-work-[A-Za-z0-9]+\/settings\.json$/);
  remaining.splice(index, 2);
  assert.ok(!remaining.includes('--settings'), 'settings の重複を許可しない');
  return remaining;
}

module.exports = { withoutBackgroundWorkSettings };
