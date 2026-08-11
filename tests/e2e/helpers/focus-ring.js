// フォーカスリング確認 e2e の共通ヘルパー（issue #357 で共通化）。
//
// settings-shared-focus.smoke.spec.js / focus-ring-catch-all.smoke.spec.js /
// sidebar-resizer-focus-ring.smoke.spec.js / mobile-shared-boot.smoke.spec.js の
// 4 spec が、キーボードでのフォーカス操作（focusByKeyboard）と outline の
// computed style 読み取り（readRing / readOutline、ファイルによって名前も違う）を
// ほぼ同じ実装でそれぞれ写して持っていた。写しが増えるほど直し漏れが起きやすく、
// 実際に issue #357 では「太さ・オフセットを固定値の完全一致で見る」という同じ
// 書き方を 5 spec が独立に採用していたために、開発機の表示倍率が 1 以外
// （devicePixelRatio 1.24 相当）だと 5 spec 同時に赤くなった。今回それを機に
// 読み取り・比較部分をここへ集約し、次に同じ直し漏れが起きないようにする。
//
// win（Electron のウィンドウ。app.firstWindow() の戻り値）と page（プレーンな
// Playwright ページ。mobile-shared-boot.smoke.spec.js が chromium.launch() で開く
// モバイルページなど）はどちらも Playwright の Page 互換オブジェクト（evaluate /
// keyboard / locator を持つ）なので、同じ関数をそのまま両方に使える。
//
// devicePixelRatio 由来の丸めについて（issue #357 の対策方針）:
//   Chromium は outline-width / outline-offset / border-width、および固定サイズ要素の
//   width / height の計算値をデバイスピクセル単位へ丸める。刻みはプロパティ・環境・
//   Chromium のバージョンで揺れる（安藤さんの実測では border-width は整数デバイスピクセル
//   へ切り捨てだったが、outline-offset は 1/64 デバイスピクセル刻みで切り捨てられた環境と、
//   整数デバイスピクセルへ切り捨てられた環境の両方が確認できている）。開発機の OS 表示倍率
//   （devicePixelRatio）が 1 以外だと、CSS で固定している "2px" ちょうどが "1.6129px" の
//   ような端数になる。
//   一度は Electron 起動時に --force-device-scale-factor=1 を渡して丸めそのものを
//   起こさせない案（案 A）を試したが、escape-modal-layer-regression.smoke.spec.js の
//   マウスドラッグによるテキスト選択が実機（devicePixelRatio が 1 以外）で確実に壊れる
//   副作用が見つかり撤回した（詳細は helpers/electron-app.js の launchApp 冒頭のコメント）。
//   代わりにここでは「読み取った値を丸めごと期待値と比較する」方式（案 C）を採る。
//   丸めの最大誤差は 1 device pixel（= 1 / devicePixelRatio CSS px）に収まるため、
//   その範囲のズレは許容し、それを超えるズレだけを実バグとして検出する。
//   ただし「期待値がデバイスピクセル格子にちょうど乗る」場合は、どんな丸め方（切り捨て・
//   四捨五入等）をしても値は動かないため丸めは起こり得ない。この場合だけ完全一致を要求する
//   （devicePixelRatio が 1 の環境は常にこちらに該当するため、CI では従来どおり完全一致の
//   検出力を保つ。詳細は expectPxClose 内のコメントを参照）。
//   Chromium 内部の丸めアルゴリズムそのもの（太さと offset で刻みが違う、環境によっても
//   違う）をテスト側で再現する案（案 B）は、実装依存のロジックをテストに持ち込み
//   Chromium のバージョン・環境で崩れうるため採らなかった。
//
//   この方式は window.devicePixelRatio が実際の描画スナップ格子を正しく表していることに
//   依存する。Playwright の context が deviceScaleFactor をエミュレーションで上書きすると、
//   実際のレンダリングは（エミュレーション前の）実機倍率の格子で丸められたままなのに
//   window.devicePixelRatio はエミュレーション後の値を返す食い違いが起こりうる
//   （安藤さんの実測で確認済み）。今の構成（context の deviceScaleFactor を明示しない）
//   では tolerance が過大になる方向にしか振れず実害は無いが、将来 chromium.launch() /
//   newContext() に deviceScaleFactor や倍率系フラグを足す場合は、この前提が崩れて
//   tolerance が過小（偽陽性の元）になり得るため注意すること。

const { expect } = require('@playwright/test');

// キーボード由来のフォーカスでないと :focus-visible は当たらない。
// 対象へ focus() したあと Tab で隣の停止位置へ抜け、Shift+Tab で戻すことで
// 「キーボードで選んだ状態」を作る（要素の並び順に依存せずどの停止位置でも成立する）。
async function focusByKeyboard(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`${sel} が見つからない`);
    el.scrollIntoView({ block: 'center' });
    el.focus();
  }, selector);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  // 戻り先が対象であること（= 以降の computed style がその要素のものであること）を確かめる。
  // コピーボタンのように同じクラスが複数ある場合に備え、evaluate 側の querySelector と
  // 同じ「先頭の 1 つ」を見る。
  await expect(page.locator(selector).first()).toBeFocused();
  expect(
    await page.evaluate((sel) => document.querySelector(sel).matches(':focus-visible'), selector),
    `${selector} が :focus-visible にならない`
  ).toBe(true);
}

// 実際に描かれている outline を読む。期待値との比較にも、既に揃っている要素との
// 突き合わせにも同じ読み取りを使い、見る項目が増えたときの直し漏れを防ぐ。
async function readOutline(page, selector) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`${sel} が見つからない`);
    const s = getComputedStyle(el);
    return {
      color: s.outlineColor,
      style: s.outlineStyle,
      width: s.outlineWidth,
      offset: s.outlineOffset,
    };
  }, selector);
}

// "2px" / "-1.99093px" のような px 文字列を数値へ変換する。
function parsePx(value, label) {
  // "1px 0px 1px 1px" のような複数値ショートハンド（例: border-width が四辺不揃いのとき）を
  // parseFloat の「先頭値だけ拾う」性質で気付かずに通してしまわないよう、空白を含む値は
  // ここで弾く。呼び出し側は borderTopWidth / borderRightWidth / ... のように辺ごとの
  // プロパティを個別に渡すこと。
  const str = String(value).trim();
  if (/\s/.test(str)) {
    throw new Error(`${label}: 複数値のショートハンド "${value}" は 1 値ずつ比較すること（辺ごとのプロパティを個別に渡す）`);
  }
  const n = parseFloat(str);
  if (Number.isNaN(n)) throw new Error(`${label}: px 値としてパースできない実測値 "${value}"`);
  return n;
}

// devicePixelRatio 由来の丸めを許容しつつ、px の実測値（文字列）と期待値（CSS px の数値）を
// 比較する。
//
// 期待値がデバイスピクセル格子にちょうど乗る（= expectedCssPx * dpr が整数に等しい）場合、
// 切り捨て・四捨五入などどんな丸め方をしても値は動かないため丸めは起こり得ない。この場合は
// 許容誤差をほぼ 0 にして完全一致を要求する（devicePixelRatio が 1 の環境は
// expectedCssPx * 1 が常に整数なので必ずこちらに該当し、CI では従来どおり完全一致と
// 同じ検出力になる。dpr=2 で outline-width 2px を見る場合なども同様に格子に乗る）。
// 格子に乗らない場合だけ、丸めが起こり得る最大値である 1 device pixel（= 1 / dpr CSS px）
// 未満（floor による切り捨てのため、ズレは必ず 1 device pixel 未満に収まる。1 device
// pixel ちょうど以上のズレは丸めでは起こり得ず実バグ側なので境界は含めない）を許容する。
function expectPxClose(actualPxString, expectedCssPx, dpr, label) {
  const actual = parsePx(actualPxString, label);
  const expectedDevicePx = expectedCssPx * dpr;
  const onGrid = Math.abs(expectedDevicePx - Math.round(expectedDevicePx)) < 1e-6;
  const tolerance = onGrid ? 1e-6 : 1 / dpr - 1e-6;
  const diff = Math.abs(actual - expectedCssPx);
  expect(
    diff <= tolerance,
    `${label}: 実測 "${actualPxString}" が期待値 ${expectedCssPx}px から許容誤差 `
      + `${tolerance.toFixed(6)}px（devicePixelRatio=${dpr}、`
      + `${onGrid ? 'デバイスピクセル格子に乗るため丸めは起こらない想定' : '丸めの許容分'}）を超えてズレている`
  ).toBe(true);
}

// アプリ共通のフォーカスリングと比較する。color / style は丸めの影響を受けないため
// 完全一致のまま、width / offset だけ devicePixelRatio 由来の丸めを許容する
// （expected の width / offset は CSS px の数値で渡す。例: { width: 2, offset: -2 }）。
async function expectOutline(page, selector, expected, label = selector) {
  const [dpr, actual] = await Promise.all([
    page.evaluate(() => window.devicePixelRatio),
    readOutline(page, selector),
  ]);
  expect(actual.color, `${label} の outline-color`).toBe(expected.color);
  expect(actual.style, `${label} の outline-style`).toBe(expected.style);
  expectPxClose(actual.width, expected.width, dpr, `${label} の outline-width`);
  expectPxClose(actual.offset, expected.offset, dpr, `${label} の outline-offset`);
}

module.exports = { expectOutline, expectPxClose, focusByKeyboard, readOutline };
