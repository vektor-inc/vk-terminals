const os = require('os');
const { defineConfig } = require('@playwright/test');

// e2e 実行時は Electron のウィンドウを非表示で起動させ、実行中に OS のフォーカスを奪って
// PC 操作を妨げないようにする。各 spec は _electron.launch({ env: { ...process.env, ... } })
// の形で親プロセスの env を展開しているため、ここでセットすれば全 spec へ伝播する。
// 既にセットされている場合は上書きしない（個別 spec での opt-out を尊重する）。
process.env.VK_TERMINALS_E2E ??= '1';

// 並列ワーカー数（issue #263）。
// 各テストは HOME を mkdtemp で分離し API ポートも動的取得しており並列耐性はあるが、
// Electron 1 本は main / renderer / GPU / utility と複数の OS プロセスを持つため、
// ブラウザのコンテキストを増やすのとは負荷の増え方が違う。実測（8 論理コア）では
// 4 ワーカー・8 ワーカーはいずれも全件 pass、16 ワーカーでは負荷が高いときに
// テストタイムアウトで数件落ちた。使える並列度の 50% を基本にしつつ、コア数の多いマシンで
// 上限を踏み越えないよう 8 で頭を抑える。
// 並列度は os.cpus().length ではなく os.availableParallelism() から採る。CPU affinity や
// コンテナの制限を反映するため、CI に載せたときに実際に使える数に合う（Node 20 以降で利用可能。
// package.json の engines.node は >=20）。
const workers = Math.max(1, Math.min(8, Math.floor(os.availableParallelism() / 2)));

module.exports = defineConfig({
  testDir: 'tests/e2e',
  // 1 テスト（および beforeAll / afterAll の各フック）の上限。
  // 全件を並列実行しているときは Electron の起動・IPC 応答・PTY 登録待ちが実測で
  // 4〜8 倍に伸び、旧値 60s では pass したテストでも 57.9s まで達していた（issue #263）。
  // 余裕を 2 倍確保する。長さそのものが問題のテストは 120s でも落ちるため、
  // 本当のハングを見逃すことはない。
  timeout: 120_000,
  // ※ expect 個別の待ち時間（既定 5s）は変えていない。負荷をかけた計測では assertion は
  //   いずれも 1 回目のポーリングで確定しており、5s が足りなくなる経路は見つからなかった。
  //   ここを広げると本物の失敗の報告が遅くなるだけなので、実測の裏付けが出るまで触らない。

  // 負荷由来の取り逃し対策。原因（待ち方・ワーカー数・タイムアウト）を直した上での
  // 保険であり、retry で通ったテストは flaky として報告されるため原因の隠蔽にはならない。
  retries: 1,
  workers,
  fullyParallel: true,
});
