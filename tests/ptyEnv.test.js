'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { buildPtyEnv } = require('../utils/ptyEnv');

const HOME = path.join(path.sep, 'home', 'tester');
const VOLTA_BIN = path.join(HOME, '.volta', 'bin');
const posixOnly = { skip: process.platform === 'win32' };

test('TERM_PROGRAM を付け、元の環境変数は変更しない', () => {
  const env = { PATH: '/usr/bin', FOO: 'bar' };
  const result = buildPtyEnv(env, { homeDir: HOME, dirExists: () => false });
  assert.equal(result.TERM_PROGRAM, 'VKTerminals');
  assert.equal(result.FOO, 'bar');
  assert.equal(result.PATH, '/usr/bin');
  assert.equal(env.TERM_PROGRAM, undefined);
});

test('Volta の bin が実在し PATH に無ければ末尾へ補う', posixOnly, () => {
  const result = buildPtyEnv({ PATH: '/usr/bin:/bin' }, { homeDir: HOME, dirExists: (p) => p === VOLTA_BIN });
  assert.equal(result.PATH, `/usr/bin:/bin:${VOLTA_BIN}`);
});

test('Volta の bin が既に PATH にあれば重複させない', posixOnly, () => {
  const original = `${VOLTA_BIN}:/usr/bin`;
  const result = buildPtyEnv({ PATH: original }, { homeDir: HOME, dirExists: () => true });
  assert.equal(result.PATH, original);
});

test('Volta の bin が存在しなければ PATH を変えない', posixOnly, () => {
  const result = buildPtyEnv({ PATH: '/usr/bin' }, { homeDir: HOME, dirExists: () => false });
  assert.equal(result.PATH, '/usr/bin');
});

test('VOLTA_HOME が指定されていればそちらの bin を使う', posixOnly, () => {
  const custom = path.join(path.sep, 'opt', 'volta');
  const result = buildPtyEnv(
    { PATH: '/usr/bin', VOLTA_HOME: custom },
    { homeDir: HOME, dirExists: (p) => p === path.join(custom, 'bin') },
  );
  assert.equal(result.PATH, `/usr/bin:${path.join(custom, 'bin')}`);
});

test('PATH が未設定でも Volta の bin だけの PATH を作る', posixOnly, () => {
  const result = buildPtyEnv({}, { homeDir: HOME, dirExists: () => true });
  assert.equal(result.PATH, VOLTA_BIN);
});
