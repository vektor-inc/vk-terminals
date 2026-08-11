const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// issue #363: POST /api/set-title に prWaitingMerge を渡すと、ペイン上部の
// PR バッジ（.pane-task-title-pr）がマージ待ち表示（青 + … アイコン + 専用 aria-label）
// に切り替わることの end-to-end 確認。pr-badge-merged.smoke.spec.js（issue #113）に倣う。
//   A: prWaitingMerge: true → .awaiting-merge クラスが付き、アイコンが …、
//      aria-label がマージ待ち文言になる
//   B: prWaitingMerge 省略 → 「PR が出ただけ」表示（.merged / .awaiting-merge いずれも無し、
//      アイコン ↗、従来 aria-label）。既存ユーザーから見た旧「オープン（緑）」に相当する状態が
//      灰へ変わった後の既定表示（issue #363 の仕様変更）
//   C: prWaitingMerge が boolean 以外（文字列 "true"）→ 厳密な === true 判定により
//      「PR が出ただけ」表示のまま
//   D: prMerged と prWaitingMerge が同時に true → prMerged を優先し .merged 表示になる
//      （.awaiting-merge は付かない）

async function postSetTitle(port, payload) {
  const response = await fetch(`http://127.0.0.1:${port}/api/set-title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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
      const result = await postSetTitle(port, { termId: '1', title: '' });
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

test('POST /api/set-title の prWaitingMerge が renderer の PR バッジへ反映される', async () => {
  const port = await getFreePort();
  // loadUserConfig() は HOME 配下の config.json を読むため、HOME 自体を一時化して
  // 実ユーザーの ~/.vk-terminals/config.json（Tailscale IP 等）に依存しないようにする。
  // このテストは HTTP API と renderer 反映の統合パスだけを見るため、Claude CLI の有無に
  // 依存させない素のシェル（--no-claude）で起動する。いずれもヘルパーが行う。
  const { app, win, tmpRoot } = await launchApp({
    port,
    prefix: 'vk-terminals-e2e-pr-waiting-merge-',
  });

  try {
    await waitForPtyRegistration(port);

    // prUrl は http(s) の schema・new URL() parse・2048 文字以内であればよく、
    // 実際にネットワークへ出る必要はない（クリックしない）ため自サーバーの URL を使う。
    const prUrl = `http://127.0.0.1:${port}/?pr=363`;

    const prBadge = win.locator('.pane .pane-task-title-pr').first();
    const prIcon = prBadge.locator('.pane-task-title-pr-icon');

    // ─── A: prWaitingMerge: true → 青（.awaiting-merge）・…・マージ待ち aria-label ───
    const waitingResult = await postSetTitle(port, {
      termId: '1',
      title: 'PR #363 マージ待ちバッジ確認',
      prUrl,
      prWaitingMerge: true,
    });
    expect(waitingResult.response.status).toBe(200);
    expect(waitingResult.body && waitingResult.body.prWaitingMerge).toBe(true);
    expect(waitingResult.body && waitingResult.body.prMerged).toBe(false);

    await expect(prBadge).toBeVisible();
    await expect(prBadge).toHaveClass(/\bawaiting-merge\b/);
    await expect(prBadge).not.toHaveClass(/\bmerged\b/);
    await expect(prBadge).toHaveAttribute('aria-label', 'マージ待ちのプルリクエストを開く（外部ブラウザ）');
    await expect(prIcon).toHaveText('…');

    // ─── B: prWaitingMerge 省略 → 「PR が出ただけ」表示（.awaiting-merge / .merged 無し・↗） ───
    const omittedResult = await postSetTitle(port, {
      termId: '1',
      title: 'PR #363 省略時は PR が出ただけ表示',
      prUrl,
    });
    expect(omittedResult.response.status).toBe(200);
    expect(omittedResult.body && omittedResult.body.prWaitingMerge).toBe(false);

    await expect(prBadge).not.toHaveClass(/\bawaiting-merge\b/);
    await expect(prBadge).not.toHaveClass(/\bmerged\b/);
    await expect(prBadge).toHaveAttribute('aria-label', 'プルリクエストを開く（外部ブラウザ）');
    await expect(prIcon).toHaveText('↗');

    // ─── C: prWaitingMerge が boolean 以外（文字列 "true"）→ 厳密な === true 判定で灰のまま ───
    // 先に一度 awaiting-merge: true にしてから非 boolean を送り、灰へ戻ることを確認する。
    await postSetTitle(port, { termId: '1', title: 'PR #363 一旦マージ待ちに', prUrl, prWaitingMerge: true });
    await expect(prBadge).toHaveClass(/\bawaiting-merge\b/);

    const nonBooleanResult = await postSetTitle(port, {
      termId: '1',
      title: 'PR #363 非 boolean は灰扱い',
      prUrl,
      prWaitingMerge: 'true',
    });
    expect(nonBooleanResult.response.status).toBe(200);
    expect(nonBooleanResult.body && nonBooleanResult.body.prWaitingMerge).toBe(false);

    await expect(prBadge).not.toHaveClass(/\bawaiting-merge\b/);
    await expect(prBadge).toHaveAttribute('aria-label', 'プルリクエストを開く（外部ブラウザ）');
    await expect(prIcon).toHaveText('↗');

    // ─── D: prMerged と prWaitingMerge が同時に true → prMerged を優先（マージ済みが最終状態） ───
    const bothResult = await postSetTitle(port, {
      termId: '1',
      title: 'PR #363 同時 true は prMerged 優先',
      prUrl,
      prMerged: true,
      prWaitingMerge: true,
    });
    expect(bothResult.response.status).toBe(200);
    expect(bothResult.body && bothResult.body.prMerged).toBe(true);
    expect(bothResult.body && bothResult.body.prWaitingMerge).toBe(true);

    await expect(prBadge).toHaveClass(/\bmerged\b/);
    await expect(prBadge).not.toHaveClass(/\bawaiting-merge\b/);
    await expect(prBadge).toHaveAttribute('aria-label', 'マージ済みのプルリクエストを開く（外部ブラウザ）');
    await expect(prIcon).toHaveText('✓');
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
