'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
// 一度に一つだけ安全条件を壊し、終了時は必ず実装を戻す。
const mutations = [
  ['renderer identifier', 'renderer/app.js', 't.screenIdentifier !== expected.screenIdentifier', 'false'],
  ['renderer generation', 'renderer/app.js', 't.screenIdentifierGeneration !== expected.agentGeneration', 'false'],
  ['renderer write queue', 'renderer/app.js', "t.term.write('', () => {", "((_, callback) => callback())('', () => {"],
  ['dim capture', 'renderer/paneSnapshot.js', 'dim: !!cell.isDim()', 'dim: false'],
  ['post-body current', 'utils/paneSend.js', '!guard.isCurrent(target, { agentGeneration: generation, screenIdentifier: echoed.screenIdentifier })', 'false'],
  ['fold number', 'utils/paneSend.js', 'Number(field.text.match(/#(\\d+)/)[1]) > Math.max(0, ...state.lines.flatMap(line => [...line.text.matchAll(/\\[Pasted text #(\\d+)/g)].map(m => Number(m[1]))))', 'true'],
  ['footer change', 'utils/paneSend.js', "(field.footer !== originalField.footer && !(claudeFolded && field.footer.includes('paste again to expand')))", 'false'],
  ['whitespace draft', 'utils/paneSend.js', "if (!text && (state.cursorY > i || state.cursorX > prompt[0].length)) text = ' ';", ''],
  ['start delimiter random ID', 'utils/paneSend.js', '--- 依頼本文 ${id} ---', '--- 依頼本文 ---'],
  ['Codex below cursor', 'utils/paneSend.js', 'bodyEnd = footer >= 0 ? Math.min(footer, lines.length - 2) : lines.length - 2;', 'bodyEnd = state.cursorY + 1;'],
];
const baseline = spawnSync(process.execPath, ['--test', 'tests/paneSend.test.js'], { cwd: root, encoding: 'utf8' });
if (baseline.status !== 0) throw new Error('baseline tests failed');
console.log('BASELINE PASS');
let survived = false;
for (const [name, file, before, after] of mutations) {
  const target = path.join(root, file);
  const original = fs.readFileSync(target, 'utf8');
  if (!original.includes(before)) throw new Error(`mutation missing: ${name}`);
  try {
    fs.writeFileSync(target, original.replace(before, after));
    const syntax = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
    if (syntax.status !== 0) throw new Error(`invalid mutation syntax: ${name}`);
    const run = spawnSync(process.execPath, ['--test', 'tests/paneSend.test.js'], { cwd: root, encoding: 'utf8' });
    const detected = run.status !== null && run.status !== 0 && /(?:ℹ fail [1-9]|# fail [1-9])/.test(run.stdout);
    console.log(`${detected ? 'DETECTED' : 'SURVIVED'} ${name}`);
    if (!detected) survived = true;
  } finally { fs.writeFileSync(target, original); }
}
process.exitCode = survived ? 1 : 0;
