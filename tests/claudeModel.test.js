'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_CLAUDE_MODEL_LENGTH,
  isValidClaudeModel,
  buildClaudeLaunchCommand,
  ALLOWED_ENGINES,
  isValidEngine,
  buildEngineLaunchCommand,
  buildEngineAwareLaunchCommand,
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

// ─── engine（issue #367） ───────────────────────────────────────────────

test('ALLOWED_ENGINES: 許可値は claude / codex の2つだけ', () => {
  assert.deepEqual(ALLOWED_ENGINES, ['claude', 'codex']);
});

test('isValidEngine: 許可リストに載っている文字列だけを許可する', () => {
  assert.equal(isValidEngine('claude'), true);
  assert.equal(isValidEngine('codex'), true);
});

test('isValidEngine: 未対応の文字列・空文字・文字列以外を拒否する', () => {
  assert.equal(isValidEngine('gemini'), false);
  assert.equal(isValidEngine('Codex'), false); // 大文字小文字も区別する
  assert.equal(isValidEngine('codex '), false); // 前後の空白も不許可
  assert.equal(isValidEngine(''), false);
  assert.equal(isValidEngine(null), false);
  assert.equal(isValidEngine(undefined), false);
  assert.equal(isValidEngine(0), false);
  assert.equal(isValidEngine(true), false);
  assert.equal(isValidEngine({ engine: 'codex' }), false);
  assert.equal(isValidEngine(['codex']), false);
});

test('isValidEngine: Object.prototype 由来の名前（__proto__ / constructor 等）も許可リスト外として拒否する（安藤の指摘・必須3の回帰テスト）', () => {
  assert.equal(isValidEngine('__proto__'), false);
  assert.equal(isValidEngine('constructor'), false);
  assert.equal(isValidEngine('toString'), false);
  assert.equal(isValidEngine('valueOf'), false);
  assert.equal(isValidEngine('hasOwnProperty'), false);
});

test('buildEngineLaunchCommand: codex は固定文字列 "codex" を返す', () => {
  assert.equal(buildEngineLaunchCommand('codex'), 'codex');
});

test('buildEngineLaunchCommand: claude・未対応値には null を返す（claude は呼び出し側が buildClaudeLaunchCommand を使う）', () => {
  assert.equal(buildEngineLaunchCommand('claude'), null);
  assert.equal(buildEngineLaunchCommand('gemini'), null);
  assert.equal(buildEngineLaunchCommand(''), null);
  assert.equal(buildEngineLaunchCommand(undefined), null);
});

test('buildEngineLaunchCommand: Object.prototype 由来のキーを渡しても継承メンバーを返さず null になる（安藤の指摘 MEDIUM・必須1の回帰テスト）', () => {
  // 修正前は素のオブジェクトリテラル添字アクセスのため、これらのキーで
  // Object.prototype 側の関数（[Function: Object] 等）が `|| null` を通過せずに
  // 返っていた（安藤の実測: buildEngineAwareLaunchCommand('constructor') が
  // { command: [Function: Object] } を返し、PTY へ書き込まれてしまうバグ）。
  assert.equal(buildEngineLaunchCommand('constructor'), null);
  assert.equal(buildEngineLaunchCommand('toString'), null);
  assert.equal(buildEngineLaunchCommand('valueOf'), null);
  assert.equal(buildEngineLaunchCommand('hasOwnProperty'), null);
  assert.equal(buildEngineLaunchCommand('__proto__'), null);
  assert.equal(buildEngineLaunchCommand('isPrototypeOf'), null);
});

test('buildEngineAwareLaunchCommand: engine が claude のときは model 対応の従来コマンドを返し、modelIgnored は常に false', () => {
  assert.deepEqual(buildEngineAwareLaunchCommand('claude', 'sonnet'), {
    command: "claude --model 'sonnet'",
    modelIgnored: false,
  });
  assert.deepEqual(buildEngineAwareLaunchCommand('claude', undefined), {
    command: 'claude',
    modelIgnored: false,
  });
  assert.deepEqual(buildEngineAwareLaunchCommand('claude', 'sonnet; rm -rf /'), {
    command: 'claude',
    modelIgnored: false,
  });
});

test('buildEngineAwareLaunchCommand: engine が codex のときは素の codex を返し、model は無視される', () => {
  // ★ユーザー承認済みの中心仕様: model を無視して素の codex を起動する（400 にはしない）。
  assert.deepEqual(buildEngineAwareLaunchCommand('codex', 'sonnet'), {
    command: 'codex',
    modelIgnored: true,
  });
});

test('buildEngineAwareLaunchCommand: Object.prototype 由来の resolvedEngine が渡っても command は必ず文字列で、安全側の claude へ倒す（安藤の指摘 MEDIUM・必須1の回帰テスト）', () => {
  // resolvedEngine は本来 isValidEngine 済みの値しか来ない想定だが、万一未検証の値が
  // 渡っても任意文字列（関数など）を PTY へ書き込まないことを固定する。
  const protoKeys = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf'];
  for (const engine of protoKeys) {
    const result = buildEngineAwareLaunchCommand(engine, undefined);
    // これだけでも今回のバグ（command が関数になる）は落ちる。
    assert.equal(typeof result.command, 'string', `${engine}: command が文字列ではない`);
    assert.deepEqual(result, { command: 'claude', modelIgnored: false }, `${engine}: 安全側の claude へ倒れていない`);
  }
});

test('buildEngineAwareLaunchCommand: engine が codex で model 未指定のときは modelIgnored が false（無視すべきものが無い）', () => {
  assert.deepEqual(buildEngineAwareLaunchCommand('codex', undefined), {
    command: 'codex',
    modelIgnored: false,
  });
  assert.deepEqual(buildEngineAwareLaunchCommand('codex', null), {
    command: 'codex',
    modelIgnored: false,
  });
});
