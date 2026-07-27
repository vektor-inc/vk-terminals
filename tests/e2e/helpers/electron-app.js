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

// 起動〜初期描画の各段（launch / firstWindow / #sidebar 待ち）に与える待ち時間の上限。
//
// 実測（8 論理コア）では launch + firstWindow が 443〜2,161ms、#sidebar 待ちが最大
// 4.67 秒だった。Electron を並行起動して負荷が高い状態でもこの範囲に収まっている。
//
// 値は「3 段の合計がフックの持ち時間を超えない」ことから決めている。Playwright は
// beforeAll / afterAll にフックごと独立した持ち時間（= playwright.config.js の timeout
// = 120 秒）を与えるため、3 段の合計がそれを超えると、後段で詰まったときに内側の
// 明示タイムアウトより先にフックタイムアウトが刺さり、「どの段で待ち切れなかったか」
// という、このヘルパーが残そうとしている情報が失われる。
// 35 秒 × 3 段 = 105 秒でフック枠 120 秒に対し 15 秒の余裕を残し、内側のタイムアウトが
// 必ず先に立つようにする（合計をちょうど 120 秒にすると同着になり得るため避ける）。
// 実測の最悪値 4.67 秒に対しては 7 倍以上の余裕がある。
const APP_BOOT_TIMEOUT = 35_000;

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
//
// prefix は一時ディレクトリ名の接頭辞（失敗時にどの spec のものか分かるようにする）。
//
// env / config は spec 側が調整するための口だが、ヘルパーが保証する範囲との境界がある。
//   - env: spec 固有の環境変数を追加できる。ただし隔離のための HOME / USERPROFILE /
//     VK_TERMINALS_API_PORT は spec から上書きできない（後述のとおり展開順で守る）。
//     spec が触るのは VK_TERMINALS_APP_TITLE / VK_TERMINALS_SETTINGS のような
//     アプリの挙動を変える変数だけ。
//   - config: ~/.vk-terminals/config.json の内容を上書きできる。apiHost も含めて
//     spec 側が意図的に差し替えられる設計（例: バインドアドレスの挙動を確かめたい場合）。
//     既定は 127.0.0.1 で、上書きしなければテスト用 API がループバック外へ出ることはない。
async function launchApp({ port, prefix, env = {}, config = {} }) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let app = null;
  try {
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

    app = await _electron.launch({
      args: ['.', '--no-claude'],
      cwd: repoRoot,
      timeout: APP_BOOT_TIMEOUT,
      env: {
        ...process.env,
        ...env,
        // 隔離用のキーは spec が渡す env の後に置く。ここが spec に負けると
        // 実 HOME を読み書きしたり他の spec とポートを共有したりしてしまうため、
        // ヘルパーの保証として最後に必ず上書きする。
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        VK_TERMINALS_API_PORT: String(port),
      },
    });
    const win = await app.firstWindow({ timeout: APP_BOOT_TIMEOUT });
    return { app, win, tmpRoot };
  } catch (e) {
    // 起動途中で失敗した場合、掴んだ Electron プロセス（main / renderer / GPU / utility）と
    // 一時ディレクトリは呼び出し側に渡らないため afterAll の closeApp では解放されない。
    // そして失敗する状況とは高負荷そのものなので、残ったプロセスが後続 spec の負荷を
    // 押し上げて連鎖を招く。リソースを掴んだこの場所で解放しておく。
    if (app) await app.close().catch(() => {});
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw e;
  }
}

// レンダラーの初期描画が終わるまで待つ。#sidebar は app.js が起動時に組み立てるため、
// これが付いた時点でトップレベルの配線（設定モーダルを開く関数など）は済んでいる。
async function waitForAppReady(win) {
  await win.waitForSelector('#sidebar', { state: 'attached', timeout: APP_BOOT_TIMEOUT });
}

// 起動から初期描画待ちまでをまとめて行う（beforeAll から 1 行で呼べるように）。
async function launchAppAndWait(options) {
  const launched = await launchApp(options);
  try {
    await waitForAppReady(launched.win);
  } catch (e) {
    // 初期描画待ちで失敗した場合も、この時点では戻り値が呼び出し側へ渡っておらず
    // afterAll の closeApp が空振りする。launchApp と同じ理由でここで解放する。
    // 解放時のエラーは握り潰し、報告するのは元の待ち切れなかったエラーの方にする。
    await closeApp(launched).catch(() => {});
    throw e;
  }
  return launched;
}

// アプリを閉じて一時 HOME を消す。afterAll から呼ぶ。
// 閉じるのに失敗してもエラーは握り潰さずそのまま投げる（プロセスが残ったことを
// 隠さない）が、一時 HOME の削除は finally で必ず実行する。ここを try の外に置くと
// 閉じるのに失敗したときだけ os.tmpdir() にゴミが溜まり続ける。
async function closeApp({ app, tmpRoot }) {
  try {
    if (app) await app.close();
  } finally {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

module.exports = {
  APP_BOOT_TIMEOUT,
  closeApp,
  getFreePort,
  launchApp,
  launchAppAndWait,
  waitForAppReady,
};
