const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

async function postSetStatus(port, waiting) {
  const response = await fetch(`http://127.0.0.1:${port}/api/set-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ termId: '1', waiting }),
  });

  let body = null;
  try {
    body = await response.json();
  } catch (_e) {
    // 失敗時の診断用に本文が JSON でないケースも許容する。
  }

  return { response, body };
}

async function waitForPtyRegistration(port) {
  const deadline = Date.now() + 20_000;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      // termId "1" は起動時に renderer が作る最初のペインの PTY。
      // PTY 登録前は main 側が 404 を返すため、200 になるまで短くリトライする。
      const result = await postSetStatus(port, true);
      if (result.response.status === 200) return;
      if (result.response.status !== 404) {
        throw new Error(`unexpected status ${result.response.status}: ${JSON.stringify(result.body)}`);
      }
      lastError = new Error(`terminal 1 not ready: ${JSON.stringify(result.body)}`);
    } catch (e) {
      // HTTP サーバー起動前は fetch 自体が失敗するため、同じ待機ループで吸収する。
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw lastError || new Error('terminal 1 was not registered in time');
}

test('POST /api/set-status が renderer の waiting 表示へ反映される', async () => {
  const port = await getFreePort();

  // VK_TERMINALS_SETTINGS は設定パネル用ディスクリプタとして読まれる。
  // テスト中に設定 UI が開かれても一時的なパスだけを指すようにしておく。
  // ディスクリプタは env で渡す都合上 Electron 起動前にパスが確定している必要があるため、
  // ヘルパーが作る一時 HOME とは別に、このスペックが持つ一時ディレクトリへ置く。
  const descriptorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-set-status-descriptor-'));
  const descriptorPath = path.join(descriptorRoot, 'settings-descriptor.json');
  fs.writeFileSync(descriptorPath, JSON.stringify({
    title: 'E2E Settings',
    targetPath: path.join(descriptorRoot, 'config.json'),
    groups: [
      {
        label: 'E2E',
        fields: [
          { key: 'apiHost', type: 'text' },
          { key: 'initialCommand', type: 'text' },
          { key: 'agentroom', type: 'boolean' },
          { key: 'additionalPanes', type: 'json' },
        ],
      },
    ],
  }), 'utf8');

  // loadUserConfig() は HOME 配下の config.json を読むため、HOME 自体を一時化して
  // 実ユーザーの ~/.vk-terminals/config.json（Tailscale IP 等）に依存しないようにする。
  // このテストは HTTP API と renderer 反映の統合パスだけを見るため、Claude CLI の有無に
  // 依存させない素のシェル（--no-claude）で起動する。いずれもヘルパーが行う。
  // 起動が失敗しても descriptorRoot を消せるよう、launchApp は try の中で呼ぶ。
  let launched;
  try {
    launched = await launchApp({
      port,
      // 元は共通の 'vk-terminals-e2e-' だったが、失敗時に取り残しの出どころが分かるよう
      // spec 名を含む接頭辞にしている。
      prefix: 'vk-terminals-e2e-set-status-',
      env: { VK_TERMINALS_SETTINGS: descriptorPath },
    });
    const { win } = launched;

    await waitForPtyRegistration(port);

    const pane = win.locator('.pane').first();
    const status = win.locator('.pane .pane-status').first();

    // main の HTTP API → webContents.send → renderer の VKIpc.on →
    // recomputeStatus → DOM 反映、という統合パスを実際の Electron 上で確認する。
    await expect(status).toHaveAttribute('data-status', 'waiting');
    await expect(pane).toHaveClass(/\bwaiting\b/);

    const clearResult = await postSetStatus(port, false);
    expect(clearResult.response.status).toBe(200);

    // 解除側も確認する。waiting が残り続ける回帰は利用者に見えるため、ここを芯にする。
    await expect(status).not.toHaveAttribute('data-status', 'waiting');
    await expect(pane).not.toHaveClass(/\bwaiting\b/);
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(descriptorRoot, { recursive: true, force: true });
  }
});
