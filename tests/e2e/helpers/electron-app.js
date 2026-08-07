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
//
// issue #269 で残りの spec もすべてここへ移行した。写しを持っていた spec は明示
// タイムアウトが無く（高負荷時に既定 30 秒で落ちる）、起動途中で失敗すると一時
// ディレクトリと Electron プロセスを解放できずに os.tmpdir() へ取り残していた。
// あわせて、実環境の VK_TERMINALS_* を中和する既定もここへ集約している（launchApp の
// env コメント参照）。
//
// issue #347: 起動〜初期描画の 3 段（launch / firstWindow / #sidebar 待ち）は、
// かつて各段が独立した固定 35 秒の相対タイマーを持っていた（35s×3=105s が
// beforeAll/テストの持ち時間 120s を超えない、という設計）。しかし getFreePort() /
// mkdtempSync() のような段の外側の待ちがフック開始からの時間を先に食うと、
// 各段は「自分の 35 秒」には収まっているのに累積は 120 秒を超えてしまい、外側の
// 絶対タイムアウトが内側の相対タイマーより先に発火して「どの段で詰まったか」が
// 失われていた（相対時間 vs 絶対時間の非対称性。詳細は boot-budget.js と
// boot-budget.test.js の縮小再現を参照）。ここでは起動シーケンス全体に単一の
// 絶対予算（BOOT_TOTAL_BUDGET_MS）を持たせ、各段には「そこからの残り」を渡す。
const { createBootBudget, runStage } = require('./boot-budget');

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { _electron } = require('@playwright/test');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

// 起動シーケンス全体（launch → firstWindow → #sidebar 待ち）で使ってよい合計時間。
//
// 実測（8 論理コア、4 ワーカー）では launch + firstWindow が 443〜2,161ms、
// #sidebar 待ちが最大 4.67 秒（3 段合計で最大 ~7 秒）だった。60 秒はこれの 8 倍
// 以上の余裕を持たせつつ、beforeAll/テストの持ち時間 120 秒（playwright.config.js
// の timeout）の半分に留める。半分以下にしているのは、起動シーケンス以外にも
// 待ちを積む spec（app-title-override.smoke.spec.js の /api/states 応答待ち 20 秒＋
// 表示確認 15 秒など）が同じ 120 秒の枠を共有しているため。この余裕により、
// 段の外側でどれだけ時間を食っても、この予算そのものが外側の絶対タイムアウトへ
// 到達する前に必ず尽きる（＝内側の検知が構造的に必ず外側より先に発火する）。
// この不変条件は tests/e2e/helpers/boot-budget.test.js で固定している。
const BOOT_TOTAL_BUDGET_MS = 60_000;

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
//     一時ディレクトリのパスを設定値に使いたい場合（例: 自分の cwd に一致する除外パターンを
//     与えたい spec）は、パスが mkdtemp まで決まらないためオブジェクトの代わりに
//     ({ tmpRoot, tmpHome, configPath }) => ({ ... }) の関数を渡せる。
// budget は起動シーケンス全体で共有する単一の予算。launchAppAndWait から呼ぶ場合は
// waitForAppReady と同じ budget を渡し、「electron-launch → firstWindow → sidebar-ready」
// の 3 段を 1 つの絶対予算で管理する。launchApp を単独で呼ぶ spec（#sidebar を
// 使わないものも多い）向けに、省略時はこの 2 段だけの新しい budget を作る。
async function launchApp({ port, prefix, env = {}, config = {}, budget = createBootBudget(BOOT_TOTAL_BUDGET_MS) }) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let app = null;
  try {
    const tmpHome = path.join(tmpRoot, 'home');
    const configDir = path.join(tmpHome, '.vk-terminals');
    const configPath = path.join(configDir, 'config.json');
    fs.mkdirSync(configDir, { recursive: true });
    const resolvedConfig = typeof config === 'function'
      ? config({ tmpRoot, tmpHome, configPath })
      : config;
    // 戻り値がプレーンオブジェクトでなければここで落とす。null / undefined は展開しても
    // 無視されるだけなので、spec が意図した設定が入らないまま既定 config で静かに通り
    // （検証が黙って弱くなり気づけない）、文字列なら添字がキーとして混入する。
    if (!resolvedConfig || typeof resolvedConfig !== 'object' || Array.isArray(resolvedConfig)) {
      throw new Error('launchApp: config must be a plain object (or a function returning one)');
    }
    fs.writeFileSync(configPath, JSON.stringify({
      apiHost: '127.0.0.1',
      initialCommand: '',
      agentroom: false,
      additionalPanes: [],
      ...resolvedConfig,
    }), 'utf8');

    app = await runStage(budget, 'electron-launch', (remainingMs) => _electron.launch({
      args: ['.', '--no-claude'],
      cwd: repoRoot,
      timeout: remainingMs,
      env: {
        ...process.env,
        // 実環境（開発者のシェル、vk-orchestrator 配下での起動）から継承される
        // VK_TERMINALS_* を既定で中和する。アプリ名が変わったり外部の設定ディスクリプタが
        // 使われたりすると、テストが見ている前提そのものが静かに変わってしまう。
        // spec の env より前に置いてあるので、意図して指定する spec は上書きで opt-in できる。
        //
        // 変数を delete するのではなく空文字を置くのは、受け取る側の実装で結果が同じになるため。
        //   - main.js の APP_TITLE 解決: VK_TERMINALS_APP_TITLE が空白のみなら既定
        //     'VK Terminals' を使う（未設定と同じ）。
        //   - main.js の settingsDescriptorPath(): VK_TERMINALS_SETTINGS が空白のみなら
        //     null（指定なし）を返し、組み込みディスクリプタへフォールバックする（未設定と同じ）。
        //   - utils/instanceId.js の resolveInstanceId(): VK_TERMINALS_INSTANCE_ID が空白のみなら
        //     null を返し、/api/health に instanceId を含めない（未設定と同じ）。
        // このため env から変数ごと消す口（unset）は設けていない。
        VK_TERMINALS_APP_TITLE: '',
        VK_TERMINALS_SETTINGS: '',
        VK_TERMINALS_INSTANCE_ID: '',
        ...env,
        // 隔離用のキーは spec が渡す env の後に置く。ここが spec に負けると
        // 実 HOME を読み書きしたり他の spec とポートを共有したりしてしまうため、
        // ヘルパーの保証として最後に必ず上書きする。
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        VK_TERMINALS_API_PORT: String(port),
      },
    }));
    const win = await runStage(budget, 'first-window', (remainingMs) => app.firstWindow({ timeout: remainingMs }));
    // tmpHome は HOME 隔離先そのもの。ペインの cwd や設定ファイルの場所を
    // expect で参照する spec があるため、tmpRoot と併せて返す。
    return { app, win, tmpRoot, tmpHome, budget };
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
// budget は launchApp と同じものを渡す想定（launchAppAndWait 参照）。単独で呼ぶ場合は
// 省略でき、その場合はこの 1 段だけの新しい budget を使う。
async function waitForAppReady(win, budget = createBootBudget(BOOT_TOTAL_BUDGET_MS)) {
  await runStage(budget, 'sidebar-ready', (remainingMs) => (
    win.waitForSelector('#sidebar', { state: 'attached', timeout: remainingMs })
  ));
}

// 起動から初期描画待ちまでをまとめて行う（beforeAll から 1 行で呼べるように）。
// electron-launch / first-window / sidebar-ready の 3 段を 1 つの絶対予算
// （BOOT_TOTAL_BUDGET_MS）で管理する。段の外側（getFreePort 等）でどれだけ時間を
// 使っていても、この 3 段の合計は budget を超えられない（issue #347）。
async function launchAppAndWait(options) {
  const budget = createBootBudget(BOOT_TOTAL_BUDGET_MS);
  const launched = await launchApp({ ...options, budget });
  try {
    await waitForAppReady(launched.win, budget);
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
  BOOT_TOTAL_BUDGET_MS,
  closeApp,
  getFreePort,
  launchApp,
  launchAppAndWait,
  waitForAppReady,
};
