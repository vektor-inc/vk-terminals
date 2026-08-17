const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// 指定した config で Electron アプリを起動する（--no-claude で claude 自動起動を抑止）。
// HOME の一時化と、その下の .vk-terminals/config.json への書き出しはヘルパーが行う。
// 親環境（vk-orchestrator 等）の VK_TERMINALS_SETTINGS もヘルパーが既定で中和するため、
// settings:describe は組み込みディスクリプタ（VK Terminals 自身の設定）を返す。
// 最小構成（apiHost / initialCommand / agentroom / additionalPanes）はヘルパーの既定値と
// 同じ内容なので、ここでは個別テストで必要なキーだけ渡す。
async function launchNewPaneApp(port, config = {}) {
  return await launchAppAndWait({ port, prefix: 'vk-terminals-e2e-newpane-', config });
}

test.describe('新規ペイン起動設定（issue #143 / PR #144）', () => {
  // issue #377: (1)(2) はどちらも launchNewPaneApp(port) を config なしで呼んでいる点が
  // 同一のため、起動を 1 回に共有する（stash-header.smoke.spec.js と同じ考え方）。
  // (3)(4) は newPaneStartupDir / newPaneAutoLaunchClaude という起動時 config の値
  // そのものが検証対象のため、個別起動のまま維持する。
  test.describe.serial('既定 config での起動時挙動', () => {
    let app;
    let win;
    let tmpRoot;
    let tmpHome;

    test.beforeAll(async () => {
      const port = await getFreePort();
      ({ app, win, tmpRoot, tmpHome } = await launchNewPaneApp(port));
    });

    test.afterAll(async () => {
      await closeApp({ app, tmpRoot });
    });

    // ── (1) 設定パネルに新規ペイン設定が表示される ────────────────────────────
    // 組み込みディスクリプタの描画順は apiHost=0 / newPaneStartupDir=1 /
    // newPaneAutoLaunchClaude=2 / initialCommand=3。field id は描画順採番なので、
    // 「API ホストの直下」に 2 項目が並ぶことを id の連番で担保する。
    test('設定パネルに新規ペイン設定が API ホストの直下に表示される', async () => {
      // 設定モーダルを開く（組み込みディスクリプタで描画される）。
      await win.evaluate(() => window.openSettingsModal());
      await win.waitForSelector('.settings-modal', { state: 'visible' });
      await win.waitForSelector('#set-field-1', { state: 'visible' });

      // 直上が API ホスト（field-0）であること（＝「API ホストの直下」に並ぶ）。
      await expect(win.locator('label[for="set-field-0"]')).toHaveText('API ホスト');

      // (1) 新規ペイン初期ディレクトリ（text）: ラベル・placeholder・help を確認。
      const dirInput = win.locator('#set-field-1');
      await expect(dirInput).toBeVisible();
      await expect(dirInput).toHaveAttribute('type', 'text');
      await expect(dirInput).toHaveAttribute('placeholder', '/path/to/project');
      await expect(win.locator('label[for="set-field-1"]'))
        .toHaveText('新規ペインを開く時の初期ディレクトリ');
      // help に「未入力／存在しないパスはホームで起動」の旨が含まれること。
      await expect(win.locator('#set-field-1-help')).toContainText('ホームディレクトリで起動');

      // (2) Claude 自動起動（boolean → checkbox）: ラベル・型・既定オフ・help を確認。
      const claudeCheck = win.locator('#set-field-2');
      await expect(claudeCheck).toBeVisible();
      await expect(claudeCheck).toHaveAttribute('type', 'checkbox');
      // boolean は <label class="settings-check"> 内の <span class="settings-label"> がラベル。
      await expect(
        win.locator('label.settings-check', { has: win.locator('#set-field-2') })
          .locator('.settings-label')
      ).toHaveText('Claude Code を自動的に起動する');
      // 既定 false（default:false）で未チェック表示。
      await expect(claudeCheck).not.toBeChecked();
      await expect(win.locator('#set-field-2-help')).toContainText('素のターミナル');

      // (3) その下に初期コマンド（field-3）が続く（＝2 項目が API ホストと初期コマンドの間に入る）。
      await expect(win.locator('label[for="set-field-3"]')).toHaveText('初期コマンド');

      // .settings-modal は role="dialog" aria-modal="true" でフォーカストラップと
      // Escape レイヤを張る要素（renderer/app.js）。開いたまま次のテストへ渡さないよう、
      // 終了時点で元の状態（モーダルが閉じている）へ戻す（settings-shared-tabs.smoke.spec.js
      // と同じパターン）。
      await win.locator('.settings-close').click();
      await expect(win.locator('.settings-modal')).toHaveCount(0);
    });

    // ── (2) terminal:create の cwd 解決（PR で追加した実在チェック） ────────────
    // ⚠ このテストは vkIpc.invoke('terminal:create', ...) を IPC 経由で直接叩くため、
    // 生成された PTY が renderer 側の `terminals` に登録されず closePane の対象にならない
    // （孤児 PTY として残る）。このブロック内の他テストへ影響しないよう、このテストは
    // 常にブロックの最後に置くこと。
    test('terminal:create は実在ディレクトリを使い、不正パスは HOME にフォールバックする', async () => {
      // 実在する一時ディレクトリ（cwd として渡す）。
      const existDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-exist-'));
      try {
        // (A) 実在ディレクトリを渡すと、resolvedCwd はそのパスのまま返る。
        const okCwd = await win.evaluate(async (dir) => {
          const vkIpc = window.VKIpc;
          const r = await vkIpc.invoke('terminal:create', dir, { noClaude: true });
          return r && r.cwd;
        }, existDir);
        expect(okCwd).toBe(existDir);

        // (B) 存在しないパスを渡すと HOME(tmpHome) にフォールバックし、起動は失敗しない。
        const fbCwd = await win.evaluate(async (badPath) => {
          const vkIpc = window.VKIpc;
          const r = await vkIpc.invoke('terminal:create', badPath, { noClaude: true });
          return r && r.cwd;
        }, path.join(existDir, 'no', 'such', 'dir-xyz'));
        expect(fbCwd).toBe(tmpHome);
      } finally {
        fs.rmSync(existDir, { recursive: true, force: true });
      }
    });
  });

  // ── (3) ＋ボタンが config を反映する（自動起動オフ → noClaude:true） ───────────
  test('ヘッダの＋ボタンは newPaneStartupDir と noClaude:true(自動起動オフ) を渡す', async () => {
    const port = await getFreePort();
    const startupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-startup-'));
    const { app, win, tmpRoot } = await launchNewPaneApp(port, {
      newPaneStartupDir: startupDir,
      newPaneAutoLaunchClaude: false,
    });
    try {
      // 起動時に生成される既定ペインのヘッダ＋ボタンを待つ。
      await win.waitForSelector('.pane-header .btn-split', { state: 'visible' });

      // window.VKIpc.invoke を包んで terminal:create の引数を記録（元処理には委譲）。
      await win.evaluate(() => {
        const vkIpc = window.VKIpc;
        window.__termCreateCalls = [];
        const orig = vkIpc.invoke.bind(vkIpc);
        vkIpc.invoke = (channel, ...args) => {
          if (channel === 'terminal:create') {
            window.__termCreateCalls.push({ cwd: args[0], options: args[1] });
          }
          return orig(channel, ...args);
        };
      });

      // ＋ボタン → addPane(newPaneStartupDir, { noClaude: !newPaneAutoLaunchClaude })
      await win.locator('.pane-header .btn-split').first().click();

      await expect
        .poll(async () => await win.evaluate(() => window.__termCreateCalls.length))
        .toBeGreaterThan(0);

      const call = await win.evaluate(
        () => window.__termCreateCalls[window.__termCreateCalls.length - 1]
      );
      // 設定した初期ディレクトリが渡る。
      expect(call.cwd).toBe(startupDir);
      // 自動起動オフ → noClaude:true（素のターミナル）。
      expect(call.options && call.options.noClaude).toBe(true);
    } finally {
      await closeApp({ app, tmpRoot });
      fs.rmSync(startupDir, { recursive: true, force: true });
    }
  });

  // ── (4) ＋ボタンが config を反映する（自動起動オン → noClaude:false） ──────────
  // claude 実バイナリの起動を避けるため、terminal:create はスタブ応答にして記録のみ行う
  // （他チャンネルは元処理へ委譲）。noClaude の値がトグルに正しく連動することを確認する。
  test('ヘッダの＋ボタンは noClaude:false(自動起動オン) を渡す', async () => {
    const port = await getFreePort();
    const startupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-startup-on-'));
    const { app, win, tmpRoot } = await launchNewPaneApp(port, {
      newPaneStartupDir: startupDir,
      newPaneAutoLaunchClaude: true,
    });
    try {
      await win.waitForSelector('.pane-header .btn-split', { state: 'visible' });

      await win.evaluate(() => {
        const vkIpc = window.VKIpc;
        window.__termCreateCalls = [];
        let n = 1000;
        const orig = vkIpc.invoke.bind(vkIpc);
        vkIpc.invoke = (channel, ...args) => {
          if (channel === 'terminal:create') {
            window.__termCreateCalls.push({ cwd: args[0], options: args[1] });
            // claude を起こさないようスタブ応答（PTY を実生成しない）。
            return Promise.resolve({ id: 'spy-' + (n++), cwd: args[0] || '' });
          }
          return orig(channel, ...args);
        };
      });

      await win.locator('.pane-header .btn-split').first().click();

      await expect
        .poll(async () => await win.evaluate(() => window.__termCreateCalls.length))
        .toBeGreaterThan(0);

      const call = await win.evaluate(
        () => window.__termCreateCalls[window.__termCreateCalls.length - 1]
      );
      expect(call.cwd).toBe(startupDir);
      // 自動起動オン → noClaude:false（claude 起動）。
      expect(call.options && call.options.noClaude).toBe(false);
    } finally {
      await closeApp({ app, tmpRoot });
      fs.rmSync(startupDir, { recursive: true, force: true });
    }
  });
});
