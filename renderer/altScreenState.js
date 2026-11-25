// ペインが代替画面（全画面を描き替える表示方式）を使っているかを、ペインの要素の目印にする（issue #659）。
// 代替画面には遡れる履歴が無いため、この目印を見て CSS が縦スクロールバーを隠す（renderer/style.css 参照）。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VKAltScreenState = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // renderer/style.css のセレクタと同じ名前にそろえる（片方だけ変えるとスクロールバーが隠れない）。
  const ALT_SCREEN_CLASS = 'is-alt-screen';

  /**
   * xterm.js のバッファが代替画面かどうかを返す。
   * @param {{ type?: string } | null | undefined} buffer xterm.js の IBuffer
   * @returns {boolean} 代替画面なら true
   */
  function isAlternateBuffer(buffer) {
    return !!buffer && buffer.type === 'alternate';
  }

  /**
   * 今のバッファに合わせて要素へ目印のクラスを付け外しし、以後のバッファの切り替えにも追従させる。
   * @param {{ buffer: { active: object, onBufferChange: Function } }} term xterm.js の Terminal
   * @param {{ classList: DOMTokenList }} element 目印を付ける要素（.term-viewport）
   * @returns {{ dispose: Function }} 追従をやめるための IDisposable（Terminal の dispose でも解除される）
   */
  function bindAltScreenClass(term, element) {
    const apply = (buffer) => {
      element.classList.toggle(ALT_SCREEN_CLASS, isAlternateBuffer(buffer));
    };
    // 作成時点の状態を反映してから、切り替えを購読する。
    apply(term.buffer.active);
    return term.buffer.onBufferChange(apply);
  }

  return { ALT_SCREEN_CLASS, isAlternateBuffer, bindAltScreenClass };
});
