'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveSettingsToTargets } = require('../settingsTargets');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-permissions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'custom-config.json');
  fs.writeFileSync(file, JSON.stringify({ apiToken: 'dummy', port: 3000 }));
  fs.chmodSync(file, 0o644);
  return file;
}

const posix = { skip: process.platform === 'win32' };
test('起動時: 解決された設定ファイルの 644 を 600 に修復する', posix, (t) => {
  const file = fixture(t);
  const { repairTokenConfigPermissions } = require('../utils/configFilePermissions');
  repairTokenConfigPermissions(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('設定保存: apiToken を含む既存ファイルを 600 にそろえる', posix, (t) => {
  const file = fixture(t);
  const result = saveSettingsToTargets({ targetPath: file, groups: [{ fields: [{ key: 'port', type: 'number' }] }] }, { port: 4000 });
  assert.equal(result.ok, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

const { repairTokenConfigPermissions } = require('../utils/configFilePermissions');
test('起動時: 安全な権限では chmod せず、Windows では FS に触らない', () => {
  const fsImpl = {
    openSync: () => 5,
    fstatSync: () => ({ mode: 0o600, isFile: () => true }),
    fchmodSync: () => assert.fail('unnecessary chmod'),
    closeSync: () => {},
  };
  repairTokenConfigPermissions('unused', { fsImpl, platform: 'darwin' });
  repairTokenConfigPermissions('unused', { fsImpl: {}, platform: 'win32' });
});

for (const operation of ['openSync', 'fstatSync', 'fchmodSync', 'closeSync']) {
  test(`起動時: ${operation} の失敗は秘密情報を含まない警告のみ`, () => {
    const warnings = [];
    let closed = false;
    const fsImpl = {
      openSync: () => 5,
      fstatSync: () => ({ mode: 0o644, isFile: () => true }),
      fchmodSync: () => {},
      closeSync: () => { closed = true; },
    };
    fsImpl[operation] = () => { throw new Error('sensitive error details'); };
    assert.doesNotThrow(() => repairTokenConfigPermissions('unused', {
      fsImpl, platform: 'darwin', warn: (...args) => warnings.push(args),
    }));
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].length, 1);
    assert.ok(!JSON.stringify(warnings).includes('sensitive'));
    if (operation === 'fstatSync' || operation === 'fchmodSync') assert.equal(closed, true);
  });
}

test('起動時: シンボリックリンクを保持して実体を修復する', posix, (t) => {
  const file = fixture(t);
  const link = `${file}.link`;
  fs.symlinkSync(file, link);
  repairTokenConfigPermissions(link);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('起動時: 消えたファイルは作成せず警告のみ', posix, (t) => {
  const file = fixture(t);
  fs.unlinkSync(file);
  const warnings = [];
  repairTokenConfigPermissions(file, { warn: (message) => warnings.push(message) });
  assert.equal(fs.existsSync(file), false);
  assert.equal(warnings.length, 1);
});

for (const hasToken of [true, false]) {
  test(`設定保存: ${hasToken ? 'トークン有りは 600 を維持' : 'トークン無しは既存権限を維持'}`, posix, (t) => {
    const file = fixture(t);
    if (hasToken) fs.chmodSync(file, 0o600);
    else fs.writeFileSync(file, JSON.stringify({ port: 3000 }));
    const result = saveSettingsToTargets({ targetPath: file, groups: [{ fields: [{ key: 'port', type: 'number' }] }] }, { port: 4000 });
    assert.equal(result.ok, true);
    assert.equal(fs.statSync(file).mode & 0o777, hasToken ? 0o600 : 0o644);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).port, 4000);
  });
}

// Electron を起動せず実際の起動分岐を実行し、再発行経路との二重処理を検出する。
const vm = require('vm');
const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const ensureSource = mainSource.slice(mainSource.indexOf('function ensureApiToken() {'), mainSource.indexOf('// ─── Web Push（issue #396）:'));
for (const scenario of ['valid', 'invalid', 'missing', 'unreadable']) {
  test(`起動配線: ${scenario} の既存トークン`, () => {
    let repaired = 0;
    let persisted = 0;
    const configPath = '/temporary/custom-config.json';
    const context = {
      resolveTokenConfigPath: () => configPath,
      readJsonObject: () => {
        if (scenario === 'unreadable') throw new Error('read failed');
        return scenario === 'missing' ? {} : { apiToken: scenario };
      },
      isValidApiTokenFormat: (value) => value === 'valid',
      generateApiToken: () => 'replacement',
      persistApiToken: () => { persisted++; return true; },
      repairTokenConfigPermissions: (target) => { assert.equal(target, configPath); repaired++; },
      console: { warn() {}, error() {} }, LOG_PREFIX: '[test]',
    };
    const result = vm.runInNewContext(`${ensureSource}\nensureApiToken()`, context);
    assert.equal(result.persisted, true);
    assert.equal(repaired, scenario === 'valid' ? 1 : 0);
    assert.equal(persisted, scenario === 'valid' ? 0 : 1);
  });
}
