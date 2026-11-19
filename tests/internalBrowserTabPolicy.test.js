'use strict';
// アプリ内ブラウザのタブ（issue #644）の判定だけを切り出した関数の検証。
// 同じページのタブを探す比較、閉じたあとに選ぶタブ、ページの新しいタブ要求を前に出すかを確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_TABS, toTabMatchKey, pickTabAfterClose, shouldForegroundOpenedTab } = require('../utils/internalBrowserTabPolicy');

test('開けるタブは 10 個まで', () => {
  assert.equal(MAX_TABS, 10);
});

test('同じページかの比較では、パスの末尾の / と # 以降を無視する', () => {
  const key = toTabMatchKey('https://github.com/vektor-inc/vk-terminals/pull/1');
  // 末尾の / と # 以降だけが違うものは同じページ
  assert.equal(toTabMatchKey('https://github.com/vektor-inc/vk-terminals/pull/1/'), key);
  assert.equal(toTabMatchKey('https://github.com/vektor-inc/vk-terminals/pull/1#discussion_r1'), key);
  assert.equal(toTabMatchKey('https://github.com/vektor-inc/vk-terminals/pull/1/#top'), key);
  assert.equal(toTabMatchKey('https://GitHub.com/vektor-inc/vk-terminals/pull/1'), key);
  // 検索条件・パス・スキーム・ポートが違えば別のページ
  assert.notEqual(toTabMatchKey('https://github.com/vektor-inc/vk-terminals/pull/1?tab=files'), key);
  assert.notEqual(toTabMatchKey('https://github.com/vektor-inc/vk-terminals/pull/12'), key);
  assert.notEqual(toTabMatchKey('http://github.com/vektor-inc/vk-terminals/pull/1'), key);
  assert.notEqual(toTabMatchKey('https://github.com:8443/vektor-inc/vk-terminals/pull/1'), key);
  // サイトの先頭ページは / の有無を問わない
  assert.equal(toTabMatchKey('https://example.com/'), toTabMatchKey('https://example.com'));
  // 比べられない値は空文字（どのタブとも一致させない）
  for (const value of ['', 'not a url', 'file:///etc/passwd', 'vk-terminals-help://guide/', null, undefined, 1]) {
    assert.equal(toTabMatchKey(value), '');
  }
});

test('閉じたタブの右隣、右が無ければ左隣を選ぶ', () => {
  assert.equal(pickTabAfterClose([1, 2, 3], 2), 3);
  assert.equal(pickTabAfterClose([1, 2, 3], 1), 2);
  assert.equal(pickTabAfterClose([1, 2, 3], 3), 2);
  assert.equal(pickTabAfterClose([4], 4), null);
  assert.equal(pickTabAfterClose([1, 2], 9), null);
});

test('Cmd / Ctrl を押しながらのクリック（background-tab）だけ後ろに開く', () => {
  assert.equal(shouldForegroundOpenedTab('background-tab'), false);
  for (const disposition of ['foreground-tab', 'new-window', 'default', 'other', undefined]) {
    assert.equal(shouldForegroundOpenedTab(disposition), true);
  }
});
