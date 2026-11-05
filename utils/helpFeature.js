'use strict';

const fs = require('fs');
const path = require('path');
const { buildEngineAwareLaunchCommand } = require('../renderer/claudeModel');
const PATTERNS = { claude: /^\/[a-z0-9-]+$/, codex: /^\$[a-z0-9-]+$/ };

function isHelpDocument(file) {
  try {
    return typeof file === 'string' && path.isAbsolute(file) && path.extname(file).toLowerCase() === '.html'
      && fs.statSync(file).isFile() && path.extname(fs.realpathSync(file)).toLowerCase() === '.html';
  } catch (_) { return false; }
}

// 組み込み側の設定だけを取り込み、起動後のオブジェクト変更も切り離す。
function normalizeHelpFeature(help, checker) {
  if (help == null && checker == null) return null;
  if (!help || typeof help !== 'object' || Array.isArray(help) || typeof checker !== 'function') {
    throw new TypeError('embedded options: help and getHelpStatus must be given together');
  }
  if (!isHelpDocument(help.documentPath)) throw new TypeError('help.documentPath must be an existing absolute HTML file');
  if (typeof help.cwd !== 'string' || !path.isAbsolute(help.cwd) || !fs.statSync(help.cwd).isDirectory()) {
    throw new TypeError('help.cwd must be an existing absolute directory');
  }
  const prompts = {};
  for (const engine of ['claude', 'codex']) {
    if (!help.prompts || typeof help.prompts[engine] !== 'string' || (!PATTERNS[engine].test(help.prompts[engine]) || /[\r\n]/.test(help.prompts[engine]))) {
      throw new TypeError(`help.prompts.${engine} is invalid`);
    }
    prompts[engine] = help.prompts[engine];
  }
  if (Object.keys(help.prompts).some((engine) => !Object.hasOwn(PATTERNS, engine))) throw new TypeError('invalid help engine');
  return Object.freeze({ documentPath: fs.realpathSync(help.documentPath), cwd: help.cwd, prompts: Object.freeze(prompts) });
}

function normalizeHelpStatus(value) {
  if (!value || !Array.isArray(value.engines) || value.engines.length !== 2) throw new TypeError('invalid help status');
  const seen = new Set();
  const engines = value.engines.map((item) => {
    if (!item || typeof item.engine !== 'string' || !Object.hasOwn(PATTERNS, item.engine) || seen.has(item.engine)
      || !['available', 'unavailable', 'unknown'].includes(item.state)) throw new TypeError('invalid help engine status');
    seen.add(item.engine);
    const text = (key) => {
      const result = item[key] === undefined ? '' : item[key];
      if (typeof result !== 'string' || result.length > 2000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(result)) throw new TypeError('invalid help status text');
      return result;
    };
    const reason = text('reason');
    const preparation = text('preparation');
    if (item.state === 'unavailable' && (!reason.trim() || !preparation.trim())) throw new TypeError('missing preparation');
    return { engine: item.engine, state: item.state, reason, preparation };
  });
  const engine = value.engine;
  if (engine !== null && (typeof engine !== 'string' || !Object.hasOwn(PATTERNS, engine) || !engines.some((item) => item.engine === engine && item.state === 'available'))) {
    throw new TypeError('invalid selected help engine');
  }
  if (engine === null && engines.some((item) => item.state === 'available')) throw new TypeError('missing selected help engine');
  return { engine, engines };
}

function buildHelpLaunchCommand(engine, prompt) {
  if (typeof engine !== 'string' || !Object.hasOwn(PATTERNS, engine) || typeof prompt !== 'string' || (!PATTERNS[engine].test(prompt) || /[\r\n]/.test(prompt))) throw new TypeError('invalid help launch');
  // 単一引用符で Codex の $ をシェルの変数展開から守る。
  return `${buildEngineAwareLaunchCommand(engine).command} '${prompt}'`;
}

// 確認の多重実行を防ぎ、応答しない関数でも画面へ再確認の操作を返す。
function createHelpStatusChecker(getHelpStatus, timeoutMs = 20000) {
  let pending = null;
  let underlyingPending = false;
  return function check() {
    if (pending) return pending;
    const controller = new AbortController();
    let timer;
    const unknown = () => ({ engine: null, engines: ['claude', 'codex'].map((engine) => ({ engine, state: 'unknown', reason: '', preparation: '「再確認」を押してください。' })) });
    if (underlyingPending) return Promise.resolve(unknown());
    underlyingPending = true;
    const call = Promise.resolve().then(() => getHelpStatus({ signal: controller.signal }));
    call.then(() => { underlyingPending = false; }, () => { underlyingPending = false; });
    pending = Promise.race([
      call.then(normalizeHelpStatus).catch(unknown),
      new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(unknown()); }, timeoutMs); }),
    ]).finally(() => { clearTimeout(timer); pending = null; });
    return pending;
  };
}

// ガイドの識別はプロセス内だけで保持し、終了したペインは操作時にだけ作り直す。
function createGuideOpener({ enabled, check, create, isAlive }) {
  let terminal = null;
  let opening = null;
  return function open() {
    if (!enabled) return Promise.reject(new Error('Help is unavailable.'));
    if (terminal && isAlive(terminal.id)) return Promise.resolve(terminal);
    if (opening) return opening;
    opening = (async () => {
      const status = await check();
      if (!status.engine) throw new Error('Guide engine is unavailable.');
      terminal = await create(status.engine);
      return terminal;
    })().finally(() => { opening = null; });
    return opening;
  };
}

module.exports = { createGuideOpener, isHelpDocument, normalizeHelpFeature, normalizeHelpStatus, buildHelpLaunchCommand, createHelpStatusChecker };
