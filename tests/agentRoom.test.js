'use strict';
// resolveAgentStatesFromOutput（issue #60）のテスト。
// サブエージェントは Claude Code 上で英語ハンドル（wada / ando / remi / uekusa）で起動されるため、
// 直近の PTY 出力には日本語表示名「和田」ではなく英語ハンドルが現れる。
// 旧実装は日本語名でマッチしていたため、起動中でも idle（休憩中）と誤判定していた。

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveAgentStatesFromOutput } = require('../renderer/agentRoom');

test('英語ハンドル @wada を含む出力で和田が working になる', () => {
  const recent = [
    '● Teammate @wada finished',
    '@wada is running …',
  ].join('\n');
  // 注意: ここに日本語名「和田」は一切含まれていない（実運用の TUI 出力を模した形）。
  const states = resolveAgentStatesFromOutput(recent);
  assert.equal(states['和田'], 'working');
});

test('ハンドル wada（裸・ロースター行）を含む出力で和田が working になる', () => {
  const recent = '○ wada  # 和田 (WordPressエンジニア)   idle';
  // ロースター行にはコメントとして日本語名も出るが、依存せず英語ハンドルで判定できること。
  const states = resolveAgentStatesFromOutput(recent);
  assert.equal(states['和田'], 'working');
});

test('ハンドルが全く出てこない出力では全サブエージェントが idle', () => {
  const recent = 'Some unrelated build log output here.';
  const states = resolveAgentStatesFromOutput(recent);
  assert.equal(states['和田'], 'idle');
  assert.equal(states['安藤'], 'idle');
  assert.equal(states['麗美'], 'idle');
  assert.equal(states['植草'], 'idle');
});

test('各ハンドルが対応する日本語名にマッピングされる', () => {
  assert.equal(resolveAgentStatesFromOutput('@ando working')['安藤'], 'working');
  assert.equal(resolveAgentStatesFromOutput('@remi working')['麗美'], 'working');
  assert.equal(resolveAgentStatesFromOutput('@uekusa working')['植草'], 'working');
});

test('部分一致でハンドルを誤検出しない（単語境界）', () => {
  // "andouble" のような語に "ando" が含まれても安藤を working にしない。
  const states = resolveAgentStatesFromOutput('running andouble-check task');
  assert.equal(states['安藤'], 'idle');
});
