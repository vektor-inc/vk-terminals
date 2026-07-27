// e2e 共通の Electron 起動ヘルパー（issue #263）。
//
// settings 系の 5 spec は「空きポート取得 → 一時 HOME を作る → Electron を起動 →
// #sidebar が描画されるまで待つ」という同じ手順を spec ごとに写して持っていた。
// 写しであるために待ち時間の指定が抜けやすく（実際に 5 spec すべてが
// waitForSelector にタイムアウトを渡しておらず既定値のままだった）、
// さらにこれを test.describe.serial の beforeAll でやっているため、起動待ちが
// 尽きると Playwright はそのエラーを serial グループの「1 番目のテスト」に紐づけて
// 報告し、残りは実行されない。原因の在り処が読み取りにくい落ち方になる。
//
// そこで起動と初期待機をこのファイルへ一本化し、待ち時間は既定値に頼らず
// 明示する。マシンが高負荷のときも「どこで待ち切れなかったか」がエラーに出る。
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { _electron } = require('@playwright/test');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

// 起動〜初期描画の待ち時間の上限。
// 実測（8 論理コア）では Electron の起動と #sidebar の描画で合わせて 5〜7 秒だが、
// Electron を並行起動して負荷が高い状態では各種の待ちが 4〜8 倍に伸びる。
// 既定の 30 秒だと余裕が乏しいため 60 秒を明示する。
const APP_BOOT_TIMEOUT = 60_000;

// OS に空きポートを割り当てさせ、取得後に閉じて Electron 側で再利用する。
// spec ごとにポートを分けることで、並列実行時の固定ポート衝突を避ける。
async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((err) => {
        if (err) { reject(err); return; }
        if (!port) { reject(new Error('failed to allocate a free port')); return; }
        resolve(port);
      });
    });
  });
}

// 一時 HOME を用意して Electron を素のシェル（--no-claude）で起動する。
// prefix は一時ディレクトリ名の接頭辞（失敗時にどの spec のものか分かるようにする）。
// env で spec 固有の環境変数を追加・上書きできる。
// config で ~/.vk-terminals/config.json の内容を上書きできる。
async function launchApp({ port, prefix, env = {}, config = {} }) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const tmpHome = path.join(tmpRoot, 'home');
  const configDir = path.join(tmpHome, '.vk-terminals');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    apiHost: '127.0.0.1',
    initialCommand: '',
    agentroom: false,
    additionalPanes: [],
    ...config,
  }), 'utf8');

  const app = await _electron.launch({
    args: ['.', '--no-claude'],
    cwd: repoRoot,
    timeout: APP_BOOT_TIMEOUT,
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      VK_TERMINALS_API_PORT: String(port),
      ...env,
    },
  });
  const win = await app.firstWindow({ timeout: APP_BOOT_TIMEOUT });
  return { app, win, tmpRoot };
}

// レンダラーの初期描画が終わるまで待つ。#sidebar は app.js が起動時に組み立てるため、
// これが付いた時点でトップレベルの配線（設定モーダルを開く関数など）は済んでいる。
async function waitForAppReady(win) {
  await win.waitForSelector('#sidebar', { state: 'attached', timeout: APP_BOOT_TIMEOUT });
}

// 起動から初期描画待ちまでをまとめて行う（beforeAll から 1 行で呼べるように）。
async function launchAppAndWait(options) {
  const launched = await launchApp(options);
  await waitForAppReady(launched.win);
  return launched;
}

// アプリを閉じて一時 HOME を消す。afterAll から呼ぶ。
async function closeApp({ app, tmpRoot }) {
  if (app) await app.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
}

module.exports = {
  APP_BOOT_TIMEOUT,
  closeApp,
  getFreePort,
  launchApp,
  launchAppAndWait,
  waitForAppReady,
};
