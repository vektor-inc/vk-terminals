'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_CLAUDE_MODEL_LENGTH,
  isValidClaudeModel,
  buildClaudeLaunchCommand,
} = require('../renderer/claudeModel');

test('isValidClaudeModel: 実在するモデル名を許可する', () => {
  assert.equal(isValidClaudeModel('sonnet'), true);
  assert.equal(isValidClaudeModel('opus'), true);
  assert.equal(isValidClaudeModel('haiku'), true);
  assert.equal(isValidClaudeModel('claude-sonnet-5'), true);
  // 角括弧付きのモデル名（zsh のファイル名展開記号を含む）も許可対象。
  assert.equal(isValidClaudeModel('claude-opus-5[1m]'), true);
  assert.equal(isValidClaudeModel('claude-3.5-sonnet_20240620'), true);
});

test('isValidClaudeModel: シェルのメタ文字を含む値を拒否する', () => {
  assert.equal(isValidClaudeModel('sonnet; rm -rf /'), false);
  assert.equal(isValidClaudeModel('sonnet && curl evil'), false);
  assert.equal(isValidClaudeModel('sonnet | tee /tmp/x'), false);
  assert.equal(isValidClaudeModel('$(whoami)'), false);
  assert.equal(isValidClaudeModel('sonnet$(whoami)'), false);
  assert.equal(isValidClaudeModel('`whoami`'), false);
  assert.equal(isValidClaudeModel('sonnet`whoami`'), false);
  assert.equal(isValidClaudeModel("sonnet' ; whoami ; '"), false);
  assert.equal(isValidClaudeModel("'"), false);
  assert.equal(isValidClaudeModel('"sonnet"'), false);
  assert.equal(isValidClaudeModel('sonnet > /tmp/x'), false);
  assert.equal(isValidClaudeModel('sonnet $HOME'), false);
});

test('isValidClaudeModel: 改行・復帰を含む値を拒否する', () => {
  // \r はペインに書き込むと実行になるため、末尾でも必ず落ちること。
  assert.equal(isValidClaudeModel('sonnet\r'), false);
  assert.equal(isValidClaudeModel('sonnet\n'), false);
  assert.equal(isValidClaudeModel('sonnet\r\nwhoami'), false);
  assert.equal(isValidClaudeModel('sonnet\nwhoami'), false);
  assert.equal(isValidClaudeModel('\rsonnet'), false);
  assert.equal(isValidClaudeModel('sonnet whoami'), false);
});

test('isValidClaudeModel: 空文字・長さ超過・先頭記号を拒否する', () => {
  assert.equal(isValidClaudeModel(''), false);
  assert.equal(isValidClaudeModel(' '), false);
  assert.equal(isValidClaudeModel('a'.repeat(MAX_CLAUDE_MODEL_LENGTH)), true);
  assert.equal(isValidClaudeModel('a'.repeat(MAX_CLAUDE_MODEL_LENGTH + 1)), false);
  // 先頭は英数字のみ（`-` 始まりは claude 側で別のオプションとして解釈されうる）。
  assert.equal(isValidClaudeModel('-sonnet'), false);
  assert.equal(isValidClaudeModel('--dangerously-skip-permissions'), false);
  assert.equal(isValidClaudeModel('.sonnet'), false);
  assert.equal(isValidClaudeModel('[sonnet]'), false);
});

test('isValidClaudeModel: 非文字列を拒否する', () => {
  assert.equal(isValidClaudeModel(null), false);
  assert.equal(isValidClaudeModel(undefined), false);
  assert.equal(isValidClaudeModel(0), false);
  assert.equal(isValidClaudeModel(5), false);
  assert.equal(isValidClaudeModel(true), false);
  assert.equal(isValidClaudeModel({ model: 'sonnet' }), false);
  assert.equal(isValidClaudeModel(['sonnet']), false);
  assert.equal(isValidClaudeModel(() => 'sonnet'), false);
});

test('buildClaudeLaunchCommand: 未指定・不正値では素の claude を返す（後方互換）', () => {
  // 既存の呼び出し元（オーケストレーター現行版・モバイルの追加ボタン・additionalPanes）は
  // model を渡さないため、書き込まれる文字列が従来と完全に同一であることを固定する。
  assert.equal(buildClaudeLaunchCommand(undefined), 'claude');
  assert.equal(buildClaudeLaunchCommand(null), 'claude');
  assert.equal(buildClaudeLaunchCommand(''), 'claude');
  assert.equal(buildClaudeLaunchCommand('sonnet; rm -rf /'), 'claude');
  assert.equal(buildClaudeLaunchCommand('sonnet && curl evil'), 'claude');
  assert.equal(buildClaudeLaunchCommand('$(whoami)'), 'claude');
  assert.equal(buildClaudeLaunchCommand('`whoami`'), 'claude');
  assert.equal(buildClaudeLaunchCommand("sonnet' ; whoami ; '"), 'claude');
  assert.equal(buildClaudeLaunchCommand('sonnet\r'), 'claude');
  assert.equal(buildClaudeLaunchCommand('sonnet\n'), 'claude');
  assert.equal(buildClaudeLaunchCommand('a'.repeat(MAX_CLAUDE_MODEL_LENGTH + 1)), 'claude');
  assert.equal(buildClaudeLaunchCommand(5), 'claude');
  assert.equal(buildClaudeLaunchCommand({ model: 'sonnet' }), 'claude');
});

test('buildClaudeLaunchCommand: 正常値はシングルクォートで囲んで返す', () => {
  assert.equal(buildClaudeLaunchCommand('sonnet'), "claude --model 'sonnet'");
  assert.equal(buildClaudeLaunchCommand('opus'), "claude --model 'opus'");
  assert.equal(buildClaudeLaunchCommand('claude-sonnet-5'), "claude --model 'claude-sonnet-5'");
  // 角括弧はクォート内にあるため zsh のファイル名展開が働かない。
  assert.equal(buildClaudeLaunchCommand('claude-opus-5[1m]'), "claude --model 'claude-opus-5[1m]'");
});

test('buildClaudeLaunchCommand: 戻り値に改行・シングルクォートの脱出が混入しない', () => {
  // 許可文字にシングルクォートが無いため、クォートが閉じられることはない。
  const candidates = ['sonnet', 'opus', 'claude-opus-5[1m]', 'claude-3.5-sonnet_20240620'];
  for (const model of candidates) {
    const command = buildClaudeLaunchCommand(model);
    assert.equal(command.includes('\r'), false);
    assert.equal(command.includes('\n'), false);
    // シングルクォートは開始と終了の 2 個ちょうど。
    assert.equal(command.split("'").length - 1, 2);
  }
});
