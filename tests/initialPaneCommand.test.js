'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isInitialCommandTarget } = require('../utils/initialPaneCommand');

test('起動時の通常の初期ペインだけを初回コマンドの対象にする', () => {
  const options = { initialPane: true, firstTerminalCreated: false, setupLaunch: false, guideLaunch: false };
  assert.equal(isInitialCommandTarget(options), true);
  for (const key of ['firstTerminalCreated', 'setupLaunch', 'guideLaunch']) {
    assert.equal(isInitialCommandTarget({ ...options, [key]: true }), false, key);
  }
  for (const initialPane of [false, undefined, 'true']) {
    assert.equal(isInitialCommandTarget({ ...options, initialPane }), false);
  }
});
