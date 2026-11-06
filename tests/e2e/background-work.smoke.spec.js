const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// 実際の PTY 配下で子プロセスと配布フックを動かし、API と画面をまとめて確認する。
test('裏のコマンドとサブエージェントの開始・終了が実行中表示に反映される', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-background-work-'));
  const bin = path.join(root, 'bin');
  const ready = path.join(root, 'ready');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const index = process.argv.indexOf('--settings');
const settings = JSON.parse(fs.readFileSync(process.argv[index + 1], 'utf8'));
fs.writeFileSync(process.env.VK_BACKGROUND_READY, 'ready');
process.stdout.write('fake claude ready\\r\\n');
const children = new Set();
const rl = require('node:readline').createInterface({ input: process.stdin, terminal: false });
rl.on('line', line => {
  const [command, event] = line.trim().split(/\\s+/);
  if (command === 'bg') {
    const child = cp.spawn('/bin/cat', [], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    children.add(child);
    child.on('exit', () => children.delete(child));
  } else if (command === 'bgstop') {
    for (const child of children) child.kill();
  } else if (command === 'hook') {
    const hook = settings.hooks[event][0].hooks[0].command;
    const child = cp.spawn('/bin/sh', ['-c', hook], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end(JSON.stringify({ hook_event_name: event, agent_id: 'worker1', session_id: 'session1',
      transcript_path: path.join(process.env.HOME, '.claude', 'projects', 'project', 'session1.jsonl') }));
  }
});
// 自分で作った子だけを後片付けし、利用者のプロセスには触れない。
rl.on('close', () => { for (const child of children) child.kill(); process.exit(0); });
`, { mode: 0o755 });
  let launched;
  try {
    const port = await getFreePort();
    launched = await launchAppAndWait({ port, prefix: 'vk-background-work-app-', launchAi: true,
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`, VK_BACKGROUND_READY: ready } });
    const { win } = launched;
    await expect.poll(() => fs.existsSync(ready)).toBe(true);
    const pane = win.locator('.pane').first();
    const badge = pane.locator('.pane-status');
    const state = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/states`);
      expect(response.status).toBe(200);
      return Object.values((await response.json()).terminals || {}).find(t => String(t.termId) === '1');
    };
    const send = async text => {
      await pane.locator('.xterm-screen').click();
      await win.keyboard.type(text);
      await win.keyboard.press('Enter');
    };
    const idle = async () => {
      await expect.poll(async () => {
        const current = await state();
        return current && [current.status, current.backgroundWorkRunning];
      }, { timeout: 20_000 }).toEqual(['idle', false]);
      await expect(badge).toHaveAttribute('data-status', 'idle');
    };
    const running = async () => {
      // 出力の停止と裏の作業を別々に確認し、status の意味が変わらないことも保証する。
      await expect.poll(async () => {
        const current = await state();
        return current && [current.status, current.backgroundWorkRunning];
      }, { timeout: 20_000 }).toEqual(['idle', true]);
      await expect(badge).toHaveText('実行中');
      await expect(badge).toHaveAttribute('title', '裏で作業が動いています');
    };

    // AI 本体が生きているだけでは実行中にならない。
    await idle();
    // 別プロセスグループの子を検知し、終了指示後にラベルを解除する。
    await send('bg');
    await running();
    await pane.locator('.btn-close').click();
    await expect(win.locator('.confirm-message')).toHaveText('このペインは「実行中」です（裏で作業が動いています）。閉じるとセッションは失われます。閉じますか？');
    await win.locator('.confirm-overlay').getByRole('button', { name: 'キャンセル' }).click();
    await send('bgstop');
    await idle();

    // HTTP を直接偽装せず、起動設定へ配布されたフックに実形式の JSON を渡す。
    await send('hook SubagentStart');
    await running();
    await send('hook SubagentStop');
    await idle();
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
