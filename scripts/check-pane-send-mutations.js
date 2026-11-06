'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pane-send-mutations-'));
// 中断時にも一時コピーを削除する。
const cleanup = () => fs.rmSync(temporary, { recursive: true, force: true });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
for (const name of ['utils', 'tests', 'renderer']) fs.cpSync(path.join(root, name), path.join(temporary, name), { recursive: true });
fs.copyFileSync(path.join(root, 'main.js'), path.join(temporary, 'main.js'));
// 一度に一つだけ安全条件を壊し、一時コピーだけを書き換える。
const mutations = [
  ['log field allowlist', 'utils/paneSendLog.js', 'JSON.stringify({ time, id, source, target, engine, result, reason })', 'JSON.stringify(record)'],
  ['renderer identifier', 'renderer/app.js', 't.screenIdentifier !== expected.screenIdentifier', 'false'],
  ['renderer generation', 'renderer/app.js', 't.screenIdentifierGeneration !== expected.agentGeneration', 'false'],
  ['renderer write queue', 'renderer/app.js', "t.term.write('', () => {", "((_, callback) => callback())('', () => {"],
  ['dim capture', 'renderer/paneSnapshot.js', 'dim: !!cell.isDim()', 'dim: false'],
  ['post-body current', 'utils/paneSend.js', '!guard.isCurrent(target, { agentGeneration: generation, screenIdentifier: echoed.screenIdentifier })', 'false'],
  ['fold number', 'utils/paneSend.js', 'Number(field.text.match(/#(\\d+)/)[1]) > Math.max(0, ...state.lines.flatMap(line => [...line.text.matchAll(/\\[Pasted text #(\\d+)/g)].map(m => Number(m[1]))))', 'true'],
  ['footer change', 'utils/paneSend.js', "(field.footer !== originalField.footer && !(claudeFolded && field.footer.split('\\n').slice(1).filter(line => line.trim()).join('\\n').trim() === 'paste again to expand'))", 'false'],
  ['whitespace draft', 'utils/paneSend.js', "if (!text && (state.cursorY > i || state.cursorX > prompt[0].length)) text = ' ';", ''],
  ['start delimiter random ID', 'utils/paneSend.js', '--- 依頼本文 ${id} ---', '--- 依頼本文 ---'],
  ['Codex below cursor', 'utils/paneSend.js', 'bodyEnd = lines.length - 2;', 'bodyEnd = state.cursorY + 1;'],
  ["footer folded guard", "utils/paneSend.js", "claudeFolded && field.footer.split", "true && field.footer.split"],
  ["footer wording", "utils/paneSend.js", "field.footer.split('\\n').slice(1).filter(line => line.trim()).join('\\n').trim() === 'paste again to expand'", "true"],
  ["clipped arrow", "utils/paneSend.js", "/^.*↑[ \\t]*(?:\\n|$)/.test(field.text)", "true"],
  ["clipped end", "utils/paneSend.js", "normalizeInput(visibleTail).endsWith(normalizeInput(`--- 依頼本文 ${id} ここまで ---`))", "true"],
  ["clipped tail", "utils/paneSend.js", "normalizeInput(text).endsWith(normalizeInput(visibleTail))", "true"],
  ["accepted empty", "utils/paneSend.js", "currentField.text === ''", "true"],
  ["accepted current", "utils/paneSend.js", "guard.isCurrent(target, currentScreen)", "true"],
  ["fold format", "utils/paneSend.js", "/^\\[Pasted text #\\d+(?: \\+\\d+ lines)?\\]$/.test(field.text.trim())", "true"],
];
async function main() {
  try {
    await new Promise(resolve => setImmediate(resolve));
    const baseline = spawnSync(process.execPath, ['--test', 'tests/paneSend.test.js'], { cwd: temporary, encoding: 'utf8' });
    if (baseline.status !== 0) throw new Error('baseline tests failed');
    console.log('BASELINE PASS');
    let survived = false;
    for (const [name, file, before, after] of mutations) {
      await new Promise(resolve => setImmediate(resolve));
      const target = path.join(temporary, file);
      const original = fs.readFileSync(target, 'utf8');
      if (!original.includes(before)) throw new Error(`mutation missing: ${name}`);
      try {
        fs.writeFileSync(target, original.replace(before, after));
        const syntax = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
        if (syntax.status !== 0) throw new Error(`invalid mutation syntax: ${name}`);
        const run = spawnSync(process.execPath, ['--test', 'tests/paneSend.test.js'], { cwd: temporary, encoding: 'utf8' });
        const detected = run.status !== null && run.status !== 0 && /(?:ℹ fail [1-9]|# fail [1-9])/.test(run.stdout);
        console.log(`${detected ? 'DETECTED' : 'SURVIVED'} ${name}`);
        if (!detected) survived = true;
      } finally { fs.writeFileSync(target, original); }
    }
    process.exitCode = survived ? 1 : 0;
  } finally { cleanup(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
