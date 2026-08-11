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
//   Chromium は outline-width / outline-offset / border-width の計算値をデバイス
//   ピクセル単位へ丸める（太さ・border-width は整数デバイスピクセルへ、outline-offset は
//   1/64 デバイスピクセル刻みへ切り捨てる）。開発機の OS 表示倍率（devicePixelRatio）が
//   1 以外だと、CSS で固定している "2px" ちょうどが "1.6129px" のような端数になる。
//   一度は Electron 起動時に --force-device-scale-factor=1 を渡して丸めそのものを
//   起こさせない案（案 A）を試したが、escape-modal-layer-regression.smoke.spec.js の
//   マウスドラッグによるテキスト選択が実機（devicePixelRatio が 1 以外）で確実に壊れる
//   副作用が見つかり撤回した（詳細は helpers/electron-app.js の launchApp 冒頭コメント）。
//   代わりにここでは「読み取った値を丸めごと期待値と比較する」方式（案 C）を採る。
//   丸めの最大誤差は 1 device pixel（= 1 / devicePixelRatio CSS px）に収まるため、
//   その範囲のズレは許容し、それを超えるズレだけを実バグとして検出する
//   （devicePixelRatio が 1 の環境では誤差 0 のため、完全一致と同じ強さで検証できる）。
//   Chromium 内部の丸めアルゴリズム（太さと offset で刻みが違う等）をテスト側で
//   再現する案（案 B）は、実装依存のロジックをテストに持ち込み Chromium のバージョンで
//   崩れうるため採らなかった。

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
  const n = parseFloat(value);
  if (Number.isNaN(n)) throw new Error(`${label}: px 値としてパースできない実測値 "${value}"`);
  return n;
}

// devicePixelRatio 由来の丸めを許容しつつ、px の実測値（文字列）と期待値（CSS px の数値）を
// 比較する。許容誤差は「丸めが起こり得る最大値」である 1 device pixel（= 1 / dpr CSS px）。
// 丸めは floor（切り捨て）で起きるため、ズレは必ず 1 device pixel「未満」に収まる。
// 1 device pixel ちょうど（またはそれ以上）のズレは丸めでは起こり得ず実バグ側なので、
// 境界（1 device pixel ちょうど）は許容に含めない。
// dpr が 1 の環境では許容誤差が実質 0（浮動小数の誤差吸収分のみ）になるため、
// 固定値の完全一致と同じ強さで検証できる（例: outline-width が 2px → 1px に壊れていたら、
// diff=1 は tolerance=1-ε を超えるため確実に検出する）。
function expectPxClose(actualPxString, expectedCssPx, dpr, label) {
  const actual = parsePx(actualPxString, label);
  const tolerance = 1 / dpr - 1e-6;
  const diff = Math.abs(actual - expectedCssPx);
  expect(
    diff <= tolerance,
    `${label}: 実測 "${actualPxString}" が期待値 ${expectedCssPx}px から許容誤差 `
      + `${tolerance.toFixed(4)}px（devicePixelRatio=${dpr} での丸め分）を超えてズレている`
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
