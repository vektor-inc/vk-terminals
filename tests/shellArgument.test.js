'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { quoteShellArgument } = require('../utils/restartAgent');
const renderer = require('../renderer/claudeModel');
const { buildClaudeSettingsArgument } = require('../utils/claudeSettingsPreset');
const { quoteFileDropArgument } = require('../renderer/fileDropArgument');

const values = ["'", '\\', "\\'", "'\\", 'a b', '$(printf unused)', '`unused`', '!', "a\\' b'\\$(unused)`unused`!"];
test('起動経路の引用結果をそろえる', () => {
  for (const value of values) {
    const filename = '/tmp/' + value;
    for (const platform of ['MacIntel', 'Linux x86_64']) {
      assert.equal(quoteFileDropArgument(value, platform), quoteShellArgument(value));
    }
    assert.equal(renderer.quoteShellArgument(value), quoteShellArgument(value));
    assert.equal(buildClaudeSettingsArgument('vk-orchestrator-work-pane', filename), '--settings ' + quoteShellArgument(filename));
    assert.equal(renderer.buildClaudeLaunchCommand(undefined, { backgroundWorkSettingsPath: filename }), 'claude --settings ' + quoteShellArgument(filename));
  }
});

test('Windows のドロップはバックスラッシュを保持し引用符を二重化する', () => {
  for (const platform of ['Win32', 'Win64', 'win32']) {
    assert.equal(quoteFileDropArgument('C:\\Users\\kuru\\a.png', platform), "'C:\\Users\\kuru\\a.png'");
    assert.equal(quoteFileDropArgument("C:\\Users\\kuru\\a'b.png", platform), "'C:\\Users\\kuru\\a''b.png'");
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
      for (const platform of ['MacIntel', 'Linux x86_64']) {
        const dropped = spawnSync(shell, ['-c', `printf '<%s>' ${quoteFileDropArgument(value, platform)}`], { encoding: 'utf8' });
        assert.equal(dropped.status, 0, dropped.stderr);
        assert.equal(dropped.stdout, '<' + value + '>');
      }
    }
  });
}

// PowerShell が導入されている環境では、実際の引数数と値も確認する。
const powershell = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']);
test('PowerShell にドロップしたパスを単一引数で渡す', { skip: powershell.error?.code === 'ENOENT' }, () => {
  for (const value of [...values, 'C:\\Users\\kuru\\a.png', "C:\\Users\\kuru\\a'b.png", '']) {
    const command = `& { if ($args.Count -ne 1) { exit 1 }; [Console]::Write($args[0]) } ${quoteFileDropArgument(value, 'Win32')}`;
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, value);
  }
});
