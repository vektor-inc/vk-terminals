'use strict';

const { quoteShellPath } = require('../utils/shellQuoting');

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { quoteShellArgument } = require('../utils/restartAgent');
const renderer = require('../renderer/claudeModel');
const { buildClaudeSettingsArgument } = require('../utils/claudeSettingsPreset');

const values = ["'", '\\', "\\'", "'\\", 'a b', '$(printf unused)', '`unused`', '!', "a\\' b'\\$(unused)`unused`!"];
test('起動経路の引用結果をそろえる', () => {
  for (const value of values) {
    const filename = '/tmp/' + value;
    assert.equal(renderer.quoteShellArgument(value), quoteShellArgument(value));
    assert.equal(buildClaudeSettingsArgument('vk-orchestrator-work-pane', filename, '/bin/sh'), '--settings ' + quoteShellPath(filename, 'posix'));
    assert.equal(renderer.buildClaudeLaunchCommand(undefined, { backgroundWorkSettingsPath: filename, quoteClaudeSettingsPath: (value) => quoteShellPath(value, 'posix') }), 'claude --settings ' + quoteShellPath(filename, 'posix'));
  }
});

// シェルの違いによらず単一の引数として渡す。
for (const shell of ['sh', 'bash', 'zsh', 'fish']) {
  const available = spawnSync(shell, ['-c', 'exit 0']);
  test(shell + ' に元の値を単一引数で渡す', { skip: available.error?.code === 'ENOENT' }, () => {
    for (const value of values) {
      const command = `printf '<%s>' ${quoteShellArgument(value)}`;
      const result = spawnSync(shell, ['-c', command], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '<' + value + '>');
    }
  });
}
