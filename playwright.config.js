const { defineConfig } = require('@playwright/test');

// e2e 実行時は Electron のウィンドウを非表示で起動させ、実行中に OS のフォーカスを奪って
// PC 操作を妨げないようにする。各 spec は _electron.launch({ env: { ...process.env, ... } })
// の形で親プロセスの env を展開しているため、ここでセットすれば全 spec へ伝播する。
// 既にセットされている場合は上書きしない（個別 spec での opt-out を尊重する）。
process.env.VK_TERMINALS_E2E ??= '1';

module.exports = defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  // 各テストは HOME を mkdtemp で分離し API ポートを動的取得しており並列耐性がある。
  // CPU コア数の 50% を並列ワーカーに割り当てて高速化する。
  workers: '50%',
  fullyParallel: true,
});
