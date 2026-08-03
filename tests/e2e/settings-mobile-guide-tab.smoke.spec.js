const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');
// window.VKIpc（renderer 側の中継レイヤ）の差し替えと後始末は共通ヘルパーへ集約している
// （issue #293）。この spec が差し込むのは保存応答の遅延だけで、設定ディスクリプタは
// 差し替えない（組み込みスキーマの tabs 定義自体を検証対象にしているため）。
const { restoreInvoke, stubSlowSave } = require('./helpers/settings-descriptor');

// 説明タブのブロック（.settings-content の直下要素）の並び順を調べる。
// 手順の並びは「読んだ人がその順に操作して成功するか」に直結するので、
// 個々の文言だけでなく前後関係も固定する。
// specs は { 名前: { selector?, text? } } で、両方指定なら AND 条件。
async function contentBlockIndexes(win, panelSelector, specs) {
  return await win.locator(`${panelSelector} .settings-content`).evaluate((root, specList) => {
    const blocks = Array.from(root.children);
    const result = {};
    for (const [name, spec] of Object.entries(specList)) {
      result[name] = blocks.findIndex((el) => {
        if (spec.selector && !el.matches(spec.selector)) return false;
        if (spec.text && !el.textContent.includes(spec.text)) return false;
        return true;
      });
    }
    return result;
  }, specs);
}

// 実クリップボードを汚さないため writeText をスタブして呼び出しを記録する。
//
// スタブを当てるのは main プロセス側（app.evaluate）。issue #268 で renderer から
// electron の clipboard を触れなくしたため、実際に書き込むのは main の
// ipcMain.handle('clipboard:write-text') であり、そこが掴んでいる clipboard を差し替える。
// main.js は起動時に分割代入した clipboard を参照し続けるので、同一オブジェクトの
// writeText（writable/configurable）を差し替えれば呼び出しを捕まえられる。
//
// readText で退避して書き戻す方式は採らない。プレーンテキストのフレーバーしか取れず、
// 画像・RTF・HTML が入っていた場合に書き戻しがそれらをテキストへ化けさせて壊すうえ、
// 途中で落ちると書き戻されないまま汚れが残るため。
async function stubClipboardWrite(app) {
  await app.evaluate(({ clipboard }) => {
    if (!globalThis.__origWriteText) globalThis.__origWriteText = clipboard.writeText;
    globalThis.__written = [];
    clipboard.writeText = (text) => { globalThis.__written.push(text); };
  });
}
// コピー失敗（書き込みが例外を投げるケース）を再現する。
async function stubClipboardFailure(app) {
  await app.evaluate(({ clipboard }) => {
    if (!globalThis.__origWriteText) globalThis.__origWriteText = clipboard.writeText;
    clipboard.writeText = () => { throw new Error('stubbed clipboard failure'); };
  });
}
async function restoreClipboardWrite(app) {
  await app.evaluate(({ clipboard }) => {
    if (!globalThis.__origWriteText) return;
    clipboard.writeText = globalThis.__origWriteText;
    delete globalThis.__origWriteText;
    delete globalThis.__written;
  });
}
const writtenTexts = (app) => app.evaluate(() => (globalThis.__written || []).slice());

const TAB_GENERAL = '#settings-tab-0';   // 設定
const TAB_MOBILE = '#settings-tab-1';    // 外出先から確認
const PANEL_GENERAL = '#settings-panel-0';
const PANEL_MOBILE = '#settings-panel-1';

test.describe.serial('設定パネルの説明タブ「外出先から確認」（issue #245）', () => {
  let app;
  let win;
  let tmpRoot;
  let apiPort;

  test.beforeAll(async () => {
    apiPort = await getFreePort();
    // ヘルパーが VK_TERMINALS_SETTINGS を空へ中和するので、組み込みスキーマ
    // （settings-schema.json）がそのまま描画される。
    // このテストは組み込みスキーマの tabs 定義自体も検証対象にする。
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port: apiPort,
      prefix: 'vk-terminals-e2e-mobile-guide-',
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test.beforeEach(async () => {
    await win.evaluate(() => window.openSettingsModal());
    await win.waitForSelector('.settings-modal', { state: 'visible' });
    await win.waitForSelector('.settings-tabs', { state: 'visible' });
  });

  test.afterEach(async () => {
    // describe.serial で win を共有しているため、クリップボードの差し替えは
    // 毎テストの終わりに必ず戻す（後続テストへ漏らさない）。
    await restoreClipboardWrite(app).catch(() => {});
    await win.evaluate(() => {
      document.getElementById('outside-focus-target')?.remove();
      document.getElementById('removed-settings-opener')?.remove();
    }).catch(() => {});
    const closeBtn = win.locator('.settings-close');
    if (await closeBtn.count()) {
      await closeBtn.click().catch(() => {});
    }
    await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
  });

  test('組み込みスキーマに「設定」「外出先から確認」の 2 タブが出る', async () => {
    await expect(win.locator('.settings-tab')).toHaveCount(2);
    await expect(win.locator(TAB_GENERAL)).toContainText('設定');
    await expect(win.locator(TAB_MOBILE)).toContainText('外出先から確認');
    // 既定は「設定」タブ（既存の設定項目が従来どおり見える）。
    await expect(win.locator(TAB_GENERAL)).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator(`${PANEL_GENERAL} label[for="set-field-0"]`)).toHaveText('API ホスト');
    // API ホストの説明から説明タブへ戻れるよう、タブ名を明記する。
    await expect(win.locator('#set-field-0-help')).toContainText('「外出先から確認」タブ');
    // ダイアログ名が読み上げられるよう、見出しと関連付ける。
    await expect(win.locator('.settings-modal')).toHaveAttribute('aria-labelledby', 'settings-modal-title');
    await expect(win.locator('#settings-modal-title')).toContainText('VK Terminals 設定');
  });

  test('説明タブに手順・リンク・コード例・注意書きが表示される', async () => {
    await win.locator(TAB_MOBILE).click();
    await expect(win.locator(PANEL_MOBILE)).toBeVisible();

    // 見出しはモーダルの h2 の下位（h3 / h4）で、実行順に並ぶ。
    // 前提（Tailscale 接続 → IP 取得 → vk-terminals 側の設定）を踏んでからアドレスを
    // 開く順序になっていないと、指示どおり進めた人が必ず接続に失敗する。
    const headings = win.locator(`${PANEL_MOBILE} .settings-content-heading`);
    await expect(headings).toHaveText([
      'スマートフォンから確認できます',
      '現在の待ち受けアドレス',
      'Tailscale とは',
      '準備: 両方の端末を Tailscale に接続する',
      'パソコンの Tailscale IP を調べる',
      '外出先から開く 2 つの方法',
      '方法 1: vk-terminals の API ホストを変更する',
      '方法 2: tailscale serve で公開する',
      // issue #313: スマートフォンの登録手順とアクセストークンパネル（自身の見出しを持つ
      // 自己完結セクション）が「方法 2」と「セキュリティ上の注意」の間に入る。
      'スマートフォンを登録する',
      'アクセストークン',
      'セキュリティ上の注意',
    ]);

    // 見出しレベルの内訳（issue #260）。親セクションは h3、「方法 1」「方法 2」だけが
    // 「外出先から開く 2 つの方法」の子なので h4。
    await expect(win.locator(`${PANEL_MOBILE} h3.settings-content-heading`)).toHaveText([
      'スマートフォンから確認できます',
      '現在の待ち受けアドレス',
      'Tailscale とは',
      '準備: 両方の端末を Tailscale に接続する',
      'パソコンの Tailscale IP を調べる',
      '外出先から開く 2 つの方法',
      'スマートフォンを登録する',
      'アクセストークン',
      'セキュリティ上の注意',
    ]);
    await expect(win.locator(`${PANEL_MOBILE} h4.settings-content-heading`)).toHaveText([
      '方法 1: vk-terminals の API ホストを変更する',
      '方法 2: tailscale serve で公開する',
    ]);
    // 階層そのものの検証。h4 の直前の親は h3「外出先から開く 2 つの方法」で、
    // 末尾の「セキュリティ上の注意」は h3 に戻る（＝方法 2 のサブセクションを抜けた、
    // 機能全体への注意である、が読み上げでも伝わる）。
    const levels = await headings.evaluateAll(
      (els) => els.map((el) => ({ tag: el.tagName.toLowerCase(), text: el.textContent }))
    );
    const parentIndex = levels.findIndex((h) => h.text === '外出先から開く 2 つの方法');
    // 見つからないまま添字を引くと undefined の参照で TypeError になり、
    // 「何が壊れたか」が読めないログになるため先にガードする。
    expect(parentIndex, '親見出し「外出先から開く 2 つの方法」が見つからない').toBeGreaterThan(-1);
    expect(levels[parentIndex].tag).toBe('h3');
    expect(levels[parentIndex + 1].tag).toBe('h4');   // 方法 1
    expect(levels[levels.length - 1].tag).toBe('h3'); // セキュリティ上の注意
    // 先頭は h3（モーダルの h2 からレベルが飛ばない）。
    expect(levels[0].tag).toBe('h3');

    // 見出しの階層は「タグ」だけでなく「直前のブロックとの実際の余白」でも示している。
    // 「方法 1」「方法 2」は同じ親（h3「外出先から開く 2 つの方法」）の子＝同レベルなので、
    // 上余白は揃っていなければならない。実測（描画結果の隙間）を見るのは、マージン相殺が
    // 効かないブロック（インラインレベルの要素など）が直前に来ると、指定値どおりでも
    // 実際の余白だけが広がって階層が崩れるため。「方法 2」の直前は移動ボタンで、
    // これを取り違えると子セクション境界が親セクション境界とほぼ同じ広さになる。
    const gaps = await win.locator(`${PANEL_MOBILE} .settings-content`).evaluate((root) => {
      const result = {};
      for (const el of Array.from(root.children)) {
        if (!el.classList.contains('settings-content-heading')) continue;
        const prev = el.previousElementSibling;
        if (!prev) continue;
        // 直前ブロックの下端から見出しの上端まで（＝相殺後の実効ギャップ）。
        result[el.textContent] = Math.round(
          el.getBoundingClientRect().top - prev.getBoundingClientRect().bottom
        );
      }
      return result;
    });
    const method1Gap = gaps['方法 1: vk-terminals の API ホストを変更する'];
    const method2Gap = gaps['方法 2: tailscale serve で公開する'];
    const sectionGap = gaps['セキュリティ上の注意']; // 親セクションの境界（h3）
    for (const [name, gap] of Object.entries({ method1Gap, method2Gap, sectionGap })) {
      expect(gap, `${name} を取得できない`).toBeGreaterThan(0);
    }
    // 兄弟どうしは同じ広さ（丸め誤差 1px まで許容）。px の決め打ちはしない。
    expect(Math.abs(method1Gap - method2Gap)).toBeLessThanOrEqual(1);
    // 子セクションの境界は親セクションの境界より明らかに狭い（グループ内 < グループ間）。
    expect(method1Gap).toBeLessThan(sectionGap - 4);
    expect(method2Gap).toBeLessThan(sectionGap - 4);

    // Tailscale の説明（アプリのインストール不要 / 同じ Wi-Fi でなくてよい）。
    await expect(win.locator(PANEL_MOBILE))
      .toContainText('スマートフォン側にアプリをインストールする必要はありません');
    // 実際の到達範囲は直後の状態表示へ集約し、導入文では繰り返さない。
    await expect(win.locator(PANEL_MOBILE))
      .toContainText('外出先から開くには、次の Tailscale を使う方法が簡単です');
    await expect(win.locator(PANEL_MOBILE))
      .not.toContainText('初期設定ではパソコン自身からしか開けません');
    await expect(win.locator(PANEL_MOBILE))
      .toContainText('同じプライベートネットワーク（tailnet）');

    // 準備手順は番号付きリスト。
    await expect(win.locator(`${PANEL_MOBILE} ol.settings-content-list li`)).toHaveCount(4);

    // コードブロックは「現在の待ち受けアドレス → IP の調べ方 → 開くアドレス →
    // tailscale serve」の順。
    const codes = win.locator(`${PANEL_MOBILE} .settings-content-code`);
    await expect(codes).toHaveText([
      `http://127.0.0.1:${apiPort}/`,
      'tailscale ip -4',
      'http://<Tailscale IP>:13847/',
      'tailscale serve --bg 13847',
    ]);
    // --bg は版によって使えないため、対応バージョンを添えて詰まらないようにする。
    await expect(win.locator(PANEL_MOBILE)).toContainText('Tailscale 1.54 以降の書式');
    // 山括弧ごとコピーされないよう実例を併記する。
    await expect(win.locator(PANEL_MOBILE)).toContainText('http://100.101.102.103:13847/');
    // アドレスの節は再起動を受けた文にする（前工程を踏ませる）。
    await expect(win.locator(PANEL_MOBILE)).toContainText('再起動したら');
    // 2 つの方法の選び分けを添える。
    await expect(win.locator(PANEL_MOBILE)).toContainText('どちらか一方を行えば開けます');

    // Tailscale IP の節は「方法 1 で使う」ことを先に示す（方法 2 を選ぶ人に不要な作業を
    // 押し付けない）。確認手段もターミナルより先に GUI（メニューバー / 通知領域）を出す。
    await expect(win.locator(PANEL_MOBILE)).toContainText('「方法 2」だけを行う場合は不要です');
    // 方法 2 は環境によってそのまま実行できないことがあるため「最短」と言い切らない。
    await expect(win.locator(PANEL_MOBILE)).not.toContainText('最短');
    await expect(win.locator(PANEL_MOBILE)).toContainText('そのままでは実行できない場合があります');

    // 実際の待ち受け状態は色だけでなく「補足」の語と URL でも伝える。
    const apiStatus = win.locator(`${PANEL_MOBILE} [data-status-source="apiServer"]`);
    await expect(apiStatus).toHaveAttribute('data-tone', 'info');
    await expect(apiStatus.locator('.settings-content-status-label')).toHaveText('補足');
    await expect(apiStatus).toContainText(`http://127.0.0.1:${apiPort}/`);
    await expect(apiStatus).toContainText('このパソコンからのみ開けます');

    // 推測による診断手順は削除し、再起動後に先頭の実アドレスを見る案内へ置き換える。
    await expect(win.locator(PANEL_MOBILE))
      .toContainText('このタブの先頭にある「現在の待ち受けアドレス」');
    await expect(win.locator(PANEL_MOBILE))
      .not.toContainText('パソコン自身のブラウザで同じアドレスを開いてみて');
    await expect(win.locator(PANEL_MOBILE)).not.toContainText('API server listening');

    // 注意書きは role="note" + トーンを表す語（色だけに依存しない）で伝える。
    // issue #313: 「保護されている」安心情報（info）と「0.0.0.0 は暗号化されない」
    // 警告（warning）を 2 ブロックに分けている（安心情報と警告を 1 つに同居させない）。
    const callouts = win.locator(`${PANEL_MOBILE} .settings-content-callout`);
    await expect(callouts).toHaveCount(2);
    const infoCallout = win.locator(`${PANEL_MOBILE} .settings-content-callout[data-tone="info"]`);
    await expect(infoCallout).toHaveAttribute('role', 'note');
    await expect(infoCallout.locator('.settings-content-callout-label')).toHaveText('補足');
    await expect(infoCallout).toContainText('アクセストークンによる認証で保護されています');
    const warningCallout = win.locator(`${PANEL_MOBILE} .settings-content-callout[data-tone="warning"]`);
    await expect(warningCallout).toHaveAttribute('role', 'note');
    await expect(warningCallout.locator('.settings-content-callout-label')).toHaveText('注意');
    await expect(warningCallout).toContainText('0.0.0.0');

    // 保存対象が無いタブなので「保存後、次回の起動から反映されます。」は継承しない。
    await expect(win.locator(`${PANEL_MOBILE} .settings-tab-note`)).toHaveCount(0);
    // パネル自身がフォーカス可能（入力欄が無いのでキーボードで読めるようにする）。
    await expect(win.locator(PANEL_MOBILE)).toHaveAttribute('tabindex', '0');
  });

  test('方法 1 は「手順 → アドレス → 実例 → 補足 → 移動ボタン」の順に並ぶ', async () => {
    await win.locator(TAB_MOBILE).click();
    const at = await contentBlockIndexes(win, PANEL_MOBILE, {
      ipHeading: { selector: 'h3', text: 'パソコンの Tailscale IP を調べる' },
      ipGui: { text: 'メニューバーの Tailscale アイコン' },
      // コピーボタン付きのコードブロックは .settings-content-codeblock で包まれるため、
      // .settings-content の直下に来るのはラッパー側になる。
      ipCommand: { selector: '.settings-content-codeblock', text: 'tailscale ip -4' },
      // 「方法 1」「方法 2」は親セクション（h3「外出先から開く 2 つの方法」）の子なので h4。
      method1Heading: { selector: 'h4', text: '方法 1' },
      address: { selector: '.settings-content-code', text: '<Tailscale IP>:13847' },
      example: { text: 'http://100.101.102.103:13847/' },
      statusConfirmation: { text: 'このタブの先頭にある「現在の待ち受けアドレス」' },
      tabLink: { selector: '.settings-content-tablink' },
      method2Heading: { selector: 'h4', text: '方法 2' },
    });
    for (const [name, index] of Object.entries(at)) {
      expect(index, `${name} が見つからない`).toBeGreaterThan(-1);
    }

    // ターミナルを避けたい人向けに、GUI での確認手段をコマンドより先に出す。
    expect(at.ipGui).toBeGreaterThan(at.ipHeading);
    expect(at.ipGui).toBeLessThan(at.ipCommand);

    // 移動ボタンは方法 1 の最後。節の途中に置くと、押した人がその先のアドレスを
    // 読まずにタブを移り、保存後の自動クローズと相まって読みに戻れなくなる。
    expect(at.address).toBeGreaterThan(at.method1Heading);
    expect(at.example).toBeGreaterThan(at.address);
    // 再起動後の確認先は実例の直後に置き、推測による診断手順は挟まない。
    expect(at.statusConfirmation).toBeGreaterThan(at.example);
    expect(at.tabLink).toBeGreaterThan(at.statusConfirmation);
    expect(at.tabLink).toBeLessThan(at.method2Heading);
  });

  test('外部リンクは href="#" のまま data 属性に http(s) URL を持つ', async () => {
    await win.locator(TAB_MOBILE).click();
    const links = win.locator(`${PANEL_MOBILE} .settings-content-link`);
    await expect(links).toHaveCount(2);
    // Electron の renderer 内で外部サイトが開かないよう href は "#"。
    await expect(links.nth(0)).toHaveAttribute('href', '#');
    await expect(links.nth(0)).toHaveAttribute(
      'data-external-url',
      'https://tailscale.com/docs/how-to/quickstart'
    );
    await expect(links.nth(1)).toHaveAttribute('data-external-url', 'https://tailscale.com/download');
    // スクリーンリーダー向けに外部ブラウザで開くことを伝える。
    await expect(links.nth(0)).toHaveAttribute('aria-label', /外部ブラウザで開く/);
    // キーボードでフォーカスできる。
    await links.nth(0).focus();
    const focusedUrl = await win.evaluate(
      () => document.activeElement && document.activeElement.dataset.externalUrl
    );
    expect(focusedUrl).toBe('https://tailscale.com/docs/how-to/quickstart');
  });

  // ─── コードブロックのコピーボタン（issue #262） ───────────────────────────────

  test('コピーボタンは実アドレスとコマンドで共通の仕組みを使い、対象文字列を読み上げる', async () => {
    await win.locator(TAB_MOBILE).click();
    const copyButtons = win.locator(`${PANEL_MOBILE} .settings-content-copy`);
    // 手入力しづらい実アドレスと、タイプミスしやすいコマンド 2 つに付ける。
    await expect(copyButtons).toHaveCount(3);
    await expect(copyButtons).toHaveText(['コピー', 'コピー', 'コピー']);
    await expect(copyButtons.nth(0)).toHaveAttribute(
      'aria-label',
      `コピー: http://127.0.0.1:${apiPort}/`
    );
    // 貼り付け先がパソコンではなくスマートフォンのアドレスバーになるアドレスは対象外。
    // ラッパーが付かず <pre> 単体のまま残る。
    const codeblocks = win.locator(`${PANEL_MOBILE} .settings-content > .settings-content-codeblock`);
    await expect(codeblocks).toHaveCount(2);
    await expect(codeblocks.nth(0)).toContainText('tailscale ip -4');
    await expect(codeblocks.nth(1)).toContainText('tailscale serve --bg 13847');
    await expect(
      win.locator(`${PANEL_MOBILE} .settings-content-codeblock`, { hasText: '<Tailscale IP>:13847' })
    ).toHaveCount(0);

    // 可視ラベル「コピー」を含みつつ対象コマンドまで読み上げる（WCAG 2.5.3 / 2 個の区別）。
    await expect(copyButtons.nth(1)).toHaveAttribute('aria-label', 'コピー: tailscale ip -4');
    await expect(copyButtons.nth(2)).toHaveAttribute('aria-label', 'コピー: tailscale serve --bg 13847');

    // フィードバック用の live region は押す前から DOM にある（後から挿入すると読み上げが
    // 発火しない）。初期状態は空。
    // issue #313: アクセストークンパネルのコピーフィードバック（4 個目）が末尾に増える。
    const statuses = win.locator(`${PANEL_MOBILE} .settings-content-copy-status`);
    await expect(statuses).toHaveCount(4);
    await expect(statuses.nth(0)).toHaveAttribute('role', 'status');
    await expect(statuses.nth(0)).toHaveText('');

    // キーボードだけでも到達できる（マウス前提の操作にしない）。
    await copyButtons.nth(2).focus();
    const focusedLabel = await win.evaluate(
      () => document.activeElement && document.activeElement.getAttribute('aria-label')
    );
    expect(focusedLabel).toBe('コピー: tailscale serve --bg 13847');
  });

  test('コピーボタンを押すとコマンドがクリップボードへ渡り、2 秒後に表示が戻る', async () => {
    await win.locator(TAB_MOBILE).click();
    await stubClipboardWrite(app);
    const commandBlocks = win.locator(`${PANEL_MOBILE} .settings-content > .settings-content-codeblock`);
    const serveBlock = commandBlocks.nth(1);
    const button = serveBlock.locator('.settings-content-copy');
    const status = serveBlock.locator('.settings-content-copy-status');

    await button.click();
    // 成功は色だけでなくテキストでも伝える（data-state は付けない＝既定の緑）。
    await expect(status).toHaveText('コピーしました');
    await expect(status).not.toHaveAttribute('data-state', 'error');
    // 表示どおりの文字列が 1 回だけ渡る（コピー元は DOM のコード本文）。
    expect(await writtenTexts(app)).toEqual(['tailscale serve --bg 13847']);
    // フォーカスは押したボタンに留まる（続けてもう一方もコピーできる）。
    await expect(button).toBeFocused();
    // 2 秒後には消える。
    await expect(status).toHaveText('', { timeout: 4000 });

    // もう一方のブロックは独立して動く（状態が混ざらない）。
    const ipBlock = commandBlocks.nth(0);
    await ipBlock.locator('.settings-content-copy').click();
    await expect(ipBlock.locator('.settings-content-copy-status')).toHaveText('コピーしました');
    await expect(status).toHaveText('');
    expect(await writtenTexts(app)).toEqual(['tailscale serve --bg 13847', 'tailscale ip -4']);
  });

  test('連打してもフィードバックは重複せず、最後の押下から 2 秒表示される', async () => {
    await win.locator(TAB_MOBILE).click();
    await stubClipboardWrite(app);
    const block = win.locator(`${PANEL_MOBILE} .settings-content > .settings-content-codeblock`).nth(0);
    const button = block.locator('.settings-content-copy');
    const status = block.locator('.settings-content-copy-status');

    // 押下と待機を Promise.all で束ね、経過時間の起点を押下時刻に固定する。
    // 「押す → アサーション → 待つ」と直列に並べると、間のアサーションにかかった時間が
    // そのまま余裕を削るため、2 秒の消灯に追い越されて偽陽性で落ちうる。
    const clickAndWait = (ms) => Promise.all([button.click(), win.waitForTimeout(ms)]);

    // 1 回目の押下から 1.2 秒。この時点ではまだ出ている（消灯まで 0.8 秒の余裕）。
    await clickAndWait(1200);
    await expect(status).toHaveText('コピーしました');
    expect(await writtenTexts(app)).toEqual(['tailscale ip -4']);

    // 2 回目の押下から 1.2 秒。1 回目の押下からは 2.4 秒以上経っているので、
    // 消灯タイマーが張り替わっていなければ既に消えている（＝連打の張り替えを検出できる）。
    // 一方 2 回目の押下からは 1.2 秒なので、正しく張り替わっていれば必ず出ている。
    // どちらの判定も直前のアサーションの所要時間に左右されない。
    await clickAndWait(1200);
    await expect(status).toHaveText('コピーしました');
    // 最後の押下から 2 秒後には消える。
    await expect(status).toHaveText('', { timeout: 4000 });
  });

  test('コピーに失敗したときは失敗をテキストで伝える', async () => {
    await win.locator(TAB_MOBILE).click();
    await stubClipboardFailure(app);
    const block = win.locator(`${PANEL_MOBILE} .settings-content > .settings-content-codeblock`).nth(0);
    const status = block.locator('.settings-content-copy-status');
    await block.locator('.settings-content-copy').click();
    // 色だけに依存させず、テキストと data-state の両方で失敗を伝える。
    await expect(status).toHaveText('コピーできませんでした');
    await expect(status).toHaveAttribute('data-state', 'error');
    // 失敗表示も 2 秒で戻る（押し直せる状態に復帰する）。
    await expect(status).toHaveText('', { timeout: 4000 });
  });

  test('説明タブには入力欄が 1 つも無く、保存ボタンが隠れる', async () => {
    await win.locator(TAB_MOBILE).click();
    await expect(win.locator(`${PANEL_MOBILE} input, ${PANEL_MOBILE} select, ${PANEL_MOBILE} textarea`))
      .toHaveCount(0);
    // 説明コンテンツがあればパネルは空ではないので、空状態メッセージを足さない。
    await expect(win.locator(`${PANEL_MOBILE} .settings-empty`)).toHaveCount(0);
    // 保存対象が無いので「保存」と保存ヒントを隠し、残す操作は「閉じる」だけにする。
    await expect(win.locator('.settings-save')).toBeHidden();
    await expect(win.locator('.settings-save-hint')).toBeHidden();
    await expect(win.locator('.settings-cancel')).toHaveText('閉じる');

    // 「設定」タブへ戻すと元に戻る。
    await win.locator(TAB_GENERAL).click();
    await expect(win.locator('.settings-save')).toBeVisible();
    await expect(win.locator('.settings-save-hint')).toBeVisible();
    await expect(win.locator('.settings-cancel')).toHaveText('キャンセル');
  });

  test('移動ボタンは設定タブの API ホスト欄まで運ぶ（表示領域内・フォーカス済み）', async () => {
    await win.locator(TAB_MOBILE).click();
    // issue #313 で「常にアクセストークン認証を必須にする」設定への移動ボタンも
    // 増えたため（方法 2 の節）、テキストで絞って「API ホストの設定へ移動」だけを狙う。
    const tabLink = win.locator(`${PANEL_MOBILE} .settings-content-tablink`, { hasText: 'API ホストの設定へ移動' });
    await expect(tabLink).toHaveText('API ホストの設定へ移動');
    // 説明タブを読み進めた状態（スクロール済み）から押しても着地点は変わらない。
    await win.locator(PANEL_MOBILE).evaluate((el) => {
      el.closest('.settings-view-config').scrollTop = 600;
    });
    await tabLink.click();

    // 「設定」タブがアクティブになる。
    await expect(win.locator(TAB_GENERAL)).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator(PANEL_GENERAL)).toBeVisible();
    // API ホスト欄そのものにフォーカスが乗る（タブを開いただけで終わらせない）。
    const focusedId = await win.evaluate(() => document.activeElement && document.activeElement.id);
    expect(focusedId).toBe('set-field-0');
    // かつスクロールコンテナの表示領域内に収まっている。
    const visible = await win.locator('#set-field-0').evaluate((el) => {
      const view = el.closest('.settings-view-config').getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return box.top >= view.top && box.bottom <= view.bottom;
    });
    expect(visible).toBe(true);
  });

  test('スクロール位置はタブごとに記憶され、初回は先頭から表示される', async () => {
    const scrollTopOf = (panelSelector) => win.locator(panelSelector).evaluate(
      (el) => el.closest('.settings-view-config').scrollTop
    );
    const scrollTo = (panelSelector, top) => win.locator(panelSelector).evaluate(
      (el, value) => { el.closest('.settings-view-config').scrollTop = value; },
      top
    );

    // 設定タブを下までスクロールしてから説明タブへ移る。
    await scrollTo(PANEL_GENERAL, 99999);
    const generalScroll = await scrollTopOf(PANEL_GENERAL);
    expect(generalScroll).toBeGreaterThan(0);

    // 未訪問のタブは先頭から。位置を引き継ぐと説明タブの導入を読み飛ばしてしまう。
    await win.locator(TAB_MOBILE).click();
    expect(await scrollTopOf(PANEL_MOBILE)).toBe(0);
    await expect(win.locator(`${PANEL_MOBILE} h3.settings-content-heading`).first()).toBeInViewport();

    // 説明タブを読み進めてから設定タブへ戻ると、設定タブは離れたときの位置に戻る。
    await scrollTo(PANEL_MOBILE, 400);
    const mobileScroll = await scrollTopOf(PANEL_MOBILE);
    expect(mobileScroll).toBeGreaterThan(0);
    await win.locator(TAB_GENERAL).click();
    expect(await scrollTopOf(PANEL_GENERAL)).toBe(generalScroll);

    // 説明タブへ戻ると読みかけの位置から再開できる（往復で読み直しにならない）。
    await win.locator(TAB_MOBILE).click();
    expect(await scrollTopOf(PANEL_MOBILE)).toBe(mobileScroll);
  });

  test('未保存の変更がある場合は説明タブでも保存ボタンを隠さない', async () => {
    // 「設定」タブで API ホストを編集して未保存状態にする。
    await win.locator('#set-field-0').fill('100.100.100.100');
    await expect(win.locator(TAB_GENERAL)).toHaveClass(/is-dirty/);

    // 説明タブへ移動しても、変更を保存する手段（保存ボタン）は残る。
    await win.locator(TAB_MOBILE).click();
    await expect(win.locator('.settings-save')).toBeVisible();
    await expect(win.locator('.settings-cancel')).toHaveText('キャンセル');
  });

  test('保存後のフッター固定はタブを移った時点で解除される', async () => {
    // 保存直後はボタン構成を固定する（押した直後に「保存」が消えて位置がずれないように）。
    // ただしその固定を引きずると、説明タブへ移っても「保存」が出たままになる。
    await win.locator('#set-field-0').fill('127.0.0.1');
    await win.locator('.settings-save').click();
    await expect(win.locator('.settings-msg')).toHaveClass(/ok/);
    await expect(win.locator('.settings-save')).toBeVisible();

    await win.locator(TAB_MOBILE).click();
    await expect(win.locator('.settings-save')).toBeHidden();
    await expect(win.locator('.settings-cancel')).toHaveText('閉じる');
  });

  test('保存後に手動で閉じても、遅れた自動クローズが二重オープンのロックを壊さない', async () => {
    await win.locator('#set-field-0').fill('127.0.0.1');
    await win.locator('.settings-save').click();
    await expect(win.locator('.settings-msg')).toHaveClass(/ok/);

    // 自動クローズ（2.5 秒）を待たずに ✕ で閉じ、すぐ開き直す。
    await win.locator('.settings-close').click();
    await win.waitForSelector('.settings-modal', { state: 'detached' });
    await win.evaluate(() => window.openSettingsModal());
    await win.waitForSelector('.settings-modal', { state: 'visible' });

    // 取り消されなかったタイマーは、閉じた前回のモーダルに対して close() を呼ぶ。
    // 開き直したモーダルは消えないが、モーダルが開いているかどうかのフラグだけが
    // false に戻るため、この時点で設定を開くと 2 枚目が重なって生成される。
    await win.waitForTimeout(3000);
    await win.evaluate(() => window.openSettingsModal());
    await expect(win.locator('.settings-modal')).toHaveCount(1);
  });

  // 【経緯】このテストは #257 の回帰テストを #282 で反転させたもの。
  // #257 の時点ではフォーカストラップが無く、保存後の自動クローズ（約 2.5 秒）を待つ間に
  // Tab でパネルの外へ出られた。そのため #257 は「閉じる時点でフォーカスがパネル内に
  // あるときだけ操作元へ戻す」という条件付きの実装でこの経路を回避しており、当時は
  // 「パネル外へ出たあと、自動クローズ後もそこに留まる」ことを確認していた。
  // #282 でトラップが入り、その経路自体が消滅した（条件が構造的に真になった）ため、
  // 削除ではなく確認内容を反転し、「パネル外へ出られないこと」を押さえる形へ置き換えた。
  test('保存後の自動クローズを待つ間も Tab でパネルの外へ出られない', async () => {
    // 実際の設定ボタンを復帰先として控えさせるため、beforeEach がプログラムから開いた
    // パネルを閉じて、設定ボタンから開き直す。
    await win.locator('.settings-close').click();
    await win.waitForSelector('.settings-modal', { state: 'detached' });
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();

    await win.locator('#set-field-0').fill('127.0.0.1');
    await win.locator('.settings-save').click();
    await expect(win.locator('.settings-msg')).toHaveClass(/ok/);

    // #257 当時にパネル外への出口となった要素（overlay の直後 = Tab 順の次）を同じ位置へ
    // 置く。トラップが入った今は、保存ボタンから Tab を送ってもここへは移らない。
    await win.evaluate(() => {
      const target = document.createElement('button');
      target.id = 'outside-focus-target';
      target.textContent = 'パネル外の操作先';
      document.querySelector('.settings-overlay').after(target);
    });
    await win.locator('.settings-save').focus();
    await win.keyboard.press('Tab');
    await expect(win.locator('#outside-focus-target')).not.toBeFocused();
    expect(
      await win.evaluate(() => Boolean(document.activeElement?.closest('.settings-modal'))),
      'Tab で設定パネルの外へ出られてしまった'
    ).toBe(true);

    // 出口を塞いだ結果、自動クローズの時点でフォーカスは必ずパネル内にある。
    // よって #257 で入れた復帰処理がそのまま働き、操作元の設定ボタンへ戻る。
    await win.waitForSelector('.settings-modal', { state: 'detached', timeout: 5000 });
    await expect(win.locator('#settings-btn')).toBeFocused();
  });

  test('設定パネルを開いた要素が消えていたら設定ボタンへフォーカスを戻す', async () => {
    await win.locator('.settings-close').click();
    await win.waitForSelector('.settings-modal', { state: 'detached' });

    // サイドバー再描画で開いたメニュー項目が置き換わる状況を、削除する一時ボタンで再現する。
    await win.evaluate(() => {
      const opener = document.createElement('button');
      opener.id = 'removed-settings-opener';
      opener.textContent = '設定を開く';
      document.body.appendChild(opener);
      opener.focus();
      window.openSettingsModal();
    });
    await expect(win.locator('.settings-modal')).toBeVisible();
    await win.locator('#removed-settings-opener').evaluate((opener) => opener.remove());
    await win.locator('.settings-close').focus();

    await win.keyboard.press('Escape');
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('#settings-btn')).toBeFocused();
  });

  test('保存後に別のタブへ移ると自動クローズを取り消す', async () => {
    // フッター固定を解いて「保存後のタブ移動」を正式に許した以上、移動先を読んでいる
    // 最中にパネルごと消えるのは矛盾する。閉じるタイミングはユーザーに委ねる。
    await win.locator('#set-field-0').fill('127.0.0.1');
    await win.locator('.settings-save').click();
    await expect(win.locator('.settings-msg')).toHaveClass(/ok/);

    await win.locator(TAB_MOBILE).click();

    // 自動クローズ（2.5 秒）を過ぎても開いたまま。
    await win.waitForTimeout(3000);
    await expect(win.locator('.settings-modal')).toBeVisible();
    await expect(win.locator(PANEL_MOBILE)).toBeVisible();
    // 保存できたことは伝わり続ける。
    await expect(win.locator('.settings-msg')).toHaveText('保存しました。次回の起動から反映されます。');
  });

  test('保存後に同じタブで編集を続けても自動クローズしない', async () => {
    // 「操作を続けているなら勝手に閉じない」はタブ移動だけの話ではない。同じタブに
    // 留まったままの編集で閉じると、入力中の内容がそのまま失われる。
    await win.locator('#set-field-0').fill('127.0.0.1');
    await win.locator('.settings-save').click();
    await expect(win.locator('.settings-msg')).toHaveClass(/ok/);

    // 自動クローズ（2.5 秒）が来る前に編集を再開する。
    await win.locator('#set-field-0').fill('100.100.100.100');

    await win.waitForTimeout(3000);
    await expect(win.locator('.settings-modal')).toBeVisible();
    // 入力中の内容も残っている。
    await expect(win.locator('#set-field-0')).toHaveValue('100.100.100.100');
  });

  test('保存後に編集を再開すると「保存しました」が消える', async () => {
    // 閉じないようにしたことで、未保存の変更を抱えたまま成功メッセージが残るように
    // なった。編集を始めた時点で実態と食い違うので消す。
    await win.locator('#set-field-0').fill('127.0.0.1');
    await win.locator('.settings-save').click();
    await expect(win.locator('.settings-msg')).toHaveClass(/ok/);

    await win.locator('#set-field-0').fill('100.100.100.100');
    await expect(win.locator('.settings-msg')).toHaveText('');
    await expect(win.locator('.settings-msg')).not.toHaveClass(/ok/);
    // 未保存の変更として扱われ、保存する手段は残る。
    await expect(win.locator(TAB_GENERAL)).toHaveClass(/is-dirty/);
    await expect(win.locator('.settings-save')).toBeVisible();
  });

  test('保存応答が閉じた後に返ってきても、自動クローズを武装し直さない', async () => {
    // 応答が返る前に閉じられると、閉じた後のクロージャから setTimeout が張られる。
    // その発火は「今開いているモーダル」ではなく前回の overlay を閉じる処理を再実行し、
    // 二重オープン抑止のロックまで解放するため、モーダルが 2 枚重なる。
    const saveDelay = 1500;
    await stubSlowSave(win, saveDelay);
    try {
      await win.locator('#set-field-0').fill('127.0.0.1');
      await win.locator('.settings-save').click();

      // 応答を待たずに ✕ で閉じ、すぐ開き直す。
      await win.locator('.settings-close').click();
      await win.waitForSelector('.settings-modal', { state: 'detached' });
      await win.evaluate(() => window.openSettingsModal());
      await win.waitForSelector('.settings-modal', { state: 'visible' });

      // 開き直した設定パネルにも組み込みスキーマ（settings:describe が実装へ委譲され、
      // 実際のタブ・欄が読み込まれた結果）が描画されていることを確かめる。stubSlowSave は
      // settings:describe を差し替えないため、この再オープンでも同チャンネルが再度実装へ
      // 委譲される（helpers/settings-descriptor.js の stubSlowSave 参照）。ここを見ずに
      // モーダルの個数だけを見ると、委譲が壊れて中身が空のまま描画されても気づけない
      // （issue #304）。
      await expect(win.locator('.settings-tab')).toHaveCount(2);
      await expect(win.locator(`${PANEL_GENERAL} label[for="set-field-0"]`)).toHaveText('API ホスト');

      // 「遅れて返った応答が武装 → その 2.5 秒後に発火」までを待ち切ってから確かめる。
      await win.waitForTimeout(saveDelay + 2500 + 800);
      await win.evaluate(() => window.openSettingsModal());
      await expect(win.locator('.settings-modal')).toHaveCount(1);
    } finally {
      // 後続テストが本来の保存経路を使えるよう、差し替えは必ず戻す。
      await restoreInvoke(win);
    }
  });

  test('Escape キーで設定モーダルを閉じられる', async () => {
    // beforeEach のプログラム呼び出しで開いたモーダルを一度閉じ、実際の設定ボタンから
    // 開き直すことで、Escape 後の具体的なフォーカス復帰先も検証する。
    await win.locator('.settings-close').click();
    await win.waitForSelector('.settings-modal', { state: 'detached' });
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();
    const sidebarWasOpen = await win.evaluate(
      () => document.getElementById('root').classList.contains('sidebar-open')
    );

    await win.keyboard.press('Escape');
    await win.waitForSelector('.settings-modal', { state: 'detached' });
    await expect(win.locator('.settings-modal')).toHaveCount(0);

    // 設定モーダルが最前面で Escape を消費するため、背後のサイドバーは開いたまま。
    // 開閉アニメーション後の遅延時間を越えても、操作元の設定ボタンへ戻ったままになる。
    if (sidebarWasOpen) {
      await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);
      await win.waitForTimeout(400);
      const activeElementId = await win.evaluate(
        () => (document.activeElement && document.activeElement.id) || ''
      );
      expect(activeElementId).toBe('settings-btn');
    }
  });
});
