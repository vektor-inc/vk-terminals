'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveSettingsToTargets } = require('../settingsTargets');
const { describeErrorKind } = require('../utils/errorKind');
const { repairTokenConfigPermissions, repairOtherTokenConfigPermissions } = require('../utils/configFilePermissions');

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
  repairTokenConfigPermissions(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('設定保存: apiToken を含む既存ファイルを 600 にそろえる', posix, (t) => {
  const file = fixture(t);
  const result = saveSettingsToTargets({ targetPath: file, groups: [{ fields: [{ key: 'port', type: 'number' }] }] }, { port: 4000 });
  assert.equal(result.ok, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

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
  for (const saveSucceeds of [true, false]) {
    for (const fileExists of [true, false]) {
      test(`起動配線: ${scenario} / 保存成功=${saveSucceeds} / ファイル有り=${fileExists}`, () => {
        const errors = [];
        let repaired = 0;
        let candidatesChecked = 0;
        let persisted = 0;
        const configPath = '/temporary/custom-config.json';
        const context = {
          resolveTokenConfigPath: () => configPath,
          userConfigCandidatePaths: () => [configPath, '/temporary/lower.json'],
          repairOtherTokenConfigPermissions: (candidates, selected) => {
            candidatesChecked++;
            assert.deepEqual(Array.from(candidates), [configPath, '/temporary/lower.json']);
            assert.equal(selected, configPath);
          },
          fs: { existsSync: (target) => { assert.equal(target, configPath); return fileExists; } },
          readJsonObject: () => {
            if (scenario === 'unreadable') throw Object.assign(new Error('private input fragment'), { code: 'EACCES' });
            return scenario === 'missing' ? {} : { apiToken: scenario };
          },
          isValidApiTokenFormat: (value) => value === 'valid',
          generateApiToken: () => 'replacement',
          persistApiToken: () => { persisted++; return saveSucceeds; },
          repairTokenConfigPermissions: (target) => { assert.equal(target, configPath); repaired++; },
          describeErrorKind,
          console: { warn() {}, error: (...args) => errors.push(args) }, LOG_PREFIX: '[test]',
        };
        const result = vm.runInNewContext(`${ensureSource}\nensureApiToken()`, context);
        if (scenario === 'unreadable') assert.deepEqual(errors, [[`[test] Failed to read existing API token: ${configPath}`, 'EACCES']]);
        assert.equal(candidatesChecked, 1);
        assert.equal(result.persisted, scenario === 'valid' || saveSucceeds);
        assert.equal(repaired, scenario === 'valid' || (!saveSucceeds && fileExists) ? 1 : 0);
        assert.equal(persisted, scenario === 'valid' ? 0 : 1);
      });
    }
  }
}

// 所有者以外への読み取り権限と、通常ファイルの判定をそれぞれ確認する。
test('起動時: 640 のグループ読み取り権限も修復する', posix, (t) => {
  const file = fixture(t);
  fs.chmodSync(file, 0o640);
  repairTokenConfigPermissions(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('起動時: 非通常ファイルには fchmod せず FD を閉じる', () => {
  let closed = false;
  let chmodCalls = 0;
  repairTokenConfigPermissions('unused', { platform: 'darwin', fsImpl: {
    openSync: () => 5,
    fstatSync: () => ({ mode: 0o644, isFile: () => false }),
    fchmodSync: () => { chmodCalls++; },
    closeSync: () => { closed = true; },
  } });
  assert.equal(closed, true);
  assert.equal(chmodCalls, 0);
});

test('設定保存: 一時ファイルを作成時から 600・排他作成で保護する', (t) => {
  const file = fixture(t);
  const writes = [];
  const originalWrite = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (target, data, options) => {
    if (target !== file) writes.push(options);
    return originalWrite(target, data, options);
  });
  const result = saveSettingsToTargets({ targetPath: file, groups: [{ fields: [{ key: 'port', type: 'number' }] }] }, { port: 4000 });
  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.mode, 0o600);
  assert.equal(writes[0]?.flag, 'wx');
});

// FS の原因と JSON の分類を、例外本文を含めずに保持する。
test('エラー分類は code、name、既定値の順に選ぶ', () => {
  assert.equal(describeErrorKind({ code: 'EACCES' }), 'EACCES');
  assert.equal(describeErrorKind(new SyntaxError('private input fragment')), 'SyntaxError');
  assert.equal(describeErrorKind(null), 'UnknownError');
});

for (const mode of [0o604, 0o620]) {
  test(`起動時: ${mode.toString(8)} の権限を修復する`, posix, (t) => {
    const file = fixture(t);
    fs.chmodSync(file, mode);
    repairTokenConfigPermissions(file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
}

// 本体の各 catch を実行し、ログを例外そのものに戻す変更も検出する。
for (const [start, end, invoke] of [
  ['function persistApiToken(token) {', '// 起動時にアクセストークンを確保する', 'persistApiToken("dummy")'],
  ['function loadUserConfig() {', '// app が ready になる前に', 'loadUserConfig()'],
]) {
  for (const error of [Object.assign(new Error('private input fragment'), { code: 'EACCES' }), new SyntaxError('private input fragment')]) {
    test(`ログ分類: ${invoke.split('(')[0]} / ${describeErrorKind(error)}`, () => {
      const errors = [];
      const source = mainSource.slice(mainSource.indexOf(start), mainSource.indexOf(end, mainSource.indexOf(start)));
      vm.runInNewContext(`${source}\n${invoke}`, {
        describeErrorKind, path, process, LOG_PREFIX: '[test]',
        resolveTokenConfigPath: () => '/temporary/config.json',
        userConfigCandidatePaths: () => ['/temporary/config.json'], USER_CONFIG_MAX_BYTES: 1024,
        fs: { existsSync: () => true, unlinkSync() {} },
        readJsonObject: () => { throw error; }, readSmallJson: () => { throw error; },
        console: { error: (...args) => errors.push(args) },
      });
      assert.equal(errors.length, 1);
      assert.equal(errors[0].join(' ').includes('private input fragment'), false);
      assert.equal(errors[0][1], describeErrorKind(error));
      assert.equal(errors[0].length, 2);
    });
  }
}

test('ログ分類: settings:describe の読み込み失敗', () => {
  const start = mainSource.indexOf("ipcMain.handle('settings:describe',");
  const end = mainSource.indexOf('  const targetInfo', start);
  for (const error of [Object.assign(new Error('private input fragment'), { code: 'EACCES' }), new SyntaxError('private input fragment')]) {
    const errors = [];
    vm.runInNewContext(`${mainSource.slice(start, end)}\n});`, {
      ipcMain: { handle: (_name, callback) => callback() },
      loadSettingsDescriptor: () => ({}),
      describeSettingsValues: (_descriptor, options) => options.onReadError('/temporary/config.json', error),
      describeErrorKind, LOG_PREFIX: '[test]', console: { error: (...args) => errors.push(args) },
    });
    assert.deepEqual(errors, [['[test] Failed to read target config: /temporary/config.json', describeErrorKind(error)]]);
  }
});

// 全候補を一時ディレクトリに用意し、下位候補だけの修復を確認する。
test('下位候補: 最上位の文字列 apiToken のみ修復し、壊れた候補の後も続行する', posix, (t) => {
  const selected = fixture(t);
  const dir = path.dirname(selected);
  const entries = [
    ['broken.json', '{'],
    ['without.json', JSON.stringify({ port: 3000 })],
    ['nested.json', JSON.stringify({ nested: { apiToken: 'dummy' } })],
    ['number.json', JSON.stringify({ apiToken: 123 })],
    ['null.json', 'null'],
    ['app.json', JSON.stringify({ apiToken: 'dummy' })],
    ['legacy.json', JSON.stringify({ apiToken: '' })],
  ];
  const candidates = entries.map(([name, content]) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    fs.chmodSync(file, 0o644);
    return file;
  });
  const before = candidates.map(file => fs.readFileSync(file, 'utf8'));
  assert.doesNotThrow(() => repairOtherTokenConfigPermissions([selected, path.join(dir, 'missing.json'), ...candidates], selected));
  assert.equal(fs.statSync(selected).mode & 0o777, 0o644);
  candidates.forEach((file, index) => {
    assert.equal(fs.statSync(file).mode & 0o777, index >= 5 ? 0o600 : 0o644);
    assert.equal(fs.readFileSync(file, 'utf8') === before[index], true);
  });
});

test('下位候補: 読み取り失敗を握り、次の候補を修復する', () => {
  const repaired = [];
  assert.doesNotThrow(() => repairOtherTokenConfigPermissions(['unreadable', 'next'], 'selected', {
    platform: 'darwin', fsImpl: {
      existsSync: () => true,
      readFileSync: (file) => {
        if (file === 'unreadable') throw new Error('private input fragment');
        return JSON.stringify({ apiToken: 'dummy' });
      },
      openSync: (file) => { repaired.push(file); return 5; },
      fstatSync: () => ({ mode: 0o644, isFile: () => true }),
      fchmodSync: () => {}, closeSync: () => {},
    },
  }));
  assert.deepEqual(repaired, ['next']);
});
