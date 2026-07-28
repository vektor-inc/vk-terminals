'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createEscapeLayerStack } = require('../renderer/escapeLayer');

// capture / bubble の順序と stopImmediatePropagation を最低限再現するイベント対象。
function createEventTarget() {
  const listeners = { capture: [], bubble: [] };
  return {
    addEventListener(type, listener, capture = false) {
      assert.equal(type, 'keydown');
      listeners[capture ? 'capture' : 'bubble'].push(listener);
    },
    removeEventListener(type, listener, capture = false) {
      assert.equal(type, 'keydown');
      const phase = listeners[capture ? 'capture' : 'bubble'];
      const index = phase.indexOf(listener);
      if (index !== -1) phase.splice(index, 1);
    },
    dispatch(key) {
      let immediatePropagationStopped = false;
      const event = {
        key,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopImmediatePropagation() { immediatePropagationStopped = true; },
      };
      for (const listener of [...listeners.capture]) {
        listener(event);
        if (immediatePropagationStopped) return event;
      }
      for (const listener of [...listeners.bubble]) {
        listener(event);
        if (immediatePropagationStopped) return event;
      }
      return event;
    },
    listeners,
  };
}

test('Escape は capture フェーズで最前面のレイヤーだけが消費する', () => {
  const target = createEventTarget();
  const stack = createEscapeLayerStack(target);
  const called = [];
  target.addEventListener('keydown', () => called.push('background'));

  stack.register(() => called.push('first'));
  stack.register(() => called.push('second'));
  const event = target.dispatch('Escape');

  assert.deepEqual(called, ['second']);
  assert.equal(event.defaultPrevented, true);
  assert.equal(target.listeners.capture.length, 1);
});

test('最前面を解除すると、その次の Escape は直前のレイヤーへ渡る', () => {
  const target = createEventTarget();
  const stack = createEscapeLayerStack(target);
  const called = [];
  stack.register(() => called.push('first'));
  const unregisterSecond = stack.register(() => called.push('second'));

  assert.equal(unregisterSecond(), true);
  target.dispatch('Escape');

  assert.deepEqual(called, ['first']);
});

test('コールバック内で自身を解除しても、同じ Escape で背後のレイヤーは呼ばない', () => {
  const target = createEventTarget();
  const stack = createEscapeLayerStack(target);
  const called = [];
  stack.register(() => called.push('first'));
  let unregisterSecond = () => {};
  unregisterSecond = stack.register(() => {
    called.push('second');
    unregisterSecond();
  });

  target.dispatch('Escape');
  assert.deepEqual(called, ['second']);

  target.dispatch('Escape');
  assert.deepEqual(called, ['second', 'first']);
});

test('全レイヤーを解除するとリスナーを外し、Escape を背後へ通す', () => {
  const target = createEventTarget();
  const stack = createEscapeLayerStack(target);
  const called = [];
  target.addEventListener('keydown', () => called.push('background'));
  const unregister = stack.register(() => called.push('modal'));

  assert.equal(unregister(), true);
  assert.equal(unregister(), false);
  assert.equal(target.listeners.capture.length, 0);

  const event = target.dispatch('Escape');
  assert.deepEqual(called, ['background']);
  assert.equal(event.defaultPrevented, false);
});

test('Escape 以外のキーはレイヤーがあっても消費しない', () => {
  const target = createEventTarget();
  const stack = createEscapeLayerStack(target);
  const called = [];
  target.addEventListener('keydown', () => called.push('background'));
  stack.register(() => called.push('modal'));

  const event = target.dispatch('Enter');

  assert.deepEqual(called, ['background']);
  assert.equal(event.defaultPrevented, false);
});
