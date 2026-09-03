const { test, expect } = require('@playwright/test');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');
const { installDescriptor, restoreInvoke } = require('./helpers/settings-descriptor');

// issue #383: help を持てる全フィールド型を同じ定義へ並べ、型ごとの描画分岐で
// トグルが欠落しないことと、代表の text 欄で開閉・読み上げ順をまとめて確認する。
test('設定項目の説明を初期状態では隠し、ボタンで開閉して読み上げ対象を更新する（issue #383）', async () => {
  const port = await getFreePort();
  let launched;
  try {
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-help-toggle-',
    });
    const { win } = launched;
    await installDescriptor(win, {
      available: true,
      title: '説明トグル確認',
      note: '',
      targetPath: '/tmp/settings-help-toggle.json',
      appVersion: '0.0.0-test',
      groups: [{
        label: '全フィールド型',
        fields: [
          { key: 'enabled', label: '有効化', type: 'boolean', help: '真偽値の説明' },
          { key: 'json', label: 'JSON', type: 'json', help: 'JSON の説明' },
          { key: 'lines', label: '複数行', type: 'lines', help: '複数行の説明' },
          { key: 'password', label: 'パスワード', type: 'password', help: 'パスワードの説明' },
          {
            key: 'choice',
            label: '選択',
            type: 'select',
            help: '選択欄の説明',
            options: [
              { value: 'one', label: '1' },
              { value: 'two', label: '2' },
            ],
          },
          { key: 'apiHost', label: 'API ホスト', type: 'text', help: 'テキスト欄の説明' },
          { key: 'count', label: '件数', type: 'number', help: '数値欄の説明' },
          {
            key: 'model',
            label: 'モデル',
            type: 'combo',
            help: '候補入力欄の説明',
            options: [{ value: 'sample', label: 'sample' }],
            disabledWhen: { key: 'choice', value: 'one' },
            disabledReason: '選択が 1 の間は変更できません。',
          },
          { key: 'withoutHelp', label: '説明なし', type: 'text' },
        ],
      }],
      values: {
        enabled: false,
        json: {},
        lines: [],
        password: '',
        choice: 'one',
        apiHost: '127.0.0.1',
        count: 1,
        model: 'sample',
        withoutHelp: '',
      },
    });

    await win.evaluate(() => window.openSettingsModal());
    await expect(win.locator('.settings-modal')).toBeVisible();

    // 全 8 分岐が、help を隠した状態とラベル横のボタンを描画する。
    await expect(win.locator('.settings-help-toggle')).toHaveCount(8);
    await expect(win.locator('.settings-help')).toHaveCount(8);
    for (const help of await win.locator('.settings-help').all()) {
      await expect(help).toBeHidden();
    }

    // help が無い項目はラベル用ラッパーもトグルも増やさず、従来の DOM を保つ。
    const withoutHelpRow = win.locator('#set-field-8').locator('..');
    await expect(withoutHelpRow.locator('.settings-help-toggle')).toHaveCount(0);
    await expect(withoutHelpRow.locator('.settings-label-row')).toHaveCount(0);

    // boolean はチェックラベルを包む専用分岐でも、入力自身の読み上げ対象を更新する。
    const booleanInput = win.getByLabel('有効化', { exact: true });
    const booleanToggle = win.getByRole('button', { name: '有効化の説明' });
    await expect(booleanInput).not.toHaveAttribute('aria-describedby');
    await booleanToggle.click();
    await expect(win.locator('#set-field-0-help')).toBeVisible();
    await expect(booleanInput).toHaveAttribute('aria-describedby', 'set-field-0-help');
    await booleanToggle.click();
    await expect(win.locator('#set-field-0-help')).toBeHidden();
    await expect(booleanInput).not.toHaveAttribute('aria-describedby');

    // password は同じ行の表示切替ボタンと取り違えず、パスワード入力を更新する。
    const passwordInput = win.getByLabel('パスワード', { exact: true });
    const passwordToggle = win.getByRole('button', { name: 'パスワードの説明' });
    await expect(passwordInput).not.toHaveAttribute('aria-describedby');
    await passwordToggle.click();
    await expect(win.locator('#set-field-3-help')).toBeVisible();
    await expect(passwordInput).toHaveAttribute('aria-describedby', 'set-field-3-help');
    await passwordToggle.click();
    await expect(win.locator('#set-field-3-help')).toBeHidden();
    await expect(passwordInput).not.toHaveAttribute('aria-describedby');

    const input = win.getByLabel('API ホスト', { exact: true });
    const toggle = win.getByRole('button', { name: 'API ホストの説明' });
    const help = win.locator('#set-field-5-help');

    // 初期状態では help を読み上げ対象にせず、既存の error・notice の順を保つ。
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(input).toHaveAttribute(
      'aria-describedby',
      'set-field-5-error set-field-5-notice'
    );

    await toggle.click();
    await expect(help).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
    await expect(input).toHaveAttribute(
      'aria-describedby',
      'set-field-5-help set-field-5-error set-field-5-notice'
    );

    await toggle.click();
    await expect(help).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(input).toHaveAttribute(
      'aria-describedby',
      'set-field-5-error set-field-5-notice'
    );

    // 開き直しても help が末尾へ回らず、固定した読み上げ順へ戻る。
    await toggle.click();
    await expect(input).toHaveAttribute(
      'aria-describedby',
      'set-field-5-help set-field-5-error set-field-5-notice'
    );

    // applyFieldState が無効理由を外すために再構築しても、開いている help は落とさない。
    const model = win.getByLabel('モデル', { exact: true });
    const modelToggle = win.getByRole('button', { name: 'モデルの説明' });
    await modelToggle.click();
    await expect(model).toHaveAttribute(
      'aria-describedby',
      'set-field-7-help set-field-7-error set-field-7-disabled-reason'
    );
    await win.getByLabel('選択', { exact: true }).selectOption('two');
    await expect(model).toHaveAttribute(
      'aria-describedby',
      'set-field-7-help set-field-7-error'
    );
    await expect(win.locator('#set-field-7-help')).toBeVisible();
  } finally {
    if (launched) {
      await restoreInvoke(launched.win).catch(() => {});
      await closeApp(launched);
    }
  }
});
