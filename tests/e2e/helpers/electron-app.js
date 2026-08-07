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
// issue #347: 起動〜初期描画の 3 段（launch / firstWindow / #sidebar 待ち）を
// 単一の絶対予算（boot-budget.js の createBootBudget）で管理する。旧設計
// （各段が独立した固定 35 秒の相対タイマーを持つ）が「どの段で詰まったか」を
// 失っていた経緯・仕組みの詳細は boot-budget.js の冒頭コメントと
// tests/bootBudget.test.js の縮小再現を参照（ここでは重複させない）。
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
// の timeout）の半分に留める。半分以下にしているのは、次の 2 点のため:
//   - 起動シーケンス以外にも待ちを積む spec（app-title-override.smoke.spec.js の
//     /api/states 応答待ち 20 秒＋表示確認 15 秒など）が同じ 120 秒の枠を共有している。
//   - この予算の時計は createBootBudget() が呼ばれた瞬間（= launchApp / launchAppAndWait
//     が呼ばれた瞬間）から動き出すため、それより前に spec が使った時間（getFreePort()
//     など）はこの予算から見えない。半分という余裕は、その見えない分を吸収するため。
// つまり保証できるのは「launchApp/launchAppAndWait 呼び出し以降、この 3 段の合計は
// 必ず 60 秒以下に収まる」であり、「呼び出し前にどれだけ時間を使っても構造的に
// 外側より先に発火する」という言い切りではない。この不変条件（60 秒が外側の
// 半分以下であること）は tests/bootBudget.test.js で固定している。
// なお getFreePort() 自身にも別途 GET_FREE_PORT_TIMEOUT_MS の上限を設けている
// （下記コメント参照。負荷試験で実際にここが伸びて 120 秒の汎用タイムアウトに
// つながった事例が見つかったため）。
const BOOT_TOTAL_BUDGET_MS = 60_000;

// getFreePort() は boot budget（launchApp/launchAppAndWait 呼び出し以降を管理）の
// 管轄外で、spec が launchApp 系を呼ぶ前に呼ぶ（BOOT_TOTAL_BUDGET_MS の
// コメント・MEDIUM-3 参照）。実測では常に数 ms だが、issue #347 の負荷試験で
// 「api-token-auth の beforeAll が、起動予算 60 秒のほかに時間を食う要素が
// getFreePort() しかないのに 120 秒の汎用タイムアウトで落ち、段名も出ない」
// 事例が実際に発生した。素の net.Server の listen/close はタイムアウトを
// 持たないため、極端な高負荷でイベントループの順番が回ってくるまでの時間が
// 伸びると無期限に近い待ちになり得る。ここにも明示の上限を設け、超えた場合は
// 何が起きたか分かるメッセージで早く失敗させる。
const GET_FREE_PORT_TIMEOUT_MS = 10_000;
// この閾値を超えたら（正常に完了した場合でも）標準出力へ 1 行書く。boot budget の
// STAGE_LOG_THRESHOLD_MS と同じ考え方（issue #347）。
const GET_FREE_PORT_LOG_THRESHOLD_MS = 3_000;

// OS に空きポートを割り当てさせ、取得後に閉じて Electron 側で再利用する。
// spec ごとにポートを分けることで、並列実行時の固定ポート衝突を避ける。
async function getFreePort() {
  const startedAt = Date.now();
  let timer;
  try {
    return await Promise.race([
      new Promise((resolve, reject) => {
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
      }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`getFreePort did not resolve within ${GET_FREE_PORT_TIMEOUT_MS}ms`));
        }, GET_FREE_PORT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    const elapsed = Date.now() - startedAt;
    if (elapsed >= GET_FREE_PORT_LOG_THRESHOLD_MS) {
      process.stderr.write(`[boot] getFreePort に ${elapsed}ms かかった（boot budget の管轄外）\n`);
    }
  }
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

    app = await runStage(budget, 'electron-launch', (fnTimeoutMs) => _electron.launch({
      args: ['.', '--no-claude'],
      cwd: repoRoot,
      timeout: fnTimeoutMs,
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
    const win = await runStage(budget, 'first-window', (fnTimeoutMs) => app.firstWindow({ timeout: fnTimeoutMs }));
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
//
// 引数は launchApp の戻り値と同じ形（{ win, budget }）で受け取る。budget は
// launchApp と同じものを渡す想定（launchAppAndWait 参照）。現時点で launchApp と
// 対にせず単独で呼ぶ spec は無いが、直接呼ぶ場合に備えて budget は省略可能にし、
// その場合はこの 1 段だけの新しい budget を使う（MEDIUM-4: 呼び出し元が増えたときに
// うっかり (win) の位置引数で呼んでも、budget を渡し忘れて保証が壊れる、という
// 落とし穴を無くすため launchApp の戻り値をそのまま渡せる形に揃えている）。
//
// 引数なし呼び出し（旧形式 waitForAppReady(win) の呼び方を誤ってそのまま残した場合
// を含む）だと、分割代入前に落ちるか win が undefined のまま段の中まで進んでしまい、
// どちらも読み取りにくい失敗になる。既定値 {} で分割代入自体は落とさず、直後に
// win の有無を明示チェックして分かりやすいメッセージで落とす。
async function waitForAppReady({ win, budget = createBootBudget(BOOT_TOTAL_BUDGET_MS) } = {}) {
  if (!win) throw new Error('waitForAppReady: { win } が必要です（launchApp の戻り値をそのまま渡してください）');
  await runStage(budget, 'sidebar-ready', (fnTimeoutMs) => (
    win.waitForSelector('#sidebar', { state: 'attached', timeout: fnTimeoutMs })
  ));
}

// 起動から初期描画待ちまでをまとめて行う（beforeAll から 1 行で呼べるように）。
// electron-launch / first-window / sidebar-ready の 3 段を 1 つの絶対予算で管理する。
// options.budget が渡されていればそれをそのまま使う（呼び出し元が既に budget を
// 持っている場合に黙って新しい budget へ差し替えない。MEDIUM-3）。
async function launchAppAndWait(options) {
  const budget = options.budget ?? createBootBudget(BOOT_TOTAL_BUDGET_MS);
  const launched = await launchApp({ ...options, budget });
  try {
    await waitForAppReady(launched);
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
