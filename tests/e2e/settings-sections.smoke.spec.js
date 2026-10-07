const { test, expect } = require('@playwright/test');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');
const {
  installDescriptorRecordingSaves,
  lastSavedPayload,
  restoreInvoke,
} = require('./helpers/settings-descriptor');

// issue #421: 項目の section 属性で、1 つのグループの中を内側 fieldset + legend の区分に分ける。
test.describe.serial('設定パネル: 項目の区分（section）の描画（issue #421）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-sections-',
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test.beforeEach(async () => {
    await win.reload();
    await win.waitForSelector('#sidebar', { state: 'attached' });
  });

  test.afterEach(async () => {
    await restoreInvoke(win);
  });

  const baseDescriptor = (groups, values) => ({
    available: true,
    title: '区分確認',
    note: '',
    targetPath: '/tmp/settings-sections.json',
    appVersion: '0.0.0-test',
    groups,
    values,
  });

  test('区分を内側の fieldset と legend で描き、説明文を aria-describedby で関連づける', async () => {
    await installDescriptorRecordingSaves(win, baseDescriptor([{
      label: '外側グループ',
      fields: [
        { key: 'lead', label: '区分外の欄', type: 'text' },
        {
          key: 'a1',
          label: '欄A1',
          type: 'text',
          section: { label: '区分一', description: '区分一の説明です。' },
        },
        { key: 'a2', label: '欄A2', type: 'text' },
        // 説明文なし。型が不正な description は空として扱い aria-describedby を付けない。
        { key: 'b1', label: '欄B1', type: 'text', section: { label: '<b>区分二</b>', description: 5 } },
        // 型が不正な section は無視して直前の区分（区分二）に残る。
        { key: 'b2', label: '欄B2', type: 'text', section: 'broken' },
      ],
    }], { lead: 'L', a1: 'A1', a2: 'A2', b1: 'B1', b2: 'B2' }));

    await win.evaluate(() => window.openSettingsModal());
    await expect(win.locator('.settings-modal')).toBeVisible();

    const outer = win.locator('fieldset.settings-group');
    await expect(outer).toHaveCount(1);
    await expect(outer.locator('fieldset.settings-section')).toHaveCount(2);

    // 区分外の欄は外側グループ直下（内側 fieldset の外）に残る。
    await expect(outer.locator(':scope > .settings-row #set-field-0')).toHaveCount(1);

    const first = outer.locator('fieldset.settings-section').nth(0);
    await expect(first.locator('legend')).toHaveText('区分一');
    await expect(first.locator('input')).toHaveCount(2);
    const descId = await first.getAttribute('aria-describedby');
    expect(descId).toBeTruthy();
    await expect(win.locator(`#${descId}`)).toHaveText('区分一の説明です。');
    await expect(first.locator(`#${descId}`)).toHaveClass(/settings-section-description/);

    // 読み上げ名: 入力欄は外側・内側の両方の fieldset 配下にある。
    const a1 = win.getByLabel('欄A1', { exact: true });
    await expect(a1.locator('xpath=ancestor::fieldset')).toHaveCount(2);

    // label は HTML ではなくテキストとして出す。説明文が無ければ aria-describedby も無い。
    const second = outer.locator('fieldset.settings-section').nth(1);
    await expect(second.locator('legend')).toHaveText('<b>区分二</b>');
    await expect(second.locator('legend b')).toHaveCount(0);
    await expect(second).not.toHaveAttribute('aria-describedby');
    await expect(second.locator('input')).toHaveCount(2);

    // 内側は枠線なし・上側だけ区切り線。
    const border = await first.evaluate((el) => {
      const s = getComputedStyle(el);
      return { top: s.borderTopWidth, left: s.borderLeftWidth, bottom: s.borderBottomWidth };
    });
    expect(border).toEqual({ top: '1px', left: '0px', bottom: '0px' });
  });

  test('区分があっても保存値・disabledWhen の連動は変わらない', async () => {
    await installDescriptorRecordingSaves(win, baseDescriptor([{
      label: '外側グループ',
      fields: [
        { key: 'engine', label: 'エンジン', type: 'select', options: [{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }], section: { label: '区分一' } },
        { key: 'model', label: 'モデル', type: 'text', section: { label: '区分二' }, disabledWhen: { key: 'engine', value: 'codex' }, disabledReason: 'Codex 中は変更できません。' },
      ],
    }], { engine: 'claude', model: 'm1' }));

    await win.evaluate(() => window.openSettingsModal());
    const model = win.getByLabel('モデル', { exact: true });
    await expect(model).toBeEnabled();
    await win.getByLabel('エンジン', { exact: true }).selectOption('codex');
    await expect(model).toBeDisabled();

    await win.getByLabel('エンジン', { exact: true }).selectOption('claude');
    await model.fill('m2');
    await win.locator('.settings-save').click();
    await expect(win.locator('.settings-msg')).toHaveClass(/ok/);
    const payload = await lastSavedPayload(win);
    expect(payload.engine).toBe('claude');
    expect(payload.model).toBe('m2');
  });

  test('section の無い項目は従来どおり内側 fieldset を作らない', async () => {
    await installDescriptorRecordingSaves(win, baseDescriptor([{
      label: '区分なし',
      fields: [
        { key: 'x', label: '欄X', type: 'text' },
        { key: 'y', label: '欄Y', type: 'text', section: { label: '', description: 'x' } },
      ],
    }], { x: 'X', y: 'Y' }));

    await win.evaluate(() => window.openSettingsModal());
    await expect(win.locator('fieldset.settings-group')).toHaveCount(1);
    await expect(win.locator('fieldset.settings-section')).toHaveCount(0);
    await expect(win.locator('fieldset.settings-group > .settings-row')).toHaveCount(2);
  });
});
