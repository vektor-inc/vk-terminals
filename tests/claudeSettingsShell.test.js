'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { quoteShellPath } = require('../utils/shellQuoting');
const { buildClaudeSettingsArgument, quoteClaudeSettingsPath, prepareClaudeSettingsForShell } = require('../utils/claudeSettingsPreset');
const { buildClaudeLaunchCommand } = require('../renderer/claudeModel');
const { createAgentLifecycleStore } = require('../utils/agentLifecycle');
const preset = 'vk-orchestrator-work-pane';
const paths = ['/tmp/plain.json', '/tmp/a b.json', "/tmp/a'quote.json", '/tmp/a‘’‚‛.json', '/tmp/a\\b.json', '/tmp/$value.json', '/tmp/100%.json', '/tmp/a"b.json'];
function findShell(name) {
  const result = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

test('PowerShell 用プリセットの引用結果を固定する', () => {
  assert.equal(buildClaudeSettingsArgument(preset, "/tmp/a'‘’‚‛.json", 'pwsh'), "--settings '/tmp/a''‘‘’’‚‚‛‛.json'");
});
test('新規と再起動はそれぞれのペインのシェルを渡す', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(source, /preparePaneBackgroundWork\(id, 1, resolvedEngine, claudeLaunchOptions, shell\)/);
  assert.match(source, /stagePaneBackgroundWork\(request.termId, currentGeneration \+ 1, request.engine, launchOptions, ptyShellExecutables.get\(request.termId\)\)/);
});

// シェル別の引用と、両方の設定ファイルの組み立てを確認する。
for (const [shell, kind] of [['bash', 'posix'], ['zsh', 'posix'], ['fish', 'fish'], ['pwsh', 'powershell'], ['cmd.exe', 'cmd']]) {
  test(`${shell} 用の設定パスを組み立てる`, () => {
    for (const filename of paths) {
      const expected = quoteShellPath(filename, kind);
      assert.equal(quoteClaudeSettingsPath(filename, shell), expected);
      if (expected === null) {
        assert.throws(() => buildClaudeSettingsArgument(preset, filename, shell));
      } else {
        assert.equal(buildClaudeSettingsArgument(preset, filename, shell), `--settings ${expected}`);
        const { options } = prepareClaudeSettingsForShell({}, shell, { filename, discard() {} });
        assert.equal(buildClaudeLaunchCommand(undefined, options), `claude --settings ${expected}`);
      }
    }
  });
}
test('PowerShell の引用文字と fish のバックスラッシュを引用する', () => {
  assert.equal(quoteClaudeSettingsPath("/tmp/a'‘’‚‛", 'pwsh'), "'/tmp/a''‘‘’’‚‚‛‛'");
  assert.equal(quoteClaudeSettingsPath('/tmp/a\\b', 'fish'), "'/tmp/a\\\\b'");
  assert.equal(quoteClaudeSettingsPath('/tmp/plain.json', 'bash'), "'/tmp/plain.json'");
});
for (const route of ['新規', '再起動']) {
  test(`${route}では引用できない一時設定を回収し必須設定は失敗にする`, () => {
    for (const shell of ['unknown', undefined, 'cmd.exe']) {
      let discarded = 0;
      const prepared = { filename: '/tmp/a %.json', discard() { discarded++; } };
      const fallback = prepareClaudeSettingsForShell({}, shell, prepared);
      assert.equal(fallback.prepared, undefined);
      assert.equal(buildClaudeLaunchCommand(undefined, fallback.options), 'claude');
      assert.equal(discarded, 1);
      assert.throws(() => prepareClaudeSettingsForShell({ claudeSettingsPreset: preset, claudeSettingsPath: '/tmp/a %.json' }, shell, prepared));
      assert.equal(discarded, 2);
      const required = prepareClaudeSettingsForShell({ claudeSettingsPreset: preset, claudeSettingsPath: '/tmp/plain.json', buildClaudeSettingsArgument }, shell, prepared);
      const expected = shell === 'cmd.exe' ? '"/tmp/plain.json"' : "'/tmp/plain.json'";
      assert.equal(buildClaudeLaunchCommand(undefined, required.options), `claude --settings ${expected}`);
    }
  });
}
test('不明なシェルでは通常の設定パスだけを引用する', () => {
  for (const shell of ['unknown', undefined]) {
    assert.equal(quoteClaudeSettingsPath('/tmp/plain.json', shell), "'/tmp/plain.json'");
    for (const filename of [...paths.slice(1), '/tmp/plain.json\n']) assert.equal(quoteClaudeSettingsPath(filename, shell), null);
  }
});
test('PowerShell では準備コマンドを送らず起動へ進む', async () => {
  const store = createAgentLifecycleStore({ listProcesses() { throw new Error('unexpected'); } });
  try {
    const token = store.initialize('1', 1);
    assert.deepEqual(await store.prepare('1', 1, token, 10, 'claude', '/tmp/pwsh'), { status: 'passthrough', command: 'claude' });
  } finally { store.close(); }
});

// 実際の起動文字列でダミーの Claude Code に引数を渡す。
for (const [shellName, kind] of [['bash', 'posix'], ['zsh', 'posix'], ['fish', 'fish'], ['pwsh', 'powershell'], ['cmd.exe', 'cmd']]) {
  const shell = shellName === 'cmd.exe' && process.platform === 'win32' ? shellName : findShell(shellName);
  test(`${shellName} の実物で設定パスを往復する`, { skip: !shell }, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-settings-'));
    try {
      const helper = path.join(directory, 'argv.js');
      fs.writeFileSync(helper, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
      for (const filename of paths) {
        if (quoteClaudeSettingsPath(filename, shell) === null) continue;
        for (const options of [
          prepareClaudeSettingsForShell({}, shell, { filename, discard() {} }).options,
          prepareClaudeSettingsForShell({ claudeSettingsPreset: preset, claudeSettingsPath: filename, buildClaudeSettingsArgument }, shell).options,
        ]) {
          const prefix = `${kind === 'powershell' ? '& ' : ''}${quoteShellPath(process.execPath, kind)} ${quoteShellPath(helper, kind)}`;
          let command = buildClaudeLaunchCommand(undefined, options).replace(/^claude/, prefix);
          let args = kind === 'powershell' ? ['-NoProfile', '-Command'] : ['-c'];
          if (kind === 'cmd') { command = `"${command}"`; args = ['/d', '/s', '/c']; }
          const result = spawnSync(shell, [...args, command], { encoding: 'utf8', windowsVerbatimArguments: kind === 'cmd' });
          assert.equal(result.status, 0, result.stderr);
          assert.deepEqual(JSON.parse(result.stdout), ['--settings', filename]);
        }
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}
