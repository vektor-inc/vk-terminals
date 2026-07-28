const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const builtinSettingsSchema = require('../../settings-schema.json');
const {
  closeApp,
  getFreePort,
  launchAppAndWait,
} = require('./helpers/electron-app');

const BUILTIN_FIELD_COUNT = builtinSettingsSchema.groups.reduce(
  (count, group) => count + group.fields.length,
  0
);

async function openSettings(win) {
  // 実際の利用操作と同じくサイドバーの設定ボタンをクリックして設定パネルを開く。
  await win.locator('#settings-btn').click();
  await expect(win.locator('.settings-modal')).toBeVisible();
}

async function expectBuiltinSettings(win) {
  // 空でないことに加えてスキーマの全項目との件数一致を確認し、
  // 一部のグループだけが欠落する部分的な劣化も検出する。
  await expect(win.locator('.settings-empty')).toHaveCount(0);
  await expect(win.locator('.settings-row')).toHaveCount(BUILTIN_FIELD_COUNT);
  if (builtinSettingsSchema.tabs) {
    await expect(win.locator('.settings-tab')).toHaveCount(builtinSettingsSchema.tabs.length);
  }
  await expect(win.getByLabel('API ホスト', { exact: true })).toBeVisible();
}

async function saveBuiltinApiHost(win, value) {
  const apiHost = win.getByLabel('API ホスト', { exact: true });
  await apiHost.fill(value);
  await expect(win.locator('#settings-tab-0')).toHaveClass(/is-dirty/);
  await win.locator('.settings-save').click();
  await expect(win.locator('.settings-msg'))
    .toHaveText('保存しました。次回の起動から反映されます。');
  await expect(win.locator('.settings-tab.is-dirty')).toHaveCount(0);
}

test('同梱スキーマの全項目を表示し、編集した値を実際の JSON へ保存できる', async () => {
  const port = await getFreePort();
  let launched;
  try {
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-builtin-regression-',
      env: { VK_TERMINALS_APP_TITLE: '', VK_TERMINALS_SETTINGS: '' },
    });

    await openSettings(launched.win);
    await expectBuiltinSettings(launched.win);

    await saveBuiltinApiHost(launched.win, '127.0.0.2');
    const configPath = path.join(launched.tmpRoot, 'home', '.vk-terminals', 'config.json');
    await expect.poll(() => JSON.parse(fs.readFileSync(configPath, 'utf8')).apiHost)
      .toBe('127.0.0.2');
  } finally {
    if (launched) await closeApp(launched);
  }
});

test('危険な外部ディスクリプタを拒否し、同梱スキーマの全項目へ fallback して保存できる', async () => {
  const descriptorRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'vk-terminals-e2e-unsafe-descriptor-')
  );
  const descriptorPath = path.join(descriptorRoot, 'settings-descriptor.json');
  const unsafeTargetPath = path.join(descriptorRoot, 'unsafe-target.json');
  fs.writeFileSync(descriptorPath, JSON.stringify({
    title: '危険な外部設定',
    targetPath: unsafeTargetPath,
    groups: [{
      label: '危険な設定',
      fields: [{
        key: '__proto__.polluted',
        label: '危険なキー',
        type: 'text',
      }],
    }],
  }), 'utf8');

  const port = await getFreePort();
  let launched;
  try {
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-unsafe-fallback-',
      env: {
        VK_TERMINALS_APP_TITLE: '',
        VK_TERMINALS_SETTINGS: descriptorPath,
      },
    });

    // 不正な定義でもアプリが起動し、設定ボタンを操作できること自体が回帰条件。
    await openSettings(launched.win);
    await expectBuiltinSettings(launched.win);
    await expect(launched.win.getByLabel('危険なキー', { exact: true })).toHaveCount(0);
    await expect(launched.win.locator('.settings-modal')).not.toContainText('危険な外部設定');

    await saveBuiltinApiHost(launched.win, '127.0.0.3');
    const configPath = path.join(launched.tmpRoot, 'home', '.vk-terminals', 'config.json');
    await expect.poll(() => JSON.parse(fs.readFileSync(configPath, 'utf8')).apiHost)
      .toBe('127.0.0.3');
    expect(fs.existsSync(unsafeTargetPath)).toBe(false);
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(descriptorRoot, { recursive: true, force: true });
  }
});

test('安全な外部ディスクリプタは拒否せず、その項目を表示して保存できる', async () => {
  const descriptorRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'vk-terminals-e2e-safe-descriptor-')
  );
  const descriptorPath = path.join(descriptorRoot, 'settings-descriptor.json');
  const targetPath = path.join(descriptorRoot, 'safe-target.json');
  fs.writeFileSync(descriptorPath, JSON.stringify({
    title: '安全な外部設定',
    targetPath,
    groups: [{
      label: '外部設定',
      fields: [{
        key: 'safe.nested',
        label: '安全なキー',
        type: 'text',
      }],
    }],
  }), 'utf8');

  const port = await getFreePort();
  let launched;
  try {
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-safe-descriptor-',
      env: {
        VK_TERMINALS_APP_TITLE: '',
        VK_TERMINALS_SETTINGS: descriptorPath,
      },
    });

    await openSettings(launched.win);
    await expect(launched.win.locator('.settings-modal h2')).toContainText('安全な外部設定');
    await expect(launched.win.locator('.settings-row')).toHaveCount(1);
    await expect(launched.win.getByLabel('危険なキー', { exact: true })).toHaveCount(0);
    const safeInput = launched.win.getByLabel('安全なキー', { exact: true });
    await safeInput.fill('保存できました');
    await launched.win.locator('.settings-save').click();
    await expect(launched.win.locator('.settings-msg'))
      .toHaveText('保存しました。次回の起動から反映されます。');
    await expect.poll(() => JSON.parse(fs.readFileSync(targetPath, 'utf8')).safe.nested)
      .toBe('保存できました');
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(descriptorRoot, { recursive: true, force: true });
  }
});
