'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { buildClaudeLaunchCommand } = require('../renderer/claudeModel');
const { buildClaudeSettingsArgument } = require('../utils/claudeSettingsPreset');
const { withoutBackgroundWorkSettings } = require('./e2e/helpers/claude-arguments');

test('背景設定だけを形の検証後に除き、他の起動引数を保持する', () => {
  const filename = '/tmp/home/.vk-terminals/background-work-Ab123/settings.json';
  const args = ['--model', 'sonnet', '--settings', filename];
  assert.deepEqual(withoutBackgroundWorkSettings(args), ['--model', 'sonnet']);
  assert.equal(args.length, 4);
  assert.deepEqual(withoutBackgroundWorkSettings([]), []);
  assert.deepEqual(withoutBackgroundWorkSettings(['--model', 'opus']), ['--model', 'opus']);
  for (const invalid of [undefined, 'relative/.vk-terminals/background-work-A/settings.json', '/tmp/settings.json', '/tmp/.vk-terminals/background-work-A/other.json']) {
    assert.throws(() => withoutBackgroundWorkSettings(['--settings', invalid]));
  }
  assert.throws(() => withoutBackgroundWorkSettings(['--settings', filename, '--settings', filename]));
});

test('引用符とシェルの特殊文字を含むホームの設定パスを単一引数で渡す', () => {
  const filename = "/tmp/home' space $(false) `false` $HOME ; &/.vk-terminals/background-work-A/settings.json";
  // 本物のシェルを通し、展開されず元のパスが返ることを確認する。
  const capture = command => execFileSync('/bin/sh', ['-c', `claude() { printf '%s\\n' "$@"; }; ${command}`], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(capture(buildClaudeLaunchCommand('sonnet', { backgroundWorkSettingsPath: filename })), ['--model', 'sonnet', '--settings', filename]);
  assert.deepEqual(capture(`claude ${buildClaudeSettingsArgument('vk-orchestrator-work-pane', filename)}`), ['--settings', filename]);
});
