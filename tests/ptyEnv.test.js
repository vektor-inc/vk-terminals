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

const localeOptions = (platform) => ({ platform, homeDir: HOME, dirExists: () => false });

test('macOS でロケール変数がすべて未設定なら文字コードを補う', () => {
  const env = { PATH: '/usr/bin' };
  const result = buildPtyEnv(env, localeOptions('darwin'));
  assert.equal(result.LC_CTYPE, 'en_US.UTF-8');
  assert.equal(Object.hasOwn(result, 'LANG'), false);
  assert.equal(Object.hasOwn(result, 'LC_ALL'), false);
  assert.deepEqual(env, { PATH: '/usr/bin' });
});

test('macOS でロケール変数がすべて空文字なら LC_CTYPE だけ補う', () => {
  const env = { LANG: '', LC_ALL: '', LC_CTYPE: '' };
  const result = buildPtyEnv(env, localeOptions('darwin'));
  assert.deepEqual({ LANG: result.LANG, LC_ALL: result.LC_ALL, LC_CTYPE: result.LC_CTYPE },
    { LANG: '', LC_ALL: '', LC_CTYPE: 'en_US.UTF-8' });
  assert.deepEqual(env, { LANG: '', LC_ALL: '', LC_CTYPE: '' });
});

for (const name of ['LANG', 'LC_ALL', 'LC_CTYPE']) {
  test(`macOS で ${name} に値があればロケール変数を変えない`, () => {
    const env = { [name]: 'ja_JP.UTF-8' };
    const result = buildPtyEnv(env, localeOptions('darwin'));
    for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE']) {
      assert.equal(Object.hasOwn(result, key), Object.hasOwn(env, key));
      assert.equal(result[key], env[key]);
    }
  });
}

for (const platform of ['linux', 'win32']) {
  test(`${platform} ではロケール変数を補わない`, () => {
    const result = buildPtyEnv({}, localeOptions(platform));
    assert.equal(Object.hasOwn(result, 'LC_CTYPE'), false);
  });
}

test('注入した win32 では Volta の PATH も補わない', () => {
  const result = buildPtyEnv({ PATH: '/usr/bin' }, { ...localeOptions('win32'), dirExists: () => true });
  assert.equal(result.PATH, '/usr/bin');
});
