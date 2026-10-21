'use strict';
// セットアップ状況の一覧（issue #456）の正規化と並びの組み替え。
// doctor の結果は外から来た値として扱うため、形の検証・切り詰め・コマンド欄の扱いを固定する。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LIMITS,
  SETUP_TEXT,
  normalizeSetupStatus,
  buildSetupViewModel,
  formatCheckedTime,
  unavailableReasonText,
} = require('../utils/setupStatus');

function row(overrides = {}) {
  return {
    id: 'node',
    group: 'tools',
    label: 'Node.js',
    required: true,
    ok: true,
    current: 'v22',
    hint: 'Node.js を入れてください',
    target: 'external',
    ...overrides,
  };
}

function status(requirements, allRequiredOk) {
  const missing = requirements.filter((r) => r.required && !r.ok);
  return {
    requirements,
    summary: {
      total: requirements.length,
      okCount: requirements.filter((r) => r.ok).length,
      requiredCount: requirements.filter((r) => r.required).length,
      requiredOkCount: requirements.filter((r) => r.required && r.ok).length,
      missingRequired: missing.map((r) => r.id),
      allRequiredOk: allRequiredOk === undefined ? missing.length === 0 : allRequiredOk,
    },
  };
}

test('normalizeSetupStatus: 正しい形を受け取り、必要な欄だけを残す', () => {
  const result = normalizeSetupStatus(status([row(), row({ id: 'gh-auth', label: 'GitHub CLI', ok: false, target: 'A' })]));
  assert.equal(result.ok, true);
  assert.equal(result.status.requirements.length, 2);
  assert.equal(result.status.requirements[0].target, 'external');
  // external 以外の target（A / B / C / manifest）は「セットアップで設定するもの」に寄せる。
  assert.equal(result.status.requirements[1].target, 'setup');
  assert.equal(result.status.summary.allRequiredOk, false);
});

test('normalizeSetupStatus: 形が不正なものは ok:false（セットアップ済みには倒さない）', () => {
  const invalidInputs = [
    null,
    undefined,
    'text',
    [],
    {},
    { requirements: [] },
    { requirements: {}, summary: { allRequiredOk: true } },
    { requirements: [], summary: {} },
    { requirements: [], summary: { allRequiredOk: 'yes' } },
    { requirements: [null], summary: { allRequiredOk: true } },
    { requirements: [row({ id: '' })], summary: { allRequiredOk: true } },
    { requirements: [row({ label: 3 })], summary: { allRequiredOk: true } },
    { requirements: [row({ ok: 'true' })], summary: { allRequiredOk: true } },
  ];
  invalidInputs.forEach((input) => {
    assert.equal(normalizeSetupStatus(input).ok, false, JSON.stringify(input));
  });
});

test('normalizeSetupStatus: summary と項目が食い違うときは確認できなかった扱い', () => {
  // 必須が欠けているのに allRequiredOk:true
  assert.equal(normalizeSetupStatus(status([row({ ok: false })], true)).ok, false);
  // 必須がそろっているのに allRequiredOk:false
  assert.equal(normalizeSetupStatus(status([row({ ok: true })], false)).ok, false);
});

test('normalizeSetupStatus: 項目数を上限で切り詰める（切り詰めたときは件数の照合をしない）', () => {
  const many = Array.from({ length: LIMITS.requirements + 10 }, (_v, i) => row({ id: `r${i}`, label: `R${i}`, required: false }));
  const result = normalizeSetupStatus(status(many, false));
  assert.equal(result.ok, true);
  assert.equal(result.status.requirements.length, LIMITS.requirements);
});

test('normalizeSetupStatus: 文字数を切り詰め、制御文字は空白にまとめる', () => {
  const result = normalizeSetupStatus(status([
    row({ label: 'あ'.repeat(LIMITS.label + 50), hint: 'a\n\u001b[31mb', current: 'x'.repeat(LIMITS.current + 5) }),
  ]));
  const item = result.status.requirements[0];
  assert.equal(item.label.length, LIMITS.label);
  assert.ok(item.label.endsWith('…'));
  assert.equal(item.hint, 'a [31mb');
  assert.equal(item.current.length, LIMITS.current);
});

test('normalizeSetupStatus: HTML らしい文字列も、加工せずそのままの文字列として持つ（描画側は textContent だけを使う）', () => {
  const result = normalizeSetupStatus(status([row({ label: '<img src=x onerror=alert(1)>' })]));
  assert.equal(result.status.requirements[0].label, '<img src=x onerror=alert(1)>');
});

test('normalizeSetupStatus: commands 欄が無いときは空配列（hint からコマンドを抜き出さない）', () => {
  const result = normalizeSetupStatus(status([row({ ok: false, hint: '`npm install -g @anthropic-ai/claude-code` を実行' })]));
  assert.deepEqual(result.status.requirements[0].commands, []);
});

test('normalizeSetupStatus: commands 欄は { command, os } の形だけを残し、危ないものは欄ごと捨てる', () => {
  const longCommand = 'a'.repeat(LIMITS.command + 1);
  const result = normalizeSetupStatus(status([
    row({
      ok: false,
      commands: [
        { command: 'brew install gh', os: 'macOS' },
        { command: 'line1\nline2', os: 'Linux' },
        { command: longCommand, os: 'Linux' },
        { command: 42, os: 'Linux' },
        null,
        { command: '  gh --version  ' },
        { command: 'fourth ok but over the per-item cap' },
      ],
    }),
  ]));
  assert.deepEqual(result.status.requirements[0].commands, [
    { command: 'brew install gh', os: 'macOS' },
    { command: 'gh --version', os: '' },
    { command: 'fourth ok but over the per-item cap', os: '' },
  ]);
});

test('normalizeSetupStatus: commands が配列でないときは空配列', () => {
  const result = normalizeSetupStatus(status([row({ commands: 'brew install gh' })]));
  assert.deepEqual(result.status.requirements[0].commands, []);
});

test('normalizeSetupStatus: reason は既知の値だけを残す', () => {
  const result = normalizeSetupStatus(status([
    row({ id: 'a', label: 'A', reason: 'not-installed' }),
    row({ id: 'b', label: 'B', reason: 'not-on-path' }),
    row({ id: 'c', label: 'C', reason: 'not-authenticated' }),
    row({ id: 'd', label: 'D', reason: 'something-else' }),
    row({ id: 'e', label: 'E' }),
  ]));
  assert.deepEqual(result.status.requirements.map((r) => r.reason), ['not-installed', 'not-on-path', 'not-authenticated', null, null]);
});

test('buildSetupViewModel: 「自分で入れるもの」を先、「セットアップで設定するもの」を後にし、必須と任意を分ける', () => {
  const normalized = normalizeSetupStatus(status([
    row({ id: 'setup-req', label: 'S1', ok: false, target: 'A' }),
    row({ id: 'ext-opt', label: 'E2', required: false, ok: false }),
    row({ id: 'ext-req', label: 'E1', ok: false }),
    row({ id: 'ext-done', label: 'E3', ok: true }),
  ]));
  const vm = buildSetupViewModel(normalized.status);
  assert.deepEqual(vm.groups.map((g) => g.key), ['external', 'setup']);
  assert.deepEqual(vm.groups[0].required.pending.map((r) => r.id), ['ext-req']);
  assert.deepEqual(vm.groups[0].required.satisfied.map((r) => r.id), ['ext-done']);
  assert.deepEqual(vm.groups[0].optional.pending.map((r) => r.id), ['ext-opt']);
  assert.deepEqual(vm.groups[1].required.pending.map((r) => r.id), ['setup-req']);
  assert.equal(vm.remaining, 2);
  assert.equal(vm.allRequiredOk, false);
});

test('buildSetupViewModel: Claude Code の行が未充足なら「自分で入れるもの」の必須の先頭に置き、まずここから印を付ける', () => {
  const normalized = normalizeSetupStatus(status([
    row({ id: 'gh-auth', label: 'gh', ok: false }),
    row({ id: 'claude', label: 'Claude Code', ok: false }),
  ]));
  const vm = buildSetupViewModel(normalized.status);
  const pending = vm.groups[0].required.pending;
  assert.deepEqual(pending.map((r) => r.id), ['claude', 'gh-auth']);
  assert.equal(pending[0].isFirstStep, true);
  assert.equal(pending[1].isFirstStep, false);
  assert.equal(vm.claudeOk, false);
});

test('buildSetupViewModel: claudeOk は claude の行が ok のときだけ true（行が無いときは false）', () => {
  const ok = normalizeSetupStatus(status([row({ id: 'claude', label: 'Claude Code', ok: true })]));
  assert.equal(buildSetupViewModel(ok.status).claudeOk, true);
  const missingRow = normalizeSetupStatus(status([row({ id: 'node', ok: true })]));
  assert.equal(buildSetupViewModel(missingRow.status).claudeOk, false);
});

test('buildSetupViewModel: 理由欄が無い行は状態の文言を出さない。あれば対応する文言を出す', () => {
  const normalized = normalizeSetupStatus(status([
    row({ id: 'claude', label: 'Claude Code', ok: false, reason: 'not-on-path' }),
    row({ id: 'gh-auth', label: 'gh', ok: false }),
  ]));
  const [claude, gh] = buildSetupViewModel(normalized.status).groups[0].required.pending;
  assert.equal(claude.stateText, SETUP_TEXT.stateNotOnPath);
  assert.equal(claude.showNotOnPathNote, true);
  assert.equal(gh.stateText, '');
  assert.equal(gh.showNotOnPathNote, false);
});

test('buildSetupViewModel: 「セットアップで設定するもの」は hint を既定では出さず「詳しく」に畳む。「自分で入れるもの」は hint をそのまま出す', () => {
  const normalized = normalizeSetupStatus(status([
    row({ id: 'ext', label: 'E', ok: false, hint: 'ext hint' }),
    row({ id: 'cfg', label: 'C', ok: false, target: 'B', hint: 'config.yml の x を書き換える' }),
  ]));
  const vm = buildSetupViewModel(normalized.status);
  const ext = vm.groups[0].required.pending[0];
  const cfg = vm.groups[1].required.pending[0];
  assert.equal(ext.hint, 'ext hint');
  assert.equal(ext.detailHint, '');
  assert.equal(ext.useSetupHint, false);
  assert.equal(cfg.hint, '');
  assert.equal(cfg.detailHint, 'config.yml の x を書き換える');
  assert.equal(cfg.useSetupHint, true);
});

test('buildSetupViewModel: コマンド欄があればそのまま渡し、無ければ空', () => {
  const normalized = normalizeSetupStatus(status([
    row({ id: 'a', label: 'A', ok: false, commands: [{ command: 'brew install a', os: 'macOS' }] }),
    row({ id: 'b', label: 'B', ok: false }),
  ]));
  const [a, b] = buildSetupViewModel(normalized.status).groups[0].required.pending;
  assert.deepEqual(a.commands, [{ command: 'brew install a', os: 'macOS' }]);
  assert.deepEqual(b.commands, []);
});

test('buildSetupViewModel: セットアップ済み（必須がすべて充足）なら remaining は 0 で allRequiredOk は true', () => {
  const normalized = normalizeSetupStatus(status([row({ id: 'claude', label: 'Claude Code' })]));
  const vm = buildSetupViewModel(normalized.status);
  assert.equal(vm.remaining, 0);
  assert.equal(vm.allRequiredOk, true);
  assert.equal(vm.groups[0].required.pending.length, 0);
  assert.equal(vm.groups[0].required.satisfied.length, 1);
});

test('formatCheckedTime: HH:MM のゼロ埋め', () => {
  assert.equal(formatCheckedTime(new Date(2026, 9, 21, 9, 5).getTime()), '09:05');
  assert.equal(formatCheckedTime(Number.NaN), '');
});

test('unavailableReasonText: 時間切れは秒数つき、それ以外は起動できなかった旨', () => {
  assert.equal(unavailableReasonText({ reason: 'timeout', timeoutSeconds: 20 }), '確認に 20 秒以上かかったため、途中で止めました。');
  assert.equal(unavailableReasonText({ reason: 'error' }), '確認用のプログラムを起動できませんでした。');
  assert.equal(unavailableReasonText({ reason: 'invalid' }), SETUP_TEXT.unavailableInvalid);
});
