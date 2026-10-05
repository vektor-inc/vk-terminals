'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveInitialPaneLaunch } = require('../utils/initialPaneLaunch');

test('設定が無い・空のときは従来どおり Claude Code（モデル指定なし）', () => {
  assert.deepEqual(resolveInitialPaneLaunch({}), { engine: 'claude', model: '' });
  assert.deepEqual(resolveInitialPaneLaunch(undefined), { engine: 'claude', model: '' });
  assert.deepEqual(resolveInitialPaneLaunch(null), { engine: 'claude', model: '' });
});

test('initialEngine が codex なら Codex、モデル未指定なら既定モデルのまま', () => {
  assert.deepEqual(resolveInitialPaneLaunch({ initialEngine: 'codex' }), { engine: 'codex', model: '' });
});

test('Codex のモデルは前後の空白を除いて渡す', () => {
  assert.deepEqual(
    resolveInitialPaneLaunch({ initialEngine: 'codex', initialCodexModel: '  gpt-5.5 ' }),
    { engine: 'codex', model: 'gpt-5.5' },
  );
});

test('許可リスト外のエンジンは Claude Code へ倒し、モデルも無視する', () => {
  for (const bad of ['gemini', 'CODEX', 'constructor', 42, true, ['codex'], {}]) {
    assert.deepEqual(
      resolveInitialPaneLaunch({ initialEngine: bad, initialCodexModel: 'gpt-5.5' }),
      { engine: 'claude', model: '' },
      `initialEngine=${JSON.stringify(bad)}`,
    );
  }
});

test('Claude 選択時は Codex モデルを無視する', () => {
  assert.deepEqual(
    resolveInitialPaneLaunch({ initialEngine: 'claude', initialCodexModel: 'gpt-5.5' }),
    { engine: 'claude', model: '' },
  );
});

test('不正なモデル名（クォート・空白・シェルメタ文字・長すぎる値・文字列以外）は空にする', () => {
  const bad = ["gpt'; rm -rf ~; '", 'gpt 5', '$(id)', '-model', 'a'.repeat(65), 5, null, ['gpt-5.5']];
  for (const model of bad) {
    assert.deepEqual(
      resolveInitialPaneLaunch({ initialEngine: 'codex', initialCodexModel: model }),
      { engine: 'codex', model: '' },
      `initialCodexModel=${JSON.stringify(model)}`,
    );
  }
});
