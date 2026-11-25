const test = require('node:test');
const assert = require('node:assert/strict');
const { ALT_SCREEN_CLASS, isAlternateBuffer, bindAltScreenClass } = require('../renderer/altScreenState');

// xterm.js の Terminal のうち、bindAltScreenClass が使う buffer.active と onBufferChange だけを模す。
// switchTo() は xterm.js がバッファを切り替えたときと同じく、新しい active を渡して購読者を呼ぶ。
function createFakeTerm(initialType) {
  const listeners = new Set();
  const term = {
    buffer: {
      active: { type: initialType },
      onBufferChange(listener) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    },
    switchTo(type) {
      term.buffer.active = { type };
      listeners.forEach((listener) => listener(term.buffer.active));
    },
  };
  return term;
}

// classList の toggle(name, force) / contains(name) だけを持つ要素。
function createFakeElement() {
  const classes = new Set(['term-viewport']);
  return {
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
        return force;
      },
      contains: (name) => classes.has(name),
    },
  };
}

test('isAlternateBuffer は代替画面のバッファだけ true を返す', () => {
  const cases = [
    { buffer: { type: 'alternate' }, expected: true },
    { buffer: { type: 'normal' }, expected: false },
    { buffer: {}, expected: false },
    { buffer: null, expected: false },
    { buffer: undefined, expected: false },
  ];
  for (const { buffer, expected } of cases) {
    assert.equal(isAlternateBuffer(buffer), expected, JSON.stringify(buffer));
  }
});

test('bindAltScreenClass は作成時点のバッファに合わせて目印を付ける', () => {
  const cases = [
    { initialType: 'normal', expected: false },
    { initialType: 'alternate', expected: true },
  ];
  for (const { initialType, expected } of cases) {
    const element = createFakeElement();
    bindAltScreenClass(createFakeTerm(initialType), element);
    assert.equal(element.classList.contains(ALT_SCREEN_CLASS), expected, initialType);
    // 既存のクラスは消さない。
    assert.equal(element.classList.contains('term-viewport'), true);
  }
});

test('bindAltScreenClass は代替画面に入ると目印を付け、通常画面に戻ると外す', () => {
  const term = createFakeTerm('normal');
  const element = createFakeElement();
  bindAltScreenClass(term, element);

  term.switchTo('alternate');
  assert.equal(element.classList.contains(ALT_SCREEN_CLASS), true);

  term.switchTo('normal');
  assert.equal(element.classList.contains(ALT_SCREEN_CLASS), false);

  // もう一度入り直しても追従する。
  term.switchTo('alternate');
  assert.equal(element.classList.contains(ALT_SCREEN_CLASS), true);
});

test('bindAltScreenClass の戻り値を dispose すると以後の切り替えに追従しない', () => {
  const term = createFakeTerm('normal');
  const element = createFakeElement();
  const subscription = bindAltScreenClass(term, element);

  subscription.dispose();
  term.switchTo('alternate');
  assert.equal(element.classList.contains(ALT_SCREEN_CLASS), false);
});
