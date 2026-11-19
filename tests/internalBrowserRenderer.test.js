'use strict';
const { installBrowserLoad, flushBrowserLoads } = require('./helpers/browserLoad');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createInternalBrowser } = require('../utils/internalBrowser');
const { INTERNAL_BROWSER_HOME_KEY } = require('../utils/internalBrowserHome');
const { saveSettingsToTargets } = require('../settingsTargets');

function createSettingsSaveHarness(initialValues, save, labels = {}, isInvalid = () => false) {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const saveFunctions = source.match(/  const getChangedSettingValues = [\s\S]*?(?=\n  modal.querySelector\('\.settings-save'\)\.addEventListener)/)?.[0];
  const clearStaleMessage = source.match(/  const clearStaleSettingsMessage = [\s\S]*?\n  };/)?.[0];
  assert.ok(saveFunctions && clearStaleMessage);
  const savedFieldValues = { ...initialValues };
  const values = { ...savedFieldValues };
  const payloads = [];
  const notices = [];
  const refreshes = [];
  const msg = {};
  const autoCloses = [];
  const dirtyValues = {};
  const entries = Object.keys(values).map(key => ({ field: { key, label: labels[key] }, id: key }));
  const context = vm.createContext({
    INTERNAL_BROWSER_HOME_KEY, savedFieldValues, values,
    internalBrowserOpen: true, focusFieldKey: INTERNAL_BROWSER_HOME_KEY,
    settingsInteractionRevision: 0, settingsChangesRevision: 0, latestSettingsSave: null,
    isHelpTabHidden: () => false,
    entries,
    getCurrentSettingValues: () => ({ ...values }),
    validatable: entries, isInvalidVisibleEntry: ({ field }) => isInvalid(field.key, values[field.key]),
    applyFieldValidity: field => !isInvalid(field.key, values[field.key]),
    getEntryInput: () => ({ focus() {} }), switchToFieldTab() {},
    configFailedFiles: [], restoredHomeButton: null,
    msg,
    autoClose: { cancel() {}, arm() { autoCloses.push(true); } },
    VKIpc: { async invoke(channel, payload) {
      assert.equal(channel, 'settings:save');
      payloads.push({ ...payload });
      return save(payload);
    } },
    setInternalBrowserHomeNotice: visible => notices.push(visible),
    lockSettingsFooter() {},
    syncDirtyTabs(changes) {
      for (const key of Object.keys(dirtyValues)) delete dirtyValues[key];
      Object.assign(dirtyValues, changes);
    },
    refreshSettingsContentSavedValues() { refreshes.push('saved-values'); },
    refreshConfigReflection() { refreshes.push('reflection'); },
  });
  const { saveSettings, edit } = vm.runInContext(`
    ${saveFunctions}
    ${clearStaleMessage}
    ({ saveSettings, edit(key, value) {
      values[key] = value;
      settingsInteractionRevision++;
      settingsChangesRevision++;
      clearStaleSettingsMessage();
    } })
  `, context);
  return { saveSettings, edit, savedFieldValues, values, payloads, notices, refreshes, msg, autoCloses, dirtyValues, context };
}

test('ホームだけの保存と変更のない再保存では外部設定を送信しない', async () => {
  const legacyOwners = '\n  \nfirst-owner\nsecond-owner';
  const homeOnly = { ok: true, writtenKeys: [INTERNAL_BROWSER_HOME_KEY], hasInternalBrowserHome: true };
  const replies = [
    { ok: false, writtenKeys: [], hasInternalBrowserHome: false, error: '保存に失敗しました' },
    homeOnly,
    { ok: true, writtenKeys: [], hasInternalBrowserHome: true },
    homeOnly,
    { ok: true, writtenKeys: ['github.owner'], hasInternalBrowserHome: true },
    { ok: true, writtenKeys: ['github.owner', INTERNAL_BROWSER_HOME_KEY], hasInternalBrowserHome: true },
  ];
  const { saveSettings, values, payloads, notices, msg } = createSettingsSaveHarness(
    { [INTERNAL_BROWSER_HOME_KEY]: '', 'github.owner': legacyOwners },
    () => replies.shift(),
  );

  // 保存失敗では案内を残し、再試行で成功したら消す。
  const url = 'https://example.com/home';
  values[INTERNAL_BROWSER_HOME_KEY] = url;
  assert.equal(await saveSettings(), false);
  assert.deepEqual(notices, [true]);
  assert.equal(msg.textContent, 'エラー: 保存に失敗しました');
  assert.equal(await saveSettings(), true);
  assert.deepEqual(notices, [true, false]);
  assert.equal(msg.textContent, '保存しました。反映状況は設定の案内をご確認ください。');
  assert.equal(await saveSettings(), true);

  // 空欄へ戻すときも外部を送らず、外部を編集したときは従来の保存経路を使う。
  values[INTERNAL_BROWSER_HOME_KEY] = '';
  assert.equal(await saveSettings(), true);
  values['github.owner'] = 'external-only';
  assert.equal(await saveSettings(), true);
  values['github.owner'] = 'both';
  values[INTERNAL_BROWSER_HOME_KEY] = url;
  assert.equal(await saveSettings(), true);
  assert.deepEqual(payloads, [
    { [INTERNAL_BROWSER_HOME_KEY]: url },
    { [INTERNAL_BROWSER_HOME_KEY]: url },
    {},
    { [INTERNAL_BROWSER_HOME_KEY]: '' },
    { 'github.owner': 'external-only' },
    { 'github.owner': 'both', [INTERNAL_BROWSER_HOME_KEY]: url },
  ]);
  assert.deepEqual(notices, [true, false, false, false, false, false]);
});

test('ホームだけが部分成功したとき、元の空欄を保存し直して外部の失敗分も再試行できる', async () => {
  const homeKey = INTERNAL_BROWSER_HOME_KEY;
  const replies = [
    { ok: false, writtenKeys: [homeKey], hasInternalBrowserHome: true },
    { ok: false, writtenKeys: [homeKey], hasInternalBrowserHome: false },
    { ok: true, writtenKeys: ['github.owner'], hasInternalBrowserHome: true },
  ];
  const { saveSettings, savedFieldValues, values, payloads, notices, refreshes, msg } = createSettingsSaveHarness(
    { [homeKey]: '', 'github.owner': '' },
    () => replies.shift(),
    { [homeKey]: 'ホームページ URL', 'github.owner': '作業対象リポジトリのオーナー' },
  );

  const url = 'https://example.com/';
  values[homeKey] = url;
  values['github.owner'] = 'first-owner';
  assert.equal(await saveSettings(), false);
  assert.deepEqual(savedFieldValues, { [homeKey]: url, 'github.owner': '' });
  assert.deepEqual(notices, [false]);
  assert.deepEqual(refreshes, ['saved-values', 'reflection']);
  assert.equal(msg.textContent, '「ホームページ URL」を保存しました。「作業対象リポジトリのオーナー」は再保存してください。');

  values[homeKey] = '';
  assert.equal(await saveSettings(), false);
  assert.deepEqual(savedFieldValues, { [homeKey]: '', 'github.owner': '' });
  assert.equal(await saveSettings(), true);
  assert.deepEqual(payloads, [
    { [homeKey]: url, 'github.owner': 'first-owner' },
    { [homeKey]: '', 'github.owner': 'first-owner' },
    { 'github.owner': 'first-owner' },
  ]);
  assert.deepEqual(notices, [false, true, false]);
});

for (const closeWhileWaiting of [false, true]) {
  test(`応答待ちに空欄の保存を予約すると、先行保存後に空欄がディスクに残る（${closeWhileWaiting ? '閉じる' : '開いたまま'}）`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-settings-save-queue-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const targetPath = path.join(dir, 'config.json');
    const key = INTERNAL_BROWSER_HOME_KEY;
    const descriptor = { targetPath, groups: [{ fields: [{ key, type: 'http-url' }] }] };
    const firstWrite = Promise.withResolvers();
    const releaseReply = Promise.withResolvers();
    const { saveSettings, values, payloads, autoCloses, context, msg } = createSettingsSaveHarness({ [key]: '' }, async payload => {
      const result = saveSettingsToTargets(descriptor, payload);
      if (payload[key]) {
        firstWrite.resolve();
        await releaseReply.promise;
      }
      return result;
    });

    values[key] = 'https://example.com/';
    const firstSave = saveSettings();
    await firstWrite.promise;
    assert.equal(JSON.parse(fs.readFileSync(targetPath))[key], values[key]);
    values[key] = '';
    const secondSave = saveSettings();
    await Promise.resolve();
    assert.deepEqual(payloads, [{ [key]: 'https://example.com/' }]);
    if (closeWhileWaiting) context.autoClose.isClosed = true;
    releaseReply.resolve();
    assert.deepEqual(await Promise.all([firstSave, secondSave]), [true, true]);
    assert.deepEqual(payloads, [{ [key]: 'https://example.com/' }, { [key]: '' }]);
    assert.equal(JSON.parse(fs.readFileSync(targetPath))[key], '');
    assert.equal(autoCloses.length, closeWhileWaiting ? 0 : 1);
    if (closeWhileWaiting) assert.equal(msg.textContent, '保存中...');
  });
}

test('A の応答待ちに B を保存してから C へ編集すると、B を保存し C は未保存で残す', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-settings-save-snapshot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const targetPath = path.join(dir, 'config.json');
  const key = INTERNAL_BROWSER_HOME_KEY;
  const descriptor = { targetPath, groups: [{ fields: [{ key, type: 'http-url' }] }] };
  const [a, b, c] = ['a', 'b', 'c'].map(value => `https://example.com/${value}`);
  const firstWrite = Promise.withResolvers();
  const releaseReply = Promise.withResolvers();
  const { saveSettings, edit, values, dirtyValues, payloads, autoCloses } = createSettingsSaveHarness(
    { [key]: '' }, async payload => {
      const result = saveSettingsToTargets(descriptor, payload);
      if (payload[key] === a) {
        firstWrite.resolve();
        await releaseReply.promise;
      }
      return result;
    },
  );

  edit(key, a);
  const first = saveSettings();
  await firstWrite.promise;
  edit(key, b);
  const second = saveSettings();
  edit(key, c);
  releaseReply.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(payloads, [{ [key]: a }, { [key]: b }]);
  assert.equal(JSON.parse(fs.readFileSync(targetPath))[key], b);
  assert.equal(values[key], c);
  assert.deepEqual(dirtyValues, { [key]: c });
  assert.equal(autoCloses.length, 0);
});

test('保存して開くは応答待ちの追加編集を保存するまで進めない', async () => {
  const requested = Promise.withResolvers();
  const response = Promise.withResolvers();
  const { saveSettings, edit, dirtyValues, msg, autoCloses } = createSettingsSaveHarness(
    { label: 'old' }, async payload => {
      requested.resolve();
      await response.promise;
      return { ok: true, writtenKeys: Object.keys(payload) };
    },
  );
  edit('label', 'booked');
  const first = saveSettings({ keepOpen: true });
  await requested.promise;
  edit('label', 'extra');
  response.resolve();
  assert.equal(await first, 'interrupted');
  assert.match(msg.textContent, /追加の編集が保存されていません。もう一度保存してください。/);
  assert.deepEqual(dirtyValues, { label: 'extra' });
  assert.equal(await saveSettings({ keepOpen: true }), true);
  assert.deepEqual(dirtyValues, {});
  assert.equal(autoCloses.length, 0);
});

test('保存して開くは先行応答で dirty が消えても後続予約を待って現在値を再判定する', async () => {
  const requests = [Promise.withResolvers(), Promise.withResolvers()];
  const replies = [Promise.withResolvers(), Promise.withResolvers()];
  let index = 0;
  const { saveSettings, edit, payloads, dirtyValues, msg, autoCloses } = createSettingsSaveHarness(
    { label: 'old' }, async payload => {
      const current = index++;
      requests[current].resolve();
      await replies[current].promise;
      return { ok: true, writtenKeys: Object.keys(payload) };
    },
  );

  edit('label', 'a');
  let helpReady = false;
  const first = saveSettings({ keepOpen: true }).then(result => { helpReady = true; return result; });
  await requests[0].promise;
  edit('label', 'b');
  const second = saveSettings();
  edit('label', 'a');
  replies[0].resolve();
  await requests[1].promise;
  assert.deepEqual(dirtyValues, {});
  assert.equal(helpReady, false);

  replies[1].resolve();
  assert.deepEqual(await Promise.all([first, second]), ['interrupted', true]);
  assert.deepEqual(payloads, [{ label: 'a' }, { label: 'b' }]);
  assert.deepEqual(dirtyValues, { label: 'a' });
  assert.match(msg.textContent, /追加の編集が保存されていません/);
  assert.equal(autoCloses.length, 0);
});

test('設定切替で表示された不正な既存値も差分なしで検証する', async () => {
  const focused = [];
  const { saveSettings, edit, payloads, msg, context } = createSettingsSaveHarness(
    { initialEngine: 'claude', initialCodexModel: 'invalid model' },
    payload => ({ ok: true, writtenKeys: Object.keys(payload) }),
  );
  context.isInvalidVisibleEntry = ({ field }) => field.key === 'initialCodexModel'
    && context.values.initialEngine === 'codex' && context.values.initialCodexModel === 'invalid model';
  context.applyFieldValidity = field => !context.isInvalidVisibleEntry({ field });
  context.getEntryInput = id => ({ focus() { focused.push(id); } });

  edit('initialEngine', 'codex');
  assert.equal(await saveSettings({ keepOpen: true }), 'invalid');
  assert.deepEqual(focused, ['initialCodexModel']);
  assert.deepEqual(payloads, []);
  assert.equal(msg.textContent, '入力内容に問題があります');

  // 非表示に戻せば、不正なモデルを再送せずに保存できる。
  edit('initialEngine', 'claude');
  assert.equal(await saveSettings(), true);
  assert.deepEqual(payloads, [{}]);
});

function loadHelpFlow(context, container) {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const helpLaunch = source.match(/  const launchHelpGuide = [\s\S]*?(?=\n  const helpView =)/)?.[0];
  assert.ok(helpLaunch);
  context.modal = { querySelector: () => container };
  return vm.runInContext(`${helpLaunch}\n({ launchHelpGuide, launchHelpDocument, confirmUnsavedHelp })`, context);
}

test('ガイドとドキュメントは起動が完了しても応答待ち中に編集された設定を閉じない', async () => {
  for (const target of ['Guide', 'Document']) {
    const launched = Promise.withResolvers();
    const response = Promise.withResolvers();
    const { edit, saveSettings, values, context, msg, autoCloses } = createSettingsSaveHarness(
      { label: 'old' }, payload => ({ ok: true, writtenKeys: Object.keys(payload) }),
    );
    let closed = 0;
    const launch = () => {
      launched.resolve();
      return response.promise;
    };
    const invoke = context.VKIpc.invoke;
    Object.assign(context, {
      close() { closed++; },
      internalBrowserHasPage: false,
      openHelpGuide: launch,
    });
    context.VKIpc.invoke = (channel, payload) => channel === 'help:document' ? launch() : invoke(channel, payload);
    const { launchHelpGuide, launchHelpDocument, confirmUnsavedHelp } = loadHelpFlow(
      context, { closest: () => ({ hidden: false }) },
    );
    edit('label', 'saved');
    assert.equal(await saveSettings({ keepOpen: true }), true);

    const opening = confirmUnsavedHelp(target === 'Guide' ? launchHelpGuide : launchHelpDocument, () => {});
    await launched.promise;
    edit('label', 'extra');
    response.resolve(target === 'Guide' ? 'pane-1' : true);
    await opening;
    assert.equal(closed, 0);
    assert.equal(values.label, 'extra');
    assert.equal(autoCloses.length, 0);
    assert.match(msg.textContent, /追加の編集が保存されていません/);
  }
});

function loadHelpConfirmation(context) {
  let confirmation;
  context.document = { createElement() {
    return {
      children: [],
      appendChild(child) { this.children.push(child); },
      querySelector() { return this.children.find(child => child.type === 'button'); },
      addEventListener(_event, action) { this.click = action; },
      setAttribute() {}, focus() {}, remove() {},
    };
  } };
  const flow = loadHelpFlow(context, {
    closest: () => ({ hidden: false }),
    appendChild(group) { confirmation = group; },
  });
  return { ...flow, discard: () => confirmation.children.find(child => child.textContent === '破棄して開く').click() };
}

test('破棄同意の後で B を保存して A に戻した場合は設定を閉じない', async () => {
  const launched = Promise.withResolvers();
  const response = Promise.withResolvers();
  const { context, edit, saveSettings, savedFieldValues, values, msg } = createSettingsSaveHarness(
    { label: 'old' }, payload => ({ ok: true, writtenKeys: Object.keys(payload) }),
  );
  const { confirmUnsavedHelp, discard } = loadHelpConfirmation(context);
  const launch = async (_onLaunching, canCloseSettings) => {
    launched.resolve();
    await response.promise;
    return canCloseSettings();
  };

  edit('label', 'a');
  const opening = confirmUnsavedHelp(launch, () => {});
  discard();
  await launched.promise;
  edit('label', 'b');
  assert.equal(await saveSettings(), true);
  edit('label', 'a');
  response.resolve();
  assert.equal(await opening, false);
  assert.equal(savedFieldValues.label, 'b');
  assert.equal(values.label, 'a');
  assert.match(msg.textContent, /追加の編集が保存されていません/);
});

test('破棄を選んでもフッターの全保存を待ち、比較元の更新後に残った変更を保持する', async () => {
  const requests = [Promise.withResolvers(), Promise.withResolvers()];
  const replies = [Promise.withResolvers(), Promise.withResolvers()];
  let requestCount = 0;
  const { context, edit, saveSettings, savedFieldValues, msg } = createSettingsSaveHarness(
    { label: 'old' }, async payload => {
      const index = requestCount++;
      requests[index].resolve();
      await replies[index].promise;
      return { ok: true, writtenKeys: Object.keys(payload) };
    },
  );
  const { confirmUnsavedHelp, discard } = loadHelpConfirmation(context);
  edit('label', 'a');
  let finished = false;
  const opening = confirmUnsavedHelp(() => assert.fail('再確認前にヘルプを起動した'), () => {})
    .then(result => { finished = true; return result; });
  const first = saveSettings();
  await requests[0].promise;
  edit('label', 'b');
  const second = saveSettings();
  edit('label', 'a');
  discard();
  replies[0].resolve();
  await requests[1].promise;
  assert.equal(savedFieldValues.label, 'a');
  assert.equal(finished, false);
  replies[1].resolve();
  assert.deepEqual(await Promise.all([first, second, opening]), [true, true, 'interrupted']);
  assert.equal(savedFieldValues.label, 'b');
  assert.match(msg.textContent, /追加の編集が保存されていません/);
});

test('ヘルプの保存待ちに別タブへ移った場合はフッターで開き直しを案内する', async () => {
  const requested = Promise.withResolvers();
  const reply = Promise.withResolvers();
  const { context, edit, saveSettings, values, msg } = createSettingsSaveHarness(
    { label: 'old' }, async payload => {
      requested.resolve();
      await reply.promise;
      return { ok: true, writtenKeys: Object.keys(payload) };
    },
  );
  const panel = { hidden: false };
  const { confirmUnsavedHelp } = loadHelpFlow(context, {
    closest: () => panel,
    appendChild() { assert.fail('非表示のタブに確認を追加した'); },
  });
  edit('label', 'a');
  const saving = saveSettings();
  await requested.promise;
  const opening = confirmUnsavedHelp(() => assert.fail('保存待ちのヘルプを起動した'), () => {});
  panel.hidden = true;
  edit('label', 'b');
  reply.resolve();
  assert.equal(await saving, true);
  assert.equal(await opening, 'interrupted');
  assert.equal(values.label, 'b');
  assert.equal(msg.textContent, '設定を保存してから、使い方・ヘルプで開き直してください。');
});

test('部分成功の通知は編集・形式エラー・応答待ちを経ても残り、後続の保存結果で更新する', async () => {
  const retryStarted = Promise.withResolvers();
  const retryResult = Promise.withResolvers();
  const replies = [
    { ok: false, writtenKeys: ['first'] },
    retryResult.promise,
    { ok: false, writtenKeys: [], error: '書き込めません' },
    { ok: false, writtenKeys: ['second'] },
    { ok: true, writtenKeys: ['first'] },
  ];
  const { saveSettings, edit, msg, payloads } = createSettingsSaveHarness(
    { first: '', second: '', third: '' },
    () => {
      const reply = replies.shift();
      if (reply === retryResult.promise) retryStarted.resolve();
      return reply;
    },
    { first: '最初の項目', second: '2番目の項目', third: '3番目の項目' },
    (_key, value) => value === 'invalid',
  );

  edit('first', 'a');
  edit('second', 'b');
  edit('third', 'c');
  assert.equal(await saveSettings(), false);
  const firstPartial = '「最初の項目」を保存しました。「2番目の項目、3番目の項目」は再保存してください。';
  assert.equal(msg.textContent, firstPartial);
  edit('second', 'invalid');
  assert.equal(msg.textContent, firstPartial);
  assert.equal(await saveSettings(), false);
  assert.equal(payloads.length, 1);
  assert.equal(msg.textContent, firstPartial + ' 入力内容に問題があります');
  edit('second', 'valid');
  assert.equal(msg.textContent, firstPartial);

  const retry = saveSettings();
  await retryStarted.promise;
  assert.equal(msg.textContent, firstPartial);
  retryResult.resolve({ ok: false, writtenKeys: ['third'] });
  assert.equal(await retry, false);
  assert.equal(msg.textContent, '「3番目の項目」を保存しました。「2番目の項目」は再保存してください。');
  assert.equal(await saveSettings(), false);
  assert.equal(msg.textContent, 'エラー: 書き込めません');
  edit('first', 'updated');
  assert.equal(await saveSettings(), false);
  assert.match(msg.textContent, /「2番目の項目」を保存しました/);
  assert.equal(await saveSettings(), true);
  assert.match(msg.textContent, /^保存しました。/);
});

test('変更なしの保存成功でも表の保存済み値と設定反映状態を取り直す', async () => {
  const { saveSettings, payloads, refreshes } = createSettingsSaveHarness(
    { first: 'original' }, () => ({ ok: true, writtenKeys: [] }),
  );
  assert.equal(await saveSettings(), true);
  assert.deepEqual(payloads, [{}]);
  assert.deepEqual(refreshes, ['saved-values', 'reflection']);
});

test('閉じた後に案内を再表示し、ホームに残っているフォーカスだけを案内へ移す', async () => {
  const key = INTERNAL_BROWSER_HOME_KEY;
  for (const moveFocus of [false, true]) {
    const requested = Promise.withResolvers();
    const response = Promise.withResolvers();
    const { saveSettings, values, notices, context } = createSettingsSaveHarness(
      { [key]: 'https://example.com/', owner: '' }, () => {
        requested.resolve();
        return response.promise;
      },
    );
    const home = {};
    const address = {};
    const document = { activeElement: home };
    const configure = { focus() { document.activeElement = this; } };
    context.document = document;
    context.internalBrowserSidebar = { querySelector(selector) {
      assert.equal(selector, '[data-action="home-settings"]');
      return configure;
    } };
    context.canRestoreModalFocus = button => button === configure && notices.at(-1) === true;

    values[key] = '';
    values.owner = 'retry-owner';
    const saving = saveSettings();
    await requested.promise;
    // モーダルが閉じてホームへ戻った時点を作り、別の操作先へ移った場合も確認する。
    context.autoClose.isClosed = true;
    context.restoredHomeButton = home;
    if (moveFocus) document.activeElement = address;
    response.resolve({ ok: false, writtenKeys: [key], hasInternalBrowserHome: false });
    assert.equal(await saving, false);
    assert.deepEqual(notices, [true]);
    assert.equal(document.activeElement, moveFocus ? address : configure);
  }
});

test('ホーム操作の false 応答と IPC 拒否を再試行案内として通知し、未設定と区別する', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const clickHandler = source.match(/internalBrowserSidebar\.addEventListener\('click', event => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(clickHandler);
  const homeNoticeMarkup = source.match(/<div class="internal-browser-home-notice">[\s\S]*?<\/div>/)?.[0];
  assert.ok(homeNoticeMarkup);
  assert.equal((homeNoticeMarkup.match(/role="status"/g) || []).length, 1);
  assert.match(homeNoticeMarkup, /<p role="status" aria-live="polite"><\/p>/);
  assert.match(homeNoticeMarkup, /class="internal-browser-home-error" role="alert" aria-live="assertive"/);
  const css = fs.readFileSync(path.join(__dirname, '../renderer/style.css'), 'utf8');
  assert.match(css, /\.internal-browser-home-error \{[^}]*color:[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.internal-browser-home-notice:not\(:has\(> p:not\(:empty\)\)\) \{ padding: 0; \}/);
  const failureMessage = 'ホームページを開けませんでした。もう一度お試しください。';
  for (const reply of [() => false, () => Promise.reject(new Error('IPC failed'))]) for (const toastAvailable of [true, false]) {
    const notices = [];
    const toasts = [];
    const homeError = { textContent: '' };
    const toast = { dataset: toastAvailable ? {} : { persistent: 'true' }, hidden: false };
    let hides = 0;
    let click;
    let currentReply = reply;
    const sidebar = {
      addEventListener(type, handler) { assert.equal(type, 'click'); click = handler; },
      querySelector(selector) {
        assert.equal(selector, '.internal-browser-home-error');
        return homeError;
      },
    };
    const context = vm.createContext({
      internalBrowserSidebar: sidebar,
      internalBrowserOpen: true,
      internalBrowserHomeRequestGeneration: 0,
      externalUrlToastEl: toast,
      VKIpc: { invoke(channel, action) {
        assert.equal(channel, 'internal-browser:action');
        assert.equal(action, 'home');
        return Promise.resolve(currentReply());
      } },
      setInternalBrowserHomeNotice: value => notices.push(value),
      syncInternalBrowserLayout() {},
      showGenericToast(message) { toasts.push(message); return toastAvailable; },
      hideExternalUrlToast() { hides++; toast.hidden = true; delete toast.dataset.homeFailure; },
    });
    vm.runInContext(clickHandler, context);
    click({ target: { closest: () => ({ dataset: { action: 'home' } }) } });
    await new Promise(setImmediate);
    assert.deepEqual(toasts, [failureMessage]);
    assert.deepEqual(notices, []);
    assert.equal(homeError.textContent, toastAvailable ? '' : failureMessage);
    assert.equal(toast.dataset.homeFailure, toastAvailable ? 'true' : undefined);
    assert.equal(toast.dataset.persistent, toastAvailable ? undefined : 'true');
    assert.equal(hides, 0);

    currentReply = () => 'https://example.com/';
    click({ target: { closest: () => ({ dataset: { action: 'home' } }) } });
    await new Promise(setImmediate);
    assert.deepEqual(notices, [false]);
    assert.equal(homeError.textContent, '');
    assert.equal(hides, toastAvailable ? 1 : 0);
    assert.equal(toast.dataset.persistent, toastAvailable ? undefined : 'true');

    // 別の通知に置き換わったトーストは、次の成功でも消さない。
    toast.hidden = false;
    delete toast.dataset.homeFailure;
    click({ target: { closest: () => ({ dataset: { action: 'home' } }) } });
    await new Promise(setImmediate);
    assert.equal(hides, toastAvailable ? 1 : 0);
  }

  // ホーム未設定は失敗扱いにせず、既存の設定案内を出す。
  const notices = [];
  const homeError = { textContent: '' };
  let click;
  vm.runInNewContext(clickHandler, {
    internalBrowserSidebar: { addEventListener(_type, handler) { click = handler; }, querySelector: () => homeError },
    internalBrowserOpen: true, internalBrowserHomeRequestGeneration: 0, externalUrlToastEl: null,
    VKIpc: { invoke: async () => 'home-unset' },
    setInternalBrowserHomeNotice: value => notices.push(value),
    syncInternalBrowserLayout() {},
  });
  click({ target: { closest: () => ({ dataset: { action: 'home' } }) } });
  await new Promise(setImmediate);
  assert.deepEqual(notices, [true]);
});

test('ホーム失敗は閉じると消え、閉じた後の遅延した失敗も再表示しない', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const setOpen = source.match(/function setInternalBrowserOpen\([^]*?\n\}/)?.[0];
  const clickHandler = source.match(/internalBrowserSidebar\.addEventListener\('click', event => \{[^]*?\n\}\);/)?.[0];
  assert.ok(setOpen && clickHandler);

  for (const replyKind of ['false', 'reject']) for (const closeBeforeReply of [false, true]) {
    const pending = Promise.withResolvers();
    const homeError = { textContent: '' };
    const toasts = [];
    const notices = [];
    let click;
    const sidebar = {
      contains: () => false,
      addEventListener(_type, handler) { click = handler; },
      querySelector(selector) {
        assert.equal(selector, '.internal-browser-home-error');
        return homeError;
      },
    };
    const context = vm.createContext({
      internalBrowserOpen: true, internalBrowserHasPage: true,
      internalBrowserHomeRequestGeneration: 0, internalBrowserWide: null,
      internalBrowserSidebar: sidebar,
      externalUrlToastEl: { dataset: { persistent: 'true' }, hidden: false },
      document: { activeElement: null, getElementById: () => ({ focus() {} }) },
      VKIpc: { invoke: () => pending.promise },
      setInternalBrowserHomeNotice: value => notices.push(value),
      syncInternalBrowserLayout() {},
      showGenericToast: message => { toasts.push(message); return false; },
    });
    const { setInternalBrowserOpen } = vm.runInContext(`${setOpen}\n${clickHandler}\n({ setInternalBrowserOpen })`, context);
    click({ target: { closest: () => ({ dataset: { action: 'home' } }) } });
    if (!closeBeforeReply) {
      if (replyKind === 'false') pending.resolve(false);
      else pending.reject(new Error('IPC failed'));
      await new Promise(setImmediate);
      assert.match(homeError.textContent, /ホームページを開けませんでした/);
      assert.equal(toasts.length, 1);
    }
    setInternalBrowserOpen(false);
    assert.equal(homeError.textContent, '');
    if (closeBeforeReply) {
      if (replyKind === 'false') pending.resolve(false);
      else pending.reject(new Error('IPC failed'));
      await new Promise(setImmediate);
      assert.equal(homeError.textContent, '');
      assert.deepEqual(toasts, []);
    }
    setInternalBrowserOpen(true);
    assert.equal(homeError.textContent, '');
    assert.deepEqual(notices, [false]);
  }
});

test('ホーム失敗の印は別の汎用・外部URLトーストへの差し替えと消去で外れる', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const functions = ['hideExternalUrlToast', 'showExternalUrlOpenFailedToast', 'showGenericToast']
    .map(name => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0]);
  assert.ok(functions.every(Boolean));
  const toast = {
    dataset: { homeFailure: 'true' }, hidden: false,
    classList: { remove() {}, toggle() {} },
    querySelector() { return { hidden: true }; },
  };
  const context = vm.createContext({
    externalUrlToastEl: toast, externalUrlToastCopyUrl: '',
    externalUrlToastHovered: false, externalUrlToastFocusWithin: false,
    ensureExternalUrlToast: () => toast, clearExternalUrlToastTimer() {},
    reconsiderExternalUrlToastTimer() {}, setExternalUrlToastInteractive() {},
    setExternalUrlToastMessage() {}, EXTERNAL_URL_TOAST_FAILED_MESSAGE: 'URL failure',
  });
  const { hideExternalUrlToast, showGenericToast, showExternalUrlOpenFailedToast } = vm.runInContext(
    `${functions.join('\n')}\n({ hideExternalUrlToast, showGenericToast, showExternalUrlOpenFailedToast })`, context,
  );
  assert.equal(showGenericToast('別の通知'), true);
  assert.equal(toast.dataset.homeFailure, undefined);
  toast.dataset.persistent = 'true';
  assert.equal(showGenericToast('ホーム失敗'), false);
  assert.equal(toast.dataset.persistent, 'true');
  delete toast.dataset.persistent;
  toast.dataset.homeFailure = 'true';
  showExternalUrlOpenFailedToast('https://example.com/');
  assert.equal(toast.dataset.homeFailure, undefined);
  toast.dataset.homeFailure = 'true';
  hideExternalUrlToast();
  assert.equal(toast.dataset.homeFailure, undefined);
  assert.equal(toast.hidden, true);
});

test('外部保存の部分成功後は失敗キーだけを再送し、成功先への別プロセスの変更を保持する', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-settings-save-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const firstPath = path.join(dir, 'first.json');
  const secondPath = path.join(dir, 'second.json');
  const descriptor = { groups: [
    { targetPath: firstPath, fields: [{ key: 'first' }] },
    { targetPath: secondPath, fields: [{ key: 'second' }, { key: 'untouched' }] },
  ] };
  fs.writeFileSync(secondPath, '{');
  const { saveSettings, values, payloads } = createSettingsSaveHarness(
    { first: '', second: '', untouched: 'old' },
    payload => saveSettingsToTargets(descriptor, payload),
  );
  values.first = 'saved first';
  values.second = 'retry second';
  assert.equal(await saveSettings(), false);
  assert.equal(JSON.parse(fs.readFileSync(firstPath)).first, 'saved first');

  // 再試行前に別のプロセスが成功先を更新し、失敗先を修復する。
  const updated = '{"first":"updated outside the app"}';
  fs.writeFileSync(firstPath, updated);
  fs.writeFileSync(secondPath, '{"untouched":"repaired outside the app"}');
  assert.equal(await saveSettings(), true);
  assert.deepEqual(payloads, [{ first: 'saved first', second: 'retry second' }, { second: 'retry second' }]);
  assert.equal(fs.readFileSync(firstPath, 'utf8'), updated);
  assert.deepEqual(JSON.parse(fs.readFileSync(secondPath)), {
    second: 'retry second', untouched: 'repaired outside the app',
  });
});

test('タイトルバーから空状態を開くと表示後にURL欄へ移り、再表示とリンク起点は操作元を保つ', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const setter = source.match(/function setInternalBrowserOpen\([\s\S]*?\n\}/)?.[0];
  const focusHelper = source.match(/function focusInternalBrowserToolbar\([\s\S]*?\n\}/)?.[0];
  const homeNoticeHelper = source.match(/function setInternalBrowserHomeNotice\([\s\S]*?\n\}/)?.[0];
  const toggleHandler = source.match(/document\.getElementById\('internal-browser-toggle'\)\.addEventListener\('click',.*\);/)?.[0];
  assert.ok(setter && focusHelper && homeNoticeHelper && toggleHandler);
  const calls = [];
  const document = { activeElement: null, getElementById: () => toggle };
  const toggle = { focus() { document.activeElement = this; }, addEventListener(_type, handler) { this.click = handler; } };
  const address = { value: '入力途中', selectionStart: 2, selectionEnd: 2,
    focus() { assert.equal(sidebar.hidden, false); calls.push('address'); document.activeElement = this; },
    closest() { return sidebar.hidden ? sidebar : null; } };
  const notice = { hidden: true, textContent: '' };
  const homeNoticeActions = { hidden: true };
  const homeNoticeStatus = { textContent: '' };
  const homeNotice = { querySelector: selector => selector === '[role="status"]' ? homeNoticeStatus : homeNoticeActions,
    contains: () => false };
  const sidebar = { hidden: true, contains: element => element === address,
    querySelector: selector => ({
      '.internal-browser-url': address,
      '.internal-browser-notice': notice,
      '.internal-browser-home-notice': homeNotice,
      '.internal-browser-home-error': { textContent: '' },
    })[selector] };
  const context = vm.createContext({ document, internalBrowserSidebar: sidebar,
    internalBrowserOpen: false, internalBrowserHasPage: false, internalBrowserWide: null,
    internalBrowserHomeRequestGeneration: 0,
    // 切り替えのアニメーション（issue #629）は即時に反映する形で置き換える。
    animateLayoutChange: update => update(),
    syncInternalBrowserLayout() { sidebar.hidden = !context.internalBrowserOpen; calls.push('layout'); } });
  vm.runInContext(`${setter}\n${focusHelper}\n${homeNoticeHelper}\n${toggleHandler}`, context);
  toggle.focus();
  toggle.click();
  assert.deepEqual(calls, ['layout', 'address']);
  assert.equal(document.activeElement, address);
  assert.equal(notice.hidden, false);
  assert.equal(address.value, '入力途中');
  assert.equal(address.selectionStart, 2);
  assert.equal(address.selectionEnd, 2);
  vm.runInContext('setInternalBrowserHomeNotice(true)', context);
  assert.equal(homeNoticeActions.hidden, false);
  assert.equal(homeNoticeStatus.textContent, 'ホームページが設定されていません。');
  // 空状態の入力を残したまま閉じ、再び開いてもすぐ入力できる。
  toggle.click();
  assert.equal(homeNoticeActions.hidden, true);
  assert.equal(homeNoticeStatus.textContent, '');
  assert.equal(document.activeElement, toggle);
  toggle.click();
  assert.equal(document.activeElement, address);
  assert.equal(address.value, '入力途中');
  // 表示済みページの再表示ではタイトルバーボタンを維持する。
  toggle.click();
  context.internalBrowserHasPage = true;
  const focusCount = calls.filter(call => call === 'address').length;
  toggle.click();
  assert.equal(document.activeElement, toggle);
  assert.equal(calls.filter(call => call === 'address').length, focusCount);
  // terminal/stash のリンク起点は、選択メニューから復帰した操作元を維持する。
  const origin = {};
  document.activeElement = origin;
  vm.runInContext("setInternalBrowserOpen(true, { focus: 'preserve' })", context);
  assert.equal(document.activeElement, origin);
  const choice = source.match(/function showInternalBrowserChoice\([\s\S]*?\n\}/)?.[0];
  assert.match(choice, /closeInternalBrowserChoice\(\);[\s\S]*setInternalBrowserOpen\(true, \{ focus: 'preserve' \}\)/);
});

test('左サイドバーの開閉完了後にブラウザとトーストの配置を再同期する', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const setter = source.match(/function setSidebarOpen\(open, options = \{\}\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(setter);
  const calls = [];
  const classes = new Set();
  let transitionEnd;
  const timerDelays = [];
  const aside = {
    addEventListener(_type, handler) { transitionEnd = handler; },
    removeEventListener() {},
  };
  const root = { classList: { toggle(name, value) { if (value) classes.add(name); else classes.delete(name); } } };
  const context = {
    document: { getElementById(id) { return id === 'root' ? root : { setAttribute() {} }; } },
    ensureSidebar() { return aside; },
    syncInternalBrowserLayout() { calls.push('sync'); },
    fitAll() { calls.push('fit'); },
    isReducedMotion() { return false; },
    // 保険のタイマーは、今効いているトランジションの時間（開く 0.12s・閉じる 0.1s）+ 40ms で張る。
    getComputedStyle() { return { transitionDuration: classes.has('sidebar-open') ? '0.12s, 0.12s' : '0.1s, 0.1s' }; },
    setTimeout(_callback, delay) { timerDelays.push(delay); return 1; }, clearTimeout() {},
    focusFirstSidebarItem() {}, sidebarOpen: false, sidebarTransitionCleanup: null, internalBrowserOpen: false,
    // 切り替えのアニメーション（issue #629）の遷移中ではない状態を再現する。
    layoutTransition: null,
  };
  vm.runInNewContext(`${setter}\nsetSidebarOpen(true, { focusFirst: false })`, context);
  assert.deepEqual(calls, ['sync']);
  transitionEnd({ target: aside, propertyName: 'transform' });
  assert.deepEqual(calls, ['sync', 'sync', 'fit']);
  vm.runInNewContext('setSidebarOpen(false)', context);
  transitionEnd({ target: aside, propertyName: 'transform' });
  assert.deepEqual(calls.slice(-3), ['sync', 'sync', 'fit']);
  assert.equal(classes.has('sidebar-open'), false);
  assert.deepEqual(timerDelays.map(Math.round), [160, 140]);
  // レイアウト切り替えの遷移中は開閉完了を待たず、再フィットを遷移の終わりへ預ける（issue #629）。
  const frames = [];
  let timers = 0;
  Object.assign(context, {
    layoutTransition: {}, layoutTransitionFitPending: false,
    requestAnimationFrame(callback) { frames.push(callback); },
    setTimeout() { timers += 1; return 1; },
  });
  const before = calls.length;
  vm.runInNewContext('setSidebarOpen(true, { focusFirst: false })', context);
  frames.forEach(callback => callback());
  assert.deepEqual(calls.slice(before), ['sync']);
  assert.equal(timers, 0);
  assert.equal(context.layoutTransitionFitPending, true);
});

test('狭幅の同期は左を閉じてから再計算し、手動で左を開くとブラウザを閉じる', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../renderer/style.css'), 'utf8');
  const sync = source.match(/function syncInternalBrowserLayout\([\s\S]*?\n\}/)[0];
  const setter = source.match(/function setSidebarOpen\([\s\S]*?\n\}/)[0];
  const classes = new Set(['sidebar-open']);
  const root = { clientWidth: 600, children: [], style: { setProperty() {} },
    classList: { contains: key => classes.has(key), toggle(key, enabled) { if (enabled) classes.add(key); else classes.delete(key); } },
    querySelector: () => null };
  const attributes = {};
  const toggle = { setAttribute(key, value) { attributes[key] = value; } };
  const resizer = { setAttribute() {} };
  let focused = '';
  const address = { focus() { focused = 'address'; }, getClientRects: () => [{}] };
  const browser = { style: {}, querySelector: selector => selector === '.internal-browser-url' ? address : selector === '.internal-browser-resizer' ? resizer : null };
  browser.contains = element => element === address;
  const body = { style: { setProperty() {} }, classList: { contains: () => false } };
  const documentState = { activeElement: null, body };
  let terminalInert = false;
  const terminal = { isConnected: true, contains: () => true, closest: () => null, focus() { focused = 'terminal'; } };
  Object.defineProperty(terminal, 'inert', {
    get: () => terminalInert,
    set(value) {
      terminalInert = value;
      // Chromium はフォーカス中の祖先を inert にすると activeElement を body へ落とす。
      if (value && documentState.activeElement === terminal) documentState.activeElement = body;
    },
  });
  documentState.activeElement = terminal;
  root.children = [terminal, browser];
  const frames = [];
  const calls = [];
  const context = vm.createContext({
    document: Object.assign(documentState, {
      getElementById: id => id === 'root' ? root : id === 'sidebar' ? { getBoundingClientRect: () => ({ width: 300 }) } : toggle,
    }),
    window: { VKInternalBrowserLayout: require('../utils/internalBrowserLayout') },
    internalBrowserOpen: true, sidebarOpen: true, internalBrowserSidebar: browser,
    preferredInternalBrowserWidth: 520, displayedInternalBrowserWidth: 0, previousInternalBrowserLayout: null,
    internalBrowserOverlayFocusOrigin: null, internalBrowserWide: null, syncInternalBrowserWideToggle() {},
    layoutTransition: null,
    setupPanel: null, sidebarTransitionCleanup: null,
    gridDims: () => ({ cols: 1 }), getSidebarWidth: () => 300,
    ensureSidebar: () => null, isReducedMotion: () => true, fitAll() {},
    focusFirstSidebarItem() {}, requestAnimationFrame: callback => frames.push(callback),
    focusInternalBrowserToolbar() { address.focus(); },
    internalBrowserToastReserve: () => 0,
    VKIpc: { send() {} },
    setInternalBrowserOpen(open) { calls.push(open); context.internalBrowserOpen = open; },
  });
  vm.runInContext(`${sync}\n${setter}\nsyncInternalBrowserLayout()`, context);
  assert.equal(context.sidebarOpen, false);
  assert.equal(context.internalBrowserOpen, true);
  assert.equal(context.displayedInternalBrowserWidth, 280);
  assert.equal(context.preferredInternalBrowserWidth, 520);
  assert.equal(address.placeholder, 'URL / 検索');
  assert.equal(attributes['aria-expanded'], 'false');
  assert.match(css, /#root\.internal-browser-open \.sidebar\s*\{[^}]*transition: none;/);
  assert.match(css, /#root\.internal-browser-overlay \.internal-browser-sidebar\s*\{[^}]*position: absolute;/);
  vm.runInContext('setSidebarOpen(true)', context);
  assert.deepEqual(calls, [false]);
  assert.equal(context.sidebarOpen, true);
  root.clientWidth = 390;
  context.sidebarOpen = false;
  context.internalBrowserOpen = true;
  vm.runInContext('syncInternalBrowserLayout()', context);
  assert.equal(context.displayedInternalBrowserWidth, 390);
  assert.equal(classes.has('internal-browser-overlay'), true);
  // 全面表示中のトーストは画面全体の幅を使えるため、語句の折り返し保護を外さない。
  assert.equal(classes.has('toast-phrase-wrap'), false);
  assert.equal(terminal.inert, true);
  frames.splice(0).forEach(callback => callback());
  assert.equal(focused, 'address');
  // 幅を戻すだけでは、保存幅を上書きしたりブラウザを再び開いたりしない。
  root.clientWidth = 1280;
  context.sidebarOpen = true;
  context.internalBrowserOpen = true;
  vm.runInContext('syncInternalBrowserLayout()', context);
  assert.equal(context.sidebarOpen, true);
  assert.equal(context.displayedInternalBrowserWidth, 520);
  assert.equal(context.preferredInternalBrowserWidth, 520);
  assert.equal(address.placeholder, 'URL または検索語');
  assert.equal(classes.has('internal-browser-overlay'), false);
  assert.equal(terminal.inert, false);
  frames.splice(0).forEach(callback => callback());
  assert.equal(focused, 'terminal');
});

test('全面表示中だけ、表示中のトーストに重なる高さをページ領域から詰める', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const reserve = source.match(/function internalBrowserToastReserve\([\s\S]*?\n\}/)[0];
  const toast = { hidden: false, getBoundingClientRect: () => ({ top: 700.4 }) };
  const context = vm.createContext({
    internalBrowserSidebar: { getBoundingClientRect: () => ({ bottom: 762 }) },
    externalUrlToastEl: toast,
  });
  vm.runInContext(reserve, context);
  // トースト上端からブラウザ下端までの 61.6px を切り上げ、16px の間隔を足す。
  assert.equal(vm.runInContext('internalBrowserToastReserve(true)', context), 78);
  // 横並びではトーストをブラウザの左へ逃がすため、ページ領域は詰めない。
  assert.equal(vm.runInContext('internalBrowserToastReserve(false)', context), 0);
  toast.hidden = true;
  assert.equal(vm.runInContext('internalBrowserToastReserve(true)', context), 0);
  context.externalUrlToastEl = null;
  assert.equal(vm.runInContext('internalBrowserToastReserve(true)', context), 0);
});

test('初期化時もホーム・広く表示・閉じるは使え、失敗表示には触れない', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const initialization = source.match(/for \(const button of internalBrowserSidebar\.querySelectorAll\('[^']+'\)\) button\.disabled = true;/)?.[0];
  assert.ok(initialization);
  // ページ未表示でも、ホームの読み込みとブラウザの表示操作ができる。
  const toolbarButtons = ['back', 'forward', 'reload', 'home', 'wide', 'external', 'close']
    .map(action => ({ action, disabled: false }));
  const errorButtons = [{ disabled: false }, { disabled: false }];
  const sidebar = {
    querySelectorAll(selector) {
      assert.equal(selector, '.internal-browser-toolbar button:not([data-action="close"]):not([data-action="wide"]):not([data-action="home"])');
      return toolbarButtons.filter(button => !['close', 'wide', 'home'].includes(button.action));
    },
  };
  vm.runInNewContext(initialization, { internalBrowserSidebar: sidebar });
  assert.deepEqual(toolbarButtons.map(button => button.disabled), [true, true, true, false, false, true, false]);
  assert.deepEqual(errorButtons.map(button => button.disabled), [false, false]);
});

test('外部ボタンの可視URLは同一ホストのパスと検索条件まで区別し、狭幅で横スクロールできる', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../renderer/style.css'), 'utf8');
  const helper = source.match(/function formatInternalBrowserDestination\(url\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper);
  const format = vm.runInNewContext(`${helper}\nformatInternalBrowserDestination`, { URL });
  assert.equal(format('https://example.com/confirmed?q=1#top'), 'https://example.com/confirmed?q=1#top');
  assert.equal(format('http://example.com/failed?q=2#bottom'), '⚠ HTTP: http://example.com/failed?q=2#bottom');
  assert.equal(format('https://example.com/' + 'a'.repeat(400)), 'https://example.com/' + 'a'.repeat(400));
  assert.equal(format('invalid-url'), '');
  assert.match(css, /\.internal-browser-external-target\s*\{[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.internal-browser-external-target,\s*\.internal-browser-error \[data-action="external"\]\s*\{[^}]*display: block;[^}]*white-space: nowrap;[^}]*overflow-x: auto;[^}]*overflow-y: hidden;/);
  assert.doesNotMatch(css, /-webkit-line-clamp/);
  const targetTag = source.match(/<p class="internal-browser-external-target"[^>]*>/)[0];
  assert.doesNotMatch(targetTag, /role=|aria-live=/);
  assert.match(source, /internal-browser-navigation-status" role="status" aria-live="polite"/);
});

test('アドレス欄は編集中の通知を保持し、Enter のみで正規化した先へ移動する', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const addressHandlers = source.match(/const internalBrowserAddress = internalBrowserSidebar\.querySelector\('\.internal-browser-url'\);[\s\S]*?(?=document\.getElementById\('internal-browser-toggle'\))/)?.[0];
  assert.ok(addressHandlers);
  assert.match(source, /<input type="text" class="internal-browser-url" aria-label="URL または検索語を入力"/);
  assert.match(source, /id="internal-browser-address-error"[^>]*role="alert"/);
  assert.match(source, /<\/button><\/div><p id="internal-browser-address-error"[^>]*><\/p><p class="internal-browser-external-target"[^>]*><\/p>/);
  assert.doesNotMatch(source, /表示中の URL をコピー/);
  const handlers = {};
  const opened = [];
  const error = { id: 'internal-browser-address-error', hidden: true, textContent: '' };
  const external = { setAttribute() {} };
  const target = { hidden: true, textContent: '' };
  const navigationStatus = { textContent: '' };
  const address = { value: '', attributes: {}, addEventListener: (type, handler) => { handlers[type] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; } };
  const context = vm.createContext({
    internalBrowserSidebar: { querySelector: selector => ({ '.internal-browser-url': address, '.internal-browser-address-error': error,
      '.internal-browser-toolbar [data-action="external"]': external, '.internal-browser-external-target': target, '.internal-browser-navigation-status': navigationStatus })[selector] },
    resolveBrowserAddress: require('../renderer/urlSafety').resolveBrowserAddress,
    VKIpc: { invoke: (_channel, url) => { opened.push(url); return Promise.resolve(); } },
    syncInternalBrowserLayout() {},
    URL,
  });
  vm.runInContext(`let internalBrowserUrl = 'https://old.example'; let internalBrowserDownloadUrl = ''; let internalBrowserPendingUrl = ''; let internalBrowserAddressHasDraft = false; let internalBrowserHasPage = false; ${addressHandlers}`, context);
  address.value = 'github.com/vektor-inc';
  handlers.input();
  assert.equal(target.textContent, '外部で開く: 表示中のページ https://old.example/');
  assert.equal(navigationStatus.textContent, '');
  assert.equal(vm.runInContext('internalBrowserAddressHasDraft', context), true);
  handlers.keydown({ key: 'ArrowRight' });
  assert.deepEqual(opened, []);
  handlers.keydown({ key: 'Enter', isComposing: true });
  assert.deepEqual(opened, []);
  handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(opened, ['https://github.com/vektor-inc']);
  assert.equal(address.value, opened[0]);
  assert.equal(target.hidden, false);
  assert.equal(vm.runInContext('internalBrowserAddressHasDraft', context), false);
  assert.equal(vm.runInContext('internalBrowserHasPage', context), true);
  assert.equal(vm.runInContext('internalBrowserPendingUrl', context), opened[0]);
  assert.equal(navigationStatus.textContent, 'ページを読み込み中');
  address.value = 'javascript:alert(1)';
  handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(opened[1], 'https://www.google.com/search?q=javascript%3Aalert(1)');
  address.value = '  ';
  handlers.input();
  handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(address.value, '  ');
  assert.equal(error.textContent, 'URL または検索語を入力してください。');
  assert.equal(address.attributes['aria-invalid'], 'true');
  assert.equal(address.attributes['aria-describedby'], error.id);
  address.value = 'https://example.com:99999/path';
  handlers.input();
  assert.equal(error.hidden, true);
  assert.equal(address.attributes['aria-invalid'], undefined);
  handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.match(error.textContent, /URL の形式/);
  address.value = `https://example.com:99999/${'あ'.repeat(300)}`;
  handlers.input();
  handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.match(error.textContent, /URL の形式/);
  address.value = 'あ'.repeat(700);
  handlers.input();
  handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.match(error.textContent, /長すぎます/);
  assert.equal(opened.length, 2);
  address.value = '例え.テスト';
  handlers.input();
  handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(address.value, 'https://例え.テスト');
  assert.equal(error.hidden, true);
  assert.equal(address.attributes['aria-describedby'], undefined);
});

test('main が Enter の送信を受け付けないときは読み込み中を解除し、入力を残して案内する', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const addressHandlers = source.match(/const internalBrowserAddress = internalBrowserSidebar\.querySelector\('\.internal-browser-url'\);[\s\S]*?(?=document\.getElementById\('internal-browser-toggle'\))/)?.[0];
  assert.ok(addressHandlers);
  // アドレス欄まわりの要素と、送信ごとに結果を差し替えられる VKIpc.invoke を用意する。
  const handlers = {};
  const replies = [];
  const error = { id: 'internal-browser-address-error', hidden: true, textContent: '' };
  const external = { setAttribute() {} };
  const target = { hidden: true, textContent: '' };
  const navigationStatus = { textContent: '' };
  const address = { value: '', attributes: {}, addEventListener: (type, handler) => { handlers[type] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; } };
  const context = vm.createContext({
    internalBrowserSidebar: { querySelector: selector => ({ '.internal-browser-url': address, '.internal-browser-address-error': error,
      '.internal-browser-toolbar [data-action="external"]': external, '.internal-browser-external-target': target, '.internal-browser-navigation-status': navigationStatus })[selector] },
    resolveBrowserAddress: require('../renderer/urlSafety').resolveBrowserAddress,
    VKIpc: { invoke: () => replies.shift() },
    syncInternalBrowserLayout() {},
    URL,
  });
  vm.runInContext(`let internalBrowserUrl = ''; let internalBrowserFailedUrl = ''; let internalBrowserDownloadUrl = ''; let internalBrowserPendingUrl = ''; let internalBrowserAddressHasDraft = false; let internalBrowserHasPage = false; ${addressHandlers}`, context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const enter = value => {
    address.value = value;
    handlers.input();
    handlers.keydown({ key: 'Enter', preventDefault() {} });
  };

  // main が false を返すと、Enter で立てた読み込み中の状態を解除し、入力した文字列とエラーを表示する。
  replies.push(Promise.resolve(false));
  enter('github.com/vektor-inc');
  assert.equal(navigationStatus.textContent, 'ページを読み込み中');
  await settle();
  assert.equal(vm.runInContext('internalBrowserNavigationActive', context), false);
  assert.equal(vm.runInContext('internalBrowserActiveRequestId', context), null);
  assert.equal(vm.runInContext('internalBrowserPendingUrl', context), '');
  assert.equal(vm.runInContext('internalBrowserHasPage', context), false);
  assert.equal(vm.runInContext('internalBrowserAddressHasDraft', context), true);
  assert.equal(navigationStatus.textContent, '');
  assert.equal(address.value, 'github.com/vektor-inc');
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, 'ページを開けませんでした。もう一度 Enter を押してください。続けて開けない場合は、アプリを再起動してください。');
  assert.equal(address.attributes['aria-invalid'], 'true');
  assert.equal(address.attributes['aria-describedby'], error.id);

  // IPC の例外も同じく扱う。
  replies.push(Promise.reject(new Error('ipc failed')));
  enter('example.com');
  await settle();
  assert.equal(vm.runInContext('internalBrowserNavigationActive', context), false);
  assert.equal(address.value, 'example.com');
  assert.equal(error.textContent, 'ページを開けませんでした。もう一度 Enter を押してください。続けて開けない場合は、アプリを再起動してください。');

  // 古い送信の拒否が後から届いても、後続の送信の読み込み中表示を巻き戻さない。
  let rejectFirst;
  replies.push(new Promise(resolve => { rejectFirst = resolve; }), Promise.resolve(true));
  enter('first.example');
  enter('second.example');
  await settle();
  rejectFirst(false);
  await settle();
  assert.equal(vm.runInContext('internalBrowserNavigationActive', context), true);
  assert.equal(vm.runInContext('internalBrowserPendingUrl', context), 'https://second.example');
  assert.equal(address.value, 'https://second.example');
  assert.equal(navigationStatus.textContent, 'ページを読み込み中');
  assert.equal(error.hidden, true);
});

test('main の拒否を待つ間にアドレス欄を編集したときは、拒否が届いても編集した文字列を残す', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const addressHandlers = source.match(/const internalBrowserAddress = internalBrowserSidebar\.querySelector\('\.internal-browser-url'\);[\s\S]*?(?=document\.getElementById\('internal-browser-toggle'\))/)?.[0];
  assert.ok(addressHandlers);
  const handlers = {};
  const error = { id: 'internal-browser-address-error', hidden: true, textContent: '' };
  const navigationStatus = { textContent: '' };
  const address = { value: '', attributes: {}, addEventListener: (type, handler) => { handlers[type] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; } };
  let reply;
  const context = vm.createContext({
    internalBrowserSidebar: { querySelector: selector => ({ '.internal-browser-url': address, '.internal-browser-address-error': error,
      '.internal-browser-toolbar [data-action="external"]': { setAttribute() {} }, '.internal-browser-external-target': { hidden: true, textContent: '' },
      '.internal-browser-navigation-status': navigationStatus })[selector] },
    resolveBrowserAddress: require('../renderer/urlSafety').resolveBrowserAddress,
    VKIpc: { invoke: () => reply },
    syncInternalBrowserLayout() {},
    URL,
  });
  vm.runInContext(`let internalBrowserUrl = ''; let internalBrowserFailedUrl = ''; let internalBrowserDownloadUrl = ''; let internalBrowserPendingUrl = ''; let internalBrowserAddressHasDraft = false; let internalBrowserHasPage = false; ${addressHandlers}`, context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const type = value => {
    address.value = value;
    handlers.input();
  };

  // false の応答と例外のどちらでも、応答前に打ち直した文字列を送信時の入力へ戻さない。
  for (const [label, settleReply] of [['false', resolve => resolve(false)], ['例外', (_resolve, reject) => reject(new Error('ipc failed'))]]) {
    let resolveReply;
    let rejectReply;
    reply = new Promise((resolve, reject) => { resolveReply = resolve; rejectReply = reject; });
    type('first.example');
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(address.value, 'https://first.example', label);
    type('second.example/edit');
    settleReply(resolveReply, rejectReply);
    await settle();
    // 読み込み中の状態は解除し、エラーで案内する。
    assert.equal(vm.runInContext('internalBrowserNavigationActive', context), false, label);
    assert.equal(navigationStatus.textContent, '', label);
    assert.equal(vm.runInContext('internalBrowserAddressHasDraft', context), true, label);
    assert.equal(address.value, 'second.example/edit', label);
    assert.equal(error.hidden, false, label);
    assert.equal(error.textContent, 'ページを開けませんでした。もう一度 Enter を押してください。続けて開けない場合は、アプリを再起動してください。', label);
  }
});

test('開き先メニュー表示中は別リンクのツールチップを出さない', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const tooltip = source.match(/function showTermLinkTooltip\(event, url\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(tooltip);
  let created = 0;
  const element = { hidden: true, style: {}, offsetWidth: 40, offsetHeight: 20 };
  const context = {
    internalBrowserChoice: {}, internalBrowserOpen: false,
    ensureTermLinkTooltip() { created++; return element; },
    termLinkTooltipMessage: () => 'リンク',
    window: { innerWidth: 800, innerHeight: 600 },
  };
  vm.runInNewContext(`${tooltip}\nshowTermLinkTooltip({ clientX: 10, clientY: 10 }, 'https://example.com')`, context);
  assert.equal(created, 0);
  context.internalBrowserChoice = null;
  vm.runInNewContext('showTermLinkTooltip({ clientX: 10, clientY: 10 }, "https://example.com")', context);
  assert.equal(created, 1);
  assert.equal(element.hidden, false);
});

test('幅キーは表示中の幅を起点にし、開き先メニューはツールチップを隠す', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const keyHandler = source.match(/internalBrowserResizer\.addEventListener\('keydown', event => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(keyHandler);
  const handlers = {};
  const saved = [];
  const context = { internalBrowserResizer: { addEventListener: (_event, handler) => { handlers.keydown = handler; } },
    preferredInternalBrowserWidth: 0, displayedInternalBrowserWidth: 482, internalBrowserWide: null,
    syncInternalBrowserLayout() { context.displayedInternalBrowserWidth = context.preferredInternalBrowserWidth; },
    localStorage: { setItem: (_key, value) => saved.push(value) } };
  vm.runInNewContext(keyHandler, context);
  handlers.keydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(context.preferredInternalBrowserWidth, 498);
  handlers.keydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(context.preferredInternalBrowserWidth, 482);
  assert.deepEqual(saved, ['498', '482']);
  // 広く表示中は境界を隠しており、キー操作でも保存幅を書き換えない。
  context.internalBrowserWide = { stashedIds: [] };
  handlers.keydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(context.preferredInternalBrowserWidth, 482);
  assert.deepEqual(saved, ['498', '482']);
  const choice = source.match(/function showInternalBrowserChoice\([\s\S]*?\n\}/)?.[0];
  assert.match(choice, /closeInternalBrowserChoice\(\);\s*hideTermLinkTooltip\(\);/);
});

test('失敗表示は失敗 URL、操作列は確定 URL を安全な外部オープン経路へ渡す', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const style = fs.readFileSync(path.join(__dirname, '../renderer/style.css'), 'utf8');
  assert.match(source, /class="internal-browser-error"[^>]*>[\s\S]*?<button type="button" data-action="external">/);
  assert.match(style, /\.internal-browser-error \[data-action="external"\][^}]*max-width:[^;]+;[^}]*text-align: left;/);
  const clickHandler = source.match(/internalBrowserSidebar\.addEventListener\('click', event => \{[\s\S]*?\n\}\);/)?.[0];
  const stateHandler = source.match(/VKIpc\.on\('internal-browser:state', state => \{[\s\S]*?\n\}\);/)?.[0];
  const focusHelpers = source.match(/function focusInternalBrowserToolbar\(\) \{[\s\S]*?\n\}\n\nfunction hideInternalBrowserContent\(element\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(clickHandler);
  assert.ok(stateHandler);
  assert.ok(focusHelpers);
  const handlers = {};
  const buttons = [];
  let layoutSyncs = 0;
  const opened = [];
  const helpOpened = [];
  let messageWrites = 0;
  let messageText = '';
  const message = {
    get textContent() { return messageText; },
    set textContent(value) { messageWrites++; messageText = value; },
  };
  let activeElement = null;
  const focus = element => { activeElement = element; };
  const errorReload = {};
  const errorButtons = [{ disabled: true }, { disabled: true, textContent: '外部ブラウザで開く',
    getAttribute(name) { return this[name]; }, setAttribute(name, value) { this[name] = value; } }];
  const failedExternal = errorButtons[1];
  const errorView = { hidden: true, contains: element => element === errorReload,
    querySelector: selector => selector === '[data-action="external"]' ? failedExternal : message,
    querySelectorAll: () => errorButtons };
  const notice = { hidden: true, dataset: {}, contains: element => buttons.includes(element), replaceChildren() {}, append() {} };
  const display = { value: '', closest: () => null, focus() { focus(this); } };
  const controls = { disabled: false };
  const external = { disabled: false, setAttribute(name, value) { this[name] = value; } };
  const target = { hidden: true, textContent: '' };
  const navigationStatus = { textContent: '' };
  const reload = { disabled: false, closest: () => null, focus() { focus(this); } };
  const progress = { hidden: true };
  const sidebar = {
    addEventListener: (_type, handler) => { handlers.click = handler; },
    querySelector: selector => ({ '.internal-browser-error': errorView, '.internal-browser-notice': notice, '.internal-browser-url': display, '.internal-browser-toolbar [data-action="reload"]': reload, '.internal-browser-progress': progress, '.internal-browser-toolbar [data-action="external"]': external, '.internal-browser-external-target': target, '.internal-browser-navigation-status': navigationStatus }[selector] || controls),
  };
  const context = {
    internalBrowserSidebar: sidebar,
    internalBrowserAddress: display,
    internalBrowserPendingUrl: '',
    internalBrowserAddressHasDraft: false,
    VKIpc: { on: (name, handler) => { handlers[name] = handler; }, invoke: (channel, source) => { helpOpened.push([channel, source]); return Promise.resolve(true); } },
    openExternalUrlSafe: url => opened.push(url),
    syncInternalBrowserLayout() { layoutSyncs++; },
    URL,
    document: { get activeElement() { return activeElement; }, createElement: () => {
      const button = { textContent: '', append() {}, addEventListener(_type, handler) { this.click = handler; } };
      buttons.push(button);
      return button;
    } },
  };
  const formattingHelper = source.match(/function formatInternalBrowserDestination\(url\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(formattingHelper);
  const targetHelpers = source.match(/function getInternalBrowserExternalTarget\(\) \{[\s\S]*?(?=function clearInternalBrowserAddressError\()/)?.[0];
  assert.ok(targetHelpers);
  vm.runInNewContext(`let internalBrowserUrl = 'https://example.com/confirmed'; let internalBrowserFailedUrl = ''; let internalBrowserDownloadUrl = ''; let internalBrowserHasPage = true; let internalBrowserNavigationActive = false; ${formattingHelper} ${focusHelpers} ${targetHelpers} ${clickHandler} ${stateHandler}`, context);
  const state = (failedUrl, github404Url = '', loading = false, url = 'https://example.com/confirmed') => handlers['internal-browser:state']({ url, failedUrl, github404Url, loading });
  state('https://example.com/failed', '', false);
  assert.equal(display.value, 'https://example.com/failed');
  assert.equal(external.title, '確定済みの URL を外部ブラウザで開く: https://example.com/confirmed');
  assert.equal(target.textContent, '外部で開く: 表示中のページ https://example.com/confirmed');
  assert.equal(target.hidden, false);
  assert.equal(failedExternal.textContent, '失敗したページを外部で開く: https://example.com/failed');
  assert.equal(failedExternal.title, '失敗したページを外部で開く: https://example.com/failed');
  assert.equal(failedExternal['aria-label'], failedExternal.textContent);
  handlers['internal-browser:state']({ url: 'https://example.com/confirmed', pendingUrl: 'https://pending.example/loading', failedUrl: '' });
  assert.equal(display.value, 'https://pending.example/loading');
  assert.equal(target.textContent, '外部で開く: 表示中のページ https://example.com/confirmed');
  assert.equal(external.title, '確定済みの URL を外部ブラウザで開く: https://example.com/confirmed');
  context.internalBrowserAddressHasDraft = true;
  display.value = '編集中の検索語';
  state('https://example.com/failed', '', false, 'https://example.com/next');
  assert.equal(display.value, '編集中の検索語');
  assert.equal(external['aria-label'], '確定済みの URL を外部ブラウザで開く: https://example.com/next');
  assert.equal(target.textContent, '外部で開く: 表示中のページ https://example.com/next');
  context.internalBrowserAddressHasDraft = false;
  state('', '', false, 'http://example.com/insecure');
  assert.equal(target.hidden, false);
  assert.equal(target.textContent, '外部で開く: 表示中のページ ⚠ HTTP: http://example.com/insecure');
  state('', '', false, 'https://example.com/next');
  assert.equal(target.hidden, true);
  state('https://example.com/failed', '', false, 'https://example.com/next');
  assert.equal(display.value, 'https://example.com/failed');
  assert.equal(messageWrites, 5);
  state('https://example.com/failed', '', true);
  assert.equal(progress.hidden, false);
  state('https://example.com/failed', '', false);
  assert.equal(progress.hidden, true);
  assert.equal(messageWrites, 5);
  assert.equal(message.textContent, 'ページを表示できませんでした（example.com）');
  assert.equal(errorView.hidden, false);
  assert.equal(errorButtons.every(button => !button.disabled), true);
  activeElement = errorReload;
  state('', '', false);
  assert.equal(activeElement, display);
  assert.equal(message.textContent, '');
  assert.equal(errorView.hidden, true);
  assert.equal(failedExternal.textContent, '外部ブラウザで開く');
  assert.equal(failedExternal.title, '');
  assert.equal(failedExternal['aria-label'], '外部ブラウザで開く');
  assert.equal(messageWrites, 6);
  state('https://failed.example/failed', '', false);
  assert.equal(target.textContent, '外部で開く: 表示中のページ https://example.com/confirmed');
  assert.equal(failedExternal.textContent, '失敗したページを外部で開く: https://failed.example/failed');
  assert.equal(failedExternal.title, '失敗したページを外部で開く: https://failed.example/failed');
  assert.equal(message.textContent, 'ページを表示できませんでした（failed.example）');
  assert.equal(messageWrites, 7);
  state('invalid-url', '', false);
  assert.equal(message.textContent, 'ページを表示できませんでした');
  assert.equal(messageWrites, 8);
  state('https://failed.example/failed', '', false);
  const click = inError => handlers.click({ target: {
    closest: selector => selector === '[data-action]' ? { dataset: { action: 'external' } } : selector === '.internal-browser-error' && inError ? errorView : null,
  } });
  click(true);
  click(false);
  state('', '', false, '');
  handlers['internal-browser:state']({ url: '', downloadUrl: 'https://download.example/file' });
  assert.equal(external.disabled, false);
  assert.equal(external.title, 'ダウンロード先を外部ブラウザで開く: https://download.example/file');
  assert.equal(external['aria-label'], external.title);
  assert.equal(target.textContent, '外部で開く: ダウンロード先 https://download.example/file');
  click(false);
  state('');
  assert.equal(external.title, '確定済みの URL を外部ブラウザで開く: https://example.com/confirmed');
  assert.equal(external['aria-label'], external.title);
  state('', '', false, '');
  assert.equal(external.disabled, true);
  assert.equal(external.title, '外部ブラウザで開く（確定済みの URL なし）');
  assert.equal(target.hidden, true);
  assert.deepEqual(opened, ['https://failed.example/failed', 'https://example.com/confirmed', 'https://download.example/file']);
  activeElement = controls;
  state('');
  assert.equal(activeElement, controls);
  state('', 'https://github.com/missing', false);
  state('', 'https://github.com/missing', true);
  assert.equal(notice.hidden, false);
  state('', 'https://github.com/missing', false);
  assert.equal(notice.hidden, false);
  const beforeDismiss = layoutSyncs;
  const closeNotice = buttons.find(button => button.textContent === '案内を閉じる');
  activeElement = closeNotice;
  closeNotice.click();
  assert.equal(notice.hidden, true);
  assert.equal(activeElement, display);
  assert.equal(layoutSyncs, beforeDismiss + 1);
  state('', 'https://github.com/missing', false);
  assert.equal(notice.hidden, true);
  state('', '', false);
  assert.equal(notice.hidden, true);
  state('', 'https://github.com/another');
  activeElement = buttons.find(button => button.textContent === '案内を閉じる' && button !== closeNotice);
  state('', 'https://github.com/another', false, '');
  activeElement.click();
  assert.equal(activeElement, display);
  // 同じホストでも両ボタンの実際の開き先をパスと検索条件で区別する。
  const confirmed = 'https://example.com/confirmed?version=1#top';
  const failed = 'https://example.com/failed?version=2#bottom';
  state(failed, '', false, confirmed);
  assert.equal(target.textContent, '外部で開く: 表示中のページ https://example.com/confirmed?version=1#top');
  assert.equal(failedExternal.textContent, '失敗したページを外部で開く: https://example.com/failed?version=2#bottom');
  assert.ok(failedExternal['aria-label'].startsWith(failedExternal.textContent));
  assert.equal(failedExternal.title, `失敗したページを外部で開く: ${failed}`);
  click(true);
  click(false);
  assert.deepEqual(opened.slice(-2), [failed, confirmed]);
  // CSS で可視文を2行に制限しても、長い失敗先・download 先の全情報と操作対象は残す。
  const longUrl = 'https://example.com/' + 'path'.repeat(350) + '?q=' + 'query'.repeat(100) + '#fragment';
  assert.ok(longUrl.length < 2048);
  state(longUrl, '', false, confirmed);
  assert.ok(failedExternal.title.endsWith(longUrl));
  assert.ok(failedExternal['aria-label'].includes(longUrl));
  assert.equal(failedExternal.disabled, false);
  click(true);
  assert.equal(opened.at(-1), longUrl);
  handlers['internal-browser:state']({ url: confirmed, failedUrl: '', downloadUrl: longUrl });
  assert.equal(target.hidden, false);
  assert.ok(target.title.endsWith(longUrl));
  assert.equal(target.ariaLabel, target.title);
  assert.ok(external['aria-label'].endsWith(longUrl));
  assert.equal(external.disabled, false);
  click(false);
  assert.equal(opened.at(-1), longUrl);
  handlers['internal-browser:state']({ url: '', failedUrl: '', downloadUrl: '' });
  assert.equal(target.title, '');
  assert.equal(target.ariaLabel, '');
  handlers['internal-browser:state']({ url: 'vk-terminals-help://guide/#current', failedUrl: 'vk-terminals-help://guide/#failed', downloadUrl: '' });
  click(false);
  click(true);
  assert.deepEqual(helpOpened, [['internal-browser:external', 'current'], ['internal-browser:external', 'failed']]);
  assert.equal(opened.at(-1), longUrl);
});

test('main の遷移結果を順に受け、失敗・成功・中止・置換・ダウンロード阻止を通知する', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const addressHandlers = source.match(/const internalBrowserAddress = internalBrowserSidebar\.querySelector\('\.internal-browser-url'\);[\s\S]*?(?=document\.getElementById\('internal-browser-toggle'\))/)?.[0];
  const stateHandler = source.match(/VKIpc\.on\('internal-browser:state', state => \{[\s\S]*?\n\}\);/)?.[0];
  const downloadHandler = source.match(/VKIpc\.on\('internal-browser:download-blocked',[\s\S]*?\n\}\);/)?.[0];
  assert.ok(addressHandlers);
  assert.ok(stateHandler);
  assert.ok(downloadHandler);
  assert.match(source, /class="internal-browser-error" role="status"/);
  assert.match(source, /class="internal-browser-navigation-status" role="status"/);

  for (const [confirmedUrl, failureCode] of [
    ['', -105], ['https://example.com/confirmed', -105],
    ['', -102], ['https://example.com/confirmed', -102],
  ]) {
    const handlers = {};
    const messages = [];
    const channels = [];
    const downloadEvents = [];
    const addressError = { id: 'internal-browser-address-error', hidden: true, textContent: '' };
    const address = { value: '', addEventListener(type, handler) { handlers[type] = handler; },
      setAttribute() {}, removeAttribute() {} };
    let errorWrites = 0;
    const message = { value: '', get textContent() { return this.value; },
      set textContent(value) { this.value = value; errorWrites++; } };
    const failedExternal = { getAttribute() {}, setAttribute() {} };
    const errorView = { hidden: true, querySelector: selector => selector === '[data-action="external"]' ? failedExternal : message, querySelectorAll: () => [] };
    const notice = { hidden: true, dataset: {}, replaceChildren() {}, contains: () => false };
    const external = { setAttribute() {} };
    const target = { hidden: true, textContent: '' };
    const toastMessages = [];
    const toastBody = { replaceChildren() {}, append() {} };
    let navigationWrites = 0;
    const navigationStatus = { value: '', get textContent() { return this.value; },
      set textContent(value) { this.value = value; navigationWrites++; } };
    const elements = {
      '.internal-browser-url': address,
      '.internal-browser-address-error': addressError,
      '.internal-browser-error': errorView,
      '.internal-browser-notice': notice,
      '.internal-browser-toolbar [data-action="external"]': external,
      '.internal-browser-external-target': target,
      '.internal-browser-navigation-status': navigationStatus,
      '.internal-browser-toolbar [data-action="reload"]': {},
      '[data-action="back"]': {}, '[data-action="forward"]': {},
      '.internal-browser-progress': {},
    };
    const sidebar = { querySelector: selector => elements[selector] };
    let browser;
    let deferNextOpen = false;
    let deferredOpen = null;
    const context = vm.createContext({
      internalBrowserSidebar: sidebar,
      resolveBrowserAddress: require('../renderer/urlSafety').resolveBrowserAddress,
      VKIpc: {
        on: (channel, handler) => { handlers[channel] = handler; },
        invoke: (_channel, url, requestId) => {
          if (deferNextOpen) { deferredOpen = () => browser.navigate(url, false, requestId); deferNextOpen = false; }
          else browser.navigate(url, false, requestId);
          return Promise.resolve();
        },
      },
      showGenericToast(message) { toastMessages.push(message); return true; },
      externalUrlToastEl: { querySelector: () => toastBody },
      hideInternalBrowserContent: element => { element.hidden = true; },
      syncInternalBrowserLayout() {},
      document: { activeElement: null, createElement: () => ({}) }, URL,
    });
    vm.runInContext(`let internalBrowserUrl = ''; let internalBrowserPendingUrl = ''; let internalBrowserFailedUrl = ''; let internalBrowserDownloadUrl = ''; let internalBrowserAddressHasDraft = false; let internalBrowserHasPage = false; ${addressHandlers} ${stateHandler} ${downloadHandler}`, context);

    // main の publish をそのまま renderer に渡し、実際の pendingUrl 消去順を確認する。
    const browserSession = new EventEmitter();
    browserSession.setPermissionRequestHandler = () => {};
    browserSession.setPermissionCheckHandler = () => {};
    browserSession.webRequest = { onBeforeRequest() {}, onCompleted() {} };
    let contents;
    class FakeView {
      constructor() {
        contents = new EventEmitter();
        contents.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
        contents.isLoading = () => false;
        installBrowserLoad(contents);
        contents.setWindowOpenHandler = handler => { contents.openHandler = handler; };
        this.webContents = contents;
      }
    }
    browser = createInternalBrowser({
      isDestroyed: () => false,
      webContents: { send(channel, state) {
        channels.push(channel);
        if (channel === 'internal-browser:download-blocked') {
          downloadEvents.push(state);
          handlers[channel](state);
          return;
        }
        if (channel !== 'internal-browser:state') return;
        messages.push({ ...state });
        handlers[channel](state);
      } },
    }, { WebContentsView: FakeView, session: { fromPartition: () => browserSession },
      dialog: { showMessageBoxSync: () => 1 } });

    if (confirmedUrl) {
      browser.navigate(confirmedUrl);
      await contents.complete(confirmedUrl);
      assert.equal(address.value, confirmedUrl);
      assert.equal(elements['.internal-browser-toolbar [data-action="reload"]'].disabled, false);
    }
    navigationWrites = 0;
    const failedUrl = 'https://unreachable.example/path';
    address.value = failedUrl;
    handlers.input();
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    assert.equal(navigationWrites, 1);
    assert.equal(messages.at(-1).pendingUrl, failedUrl);
    assert.equal(messages.at(-1).navigationResult, null);
    assert.equal(messages.at(-1).navigationRequestId, 1);
    // 送信済みでも初回の HTTP(S) 文書確定前は main が reload を受け付けない。
    const reload = elements['.internal-browser-toolbar [data-action="reload"]'];
    assert.equal(reload.disabled, !confirmedUrl);
    if (!confirmedUrl) {
      assert.equal(vm.runInContext('internalBrowserHasPage', context), true);
      assert.equal(browser.action('reload'), false);
      await flushBrowserLoads();
      browser.publish();
      assert.equal(reload.disabled, true);
      assert.equal(messages.at(-1).navigationRequestId, 1);
      assert.equal(messages.at(-1).pendingUrl, failedUrl);
    }
    await contents.fail(failureCode, failedUrl);
    assert.equal(messages.at(-1).navigationResult, 'failed');
    assert.equal(messages.at(-1).navigationRequestId, 1);
    assert.equal(navigationStatus.textContent, '');
    assert.equal(navigationWrites, 2);
    assert.equal(errorView.hidden, false);
    assert.equal(message.textContent, 'ページを表示できませんでした（unreachable.example）');
    assert.equal(errorWrites, 1);
    browser.publish();
    assert.equal(navigationWrites, 2);
    assert.equal(errorWrites, 1);
    contents.emit('did-stop-loading');
    assert.equal(navigationWrites, 2);
    assert.equal(errorWrites, 1);
    assert.equal(messages.at(-1).pendingUrl, '');
    assert.equal(messages.at(-1).failedUrl, failedUrl);
    // 初回失敗でも失敗 URL を再試行できる。
    assert.equal(reload.disabled, false);
    assert.equal(messages.at(-1).url, confirmedUrl);
    assert.equal(address.value, failedUrl);
    assert.equal(handlers.blur, undefined);
    handlers.blur?.();
    assert.equal(address.value, failedUrl);

    address.value = '  ';
    handlers.input();
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(address.value, '  ');
    assert.equal(addressError.hidden, false);
    contents.emit('did-stop-loading');
    assert.equal(address.value, '  ');

    address.value = 'example.org/retry';
    handlers.input();
    handlers.blur?.();
    contents.emit('did-stop-loading');
    assert.equal(address.value, 'example.org/retry');
    deferNextOpen = true;
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    assert.equal(navigationWrites, 3);
    // 新しい invoke が main に届く前の古い失敗 state は今回の追跡を終えない。
    browser.publish();
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    assert.equal(navigationWrites, 3);
    assert.equal(vm.runInContext('internalBrowserActiveRequestId', context), 2);
    deferredOpen();
    assert.equal(messages.at(-1).pendingUrl, 'https://example.org/retry');
    assert.equal(messages.at(-1).navigationRequestId, 2);
    assert.equal(address.value, 'https://example.org/retry');
    assert.equal(reload.disabled, !confirmedUrl);
    if (!confirmedUrl) assert.equal(browser.action('reload'), false);
    await contents.complete('https://example.org/retry');
    assert.equal(messages.at(-1).navigationResult, 'completed');
    assert.equal(messages.at(-1).navigationRequestId, 2);
    assert.equal(address.value, 'https://example.org/retry');
    assert.equal(reload.disabled, false);
    assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');
    assert.equal(navigationWrites, 4);
    contents.emit('did-stop-loading');
    assert.equal(navigationWrites, 4);

    // 完了後の旧イベントはアドレス表示と通知を巻き戻さない。
    contents.emit('did-fail-load', {}, -105, 'old failure', failedUrl, true);
    contents.emit('did-navigate', {}, failedUrl);
    contents.emit('did-navigate-in-page', {}, `${failedUrl}#old`, true);
    browser.publish();
    assert.equal(address.value, 'https://example.org/retry');
    assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');
    assert.equal(navigationWrites, 4);

    // beforeunload でとどまる場合は pendingUrl が消えても完了にはしない。
    address.value = 'https://example.org/cancelled';
    handlers.input();
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(messages.at(-1).navigationResult, null);
    await flushBrowserLoads();
    contents.emit('will-prevent-unload', { preventDefault() { throw new Error('unexpected leave'); } });
    assert.equal(messages.at(-1).navigationResult, 'cancelled');
    assert.equal(messages.at(-1).navigationRequestId, 3);
    assert.equal(messages.at(-1).pendingUrl, '');
    assert.equal(navigationStatus.textContent, 'ページの移動を中止しました');
    assert.equal(navigationWrites, 6);
    contents.emit('did-stop-loading');
    assert.equal(navigationWrites, 6);

    contents.emit('did-fail-load', {}, -105, 'old failure', failedUrl, true);
    contents.emit('did-navigate', {}, failedUrl);
    contents.emit('did-navigate-in-page', {}, `${failedUrl}#old`, true);
    assert.equal(messages.at(-1).navigationResult, 'cancelled');
    assert.equal(navigationWrites, 6);

    // ダウンロード阻止も専用結果で終え、既存トースト用 IPC は維持する。
    address.value = 'https://example.org/download';
    handlers.input();
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(messages.at(-1).navigationResult, null);
    // 無関係なダウンロードは pending URL と読み込み中の案内を残す。
    await flushBrowserLoads();
    browserSession.emit('will-download', { preventDefault() {} },
      { getURLChain: () => ['https://example.org/other'] });
    assert.deepEqual(downloadEvents.at(-1), { canOpenFromToolbar: false });
    assert.equal(toastMessages.at(-1), 'ダウンロードはできません。外部ブラウザでダウンロードしてください。');
    assert.equal(target.textContent.includes('ダウンロード先'), false);
    assert.equal(messages.at(-1).pendingUrl, 'https://example.org/download');
    assert.equal(messages.at(-1).navigationResult, null);
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    let blockedToast = 0;
    await flushBrowserLoads();
    browserSession.emit('will-download', { preventDefault() { blockedToast++; } },
      { getURLChain: () => ['https://example.org/download'] });
    await contents.download();
    assert.equal(blockedToast, 1);
    assert.equal(channels.at(-2), 'internal-browser:state');
    assert.equal(channels.at(-1), 'internal-browser:download-blocked');
    assert.deepEqual(downloadEvents.at(-1), { canOpenFromToolbar: true });
    assert.equal(toastMessages.at(-1), 'ダウンロードはできません。操作列の「外部ブラウザで開く」から行ってください。');
    assert.equal(toastMessages.length, 2);
    assert.equal(target.textContent, '外部で開く: ダウンロード先 https://example.org/download');
    assert.equal(messages.at(-1).navigationResult, 'download-blocked');
    assert.equal(messages.at(-1).navigationRequestId, 4);
    assert.equal(messages.at(-1).pendingUrl, '');
    assert.equal(navigationStatus.textContent, '');
    assert.equal(navigationWrites, 8);
    browser.publish();
    assert.equal(navigationWrites, 8);
    assert.equal(toastMessages.length, 2);
    contents.emit('did-stop-loading');
    assert.equal(navigationWrites, 8);

    contents.emit('did-fail-load', {}, -105, 'old failure', failedUrl, true);
    contents.emit('did-navigate', {}, failedUrl);
    contents.emit('did-navigate-in-page', {}, `${failedUrl}#old`, true);
    assert.equal(messages.at(-1).navigationResult, 'download-blocked');
    assert.equal(target.textContent, '外部で開く: ダウンロード先 https://example.org/download');
    assert.equal(navigationWrites, 8);

    // 再読み込みも独立した世代で開始と完了を通知する。
    contents.reload = () => contents.startNative('https://example.org/retry', 'reload-initial');
    assert.equal(reload.disabled, false);
    assert.equal(browser.action('reload'), true);
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    contents.commitDocument('https://example.org/retry', 'reload-initial');
    contents.loadDocument('reload-initial');
    assert.equal(messages.at(-1).navigationRequestId, null);
    assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');
    assert.equal(navigationWrites, 10);
    // 相関のない旧失敗を現在の文書へ流用しない。
    contents.emit('did-fail-load', {}, -105, 'reload failed', 'https://example.org/retry', true);
    assert.equal(errorView.hidden, true);
    // Enter で始めたページ内遷移も、pending を残さず完了する。
    address.value = 'https://example.org/retry#next';
    handlers.input();
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(messages.at(-1).pendingUrl, 'https://example.org/retry#next');
    await contents.complete('https://example.org/retry#next');
    assert.equal(messages.at(-1).pendingUrl, '');
    assert.equal(messages.at(-1).navigationResult, 'completed');
    assert.equal(messages.at(-1).navigationRequestId, 5);
    assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');
    assert.equal(navigationWrites, 12);
    // 完了 state の再送も、次の Enter の結果としては消費しない。
    address.value = 'https://example.org/last';
    handlers.input();
    deferNextOpen = true;
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    const latestRequestId = vm.runInContext('internalBrowserActiveRequestId', context);
    browser.publish();
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    assert.equal(vm.runInContext('internalBrowserActiveRequestId', context), latestRequestId);
    deferredOpen();
    assert.equal(messages.at(-1).navigationRequestId, latestRequestId);
    await contents.complete('https://example.org/last');
    assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');
    assert.equal(vm.runInContext('internalBrowserActiveRequestId', context), null);
    // 連続 Enter では後の要求だけを追跡する。
    address.value = 'https://example.org/first-again';
    handlers.input();
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    const firstRequestId = vm.runInContext('internalBrowserActiveRequestId', context);
    const writesBeforeSecondEnter = navigationWrites;
    address.value = 'https://example.org/second-again';
    handlers.input();
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(vm.runInContext('internalBrowserActiveRequestId', context), firstRequestId + 1);
    assert.ok(messages.some(state => state.navigationRequestId === firstRequestId && state.navigationResult === 'superseded'));
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    assert.equal(navigationWrites, writesBeforeSecondEnter);
    assert.equal(messages.at(-1).navigationRequestId, firstRequestId + 1);
    // 旧要求の置換結果が遅れて再送されても、後続要求の読み込み通知を保持する。
    const supersededState = messages.find(state => state.navigationRequestId === firstRequestId && state.navigationResult === 'superseded');
    handlers['internal-browser:state'](supersededState);
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    assert.equal(navigationWrites, writesBeforeSecondEnter);
    assert.equal(vm.runInContext('internalBrowserActiveRequestId', context), firstRequestId + 1);
    await contents.complete('https://example.org/second-again');
    assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');

    // 各操作は旧要求を終了し、新しい世代の開始と結果を単一 live 経路へ送る。
    const startPending = suffix => {
      address.value = `https://example.org/${suffix}`;
      handlers.input();
      handlers.keydown({ key: 'Enter', preventDefault() {} });
      assert.equal(navigationStatus.textContent, 'ページを読み込み中');
      return vm.runInContext('internalBrowserActiveRequestId', context);
    };
    const assertSuperseded = requestId => {
      assert.ok(messages.some(state => state.navigationRequestId === requestId && state.navigationResult === 'superseded'));
      assert.equal(navigationStatus.textContent, 'ページを読み込み中');
      assert.equal(vm.runInContext('internalBrowserActiveRequestId', context), null);
      const writesAfterSupersede = navigationWrites;
      browser.publish();
      assert.equal(navigationStatus.textContent, 'ページを読み込み中');
      assert.equal(navigationWrites, writesAfterSupersede);
    };
    for (const action of ['back', 'forward', 'reload']) {
      const requestId = startPending(`pending-${action}`);
      contents.navigationHistory[`canGo${action[0].toUpperCase()}${action.slice(1)}`] = () => true;
      contents.navigationHistory[action === 'back' ? 'goBack' : 'goForward'] = () => {};
      if (action === 'reload') contents.reload = () => {};
      browser.action(action);
      assertSuperseded(requestId);
    }
    let requestId = startPending('pending-page-link');
    let blockedPageNavigation = false;
    contents.emit('will-navigate', { url: 'file:///tmp/blocked', preventDefault() { blockedPageNavigation = true; } });
    assert.equal(blockedPageNavigation, true);
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    contents.emit('will-navigate', { url: 'https://example.org/page-link', preventDefault() { throw new Error('unexpected block'); } });
    assertSuperseded(requestId);
    contents.emit('did-start-navigation', {}, 'https://example.org/page-link', false, true);
    assert.equal(messages.at(-1).navigationRequestId, null);
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');

    requestId = startPending('pending-window-open');
    contents.openHandler({ url: 'https://example.org/from-page' });
    assertSuperseded(requestId);
    assert.equal(messages.at(-1).navigationRequestId, null);
    await contents.complete('https://example.org/from-page');
    assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');

    requestId = startPending('pending-url-only');
    browser.navigate('https://example.org/url-only');
    assertSuperseded(requestId);
    assert.equal(messages.at(-1).navigationRequestId, null);
    await contents.complete('https://example.org/url-only');
    assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');

    // 戻る・進む・再読み込み・ページ起点・URL-onlyの開始と全終了結果を renderer まで検証する。
    for (const action of ['back', 'forward', 'reload', 'page', 'url-only']) {
      for (const result of ['completed', 'cancelled', 'failed']) {
        const requestId = startPending(`matrix-${action}-${result}`);
        await flushBrowserLoads();
        const writesBeforeReplacement = navigationWrites;
        const previousState = { ...messages.at(-1) };
        const targetUrl = `https://matrix.example/${action}/${result}`;
        if (action === 'url-only') browser.navigate(targetUrl);
        else if (action === 'page') contents.emit('will-navigate', { url: targetUrl });
        else browser.action(action);
        assert.ok(messages.some(state => state.navigationRequestId === requestId && state.navigationResult === 'superseded'));
        assert.equal(navigationStatus.textContent, 'ページを読み込み中');
        assert.equal(navigationWrites, writesBeforeReplacement + 2);
        const operation = messages.at(-1).navigationOperationId;
        assert.equal(messages.at(-1).navigationRequestId, null);
        if (action === 'url-only') {
          if (result === 'completed') await contents.complete(targetUrl);
          else await contents.fail(result === 'cancelled' ? -3 : -105, targetUrl);
        } else {
          contents.startNative(targetUrl, `matrix-${action}-${result}`);
          if (result === 'completed') {
            contents.commitDocument(targetUrl, `matrix-${action}-${result}`);
            contents.loadDocument(`matrix-${action}-${result}`);
          } else contents.debugger.emit('message', {}, 'Network.loadingFailed', {
            requestId: `request-matrix-${action}-${result}`, type: 'Document', canceled: result === 'cancelled', errorText: 'net::ERR_NAME_NOT_RESOLVED',
          });
        }
        assert.equal(messages.at(-1).navigationOperationId, operation);
        assert.equal(messages.at(-1).navigationResult, result);
        const expectedMessage = result === 'completed' ? 'ページの読み込みが完了しました'
          : result === 'cancelled' ? 'ページの移動を中止しました' : '';
        assert.equal(navigationStatus.textContent, expectedMessage);
        assert.equal(navigationWrites, writesBeforeReplacement + 3);
        if (result === 'failed') {
          assert.equal(errorView.hidden, false);
          assert.equal(message.textContent, 'ページを表示できませんでした（matrix.example）');
        }
        // 完了後の旧世代通知と同じ世代の再送は読み上げを増やさない。
        const writesAfterResult = navigationWrites;
        const errorWritesAfterResult = errorWrites;
        const finalAddress = address.value;
        handlers['internal-browser:state']({ ...previousState, navigationResult: 'failed', failedUrl: 'https://stale.example/failed' });
        browser.publish();
        assert.equal(navigationWrites, writesAfterResult);
        assert.equal(errorWrites, errorWritesAfterResult);
        assert.equal(address.value, finalAddress);
        assert.equal(navigationStatus.textContent, expectedMessage);
      }
    }

    // redirect の開始イベントだけでは同一 Enter 要求を置き換えない。
    requestId = startPending('redirect-source');
    contents.emit('did-start-navigation', {}, 'https://example.org/redirect-source', false, true);
    contents.emit('will-redirect', { url: 'https://example.org/redirect-target', preventDefault() { throw new Error('unexpected block'); } });
    contents.emit('did-start-navigation', {}, 'https://example.org/redirect-target', false, true);
    assert.equal(messages.at(-1).navigationRequestId, requestId);
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    await contents.complete('https://example.org/redirect-target');
    assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');

    // 失敗 URL の再読み込みは request ID なしで始まる。
    contents.emit('will-navigate', { url: 'https://example.org/failed-reload' });
    contents.emit('did-fail-load', {}, -105, 'failed', 'https://example.org/failed-reload', true);
    browser.action('reload');
    assert.equal(messages.at(-1).navigationRequestId, null);
    assert.equal(messages.at(-1).navigationResult, null);

    // main 受理前に古い結果や保留状態が再送されても、B の送信値を保持して再 Enter する。
    for (const [name, staleState] of [
      ['failed', { failedUrl: 'https://old.example/failed', navigationResult: 'failed' }],
      ['completed', { url: 'https://old.example/done', navigationResult: 'completed' }],
      ['superseded', { url: 'https://old.example/replaced', navigationResult: 'superseded' }],
      ['pending', { pendingUrl: 'https://old.example/pending', navigationResult: null }],
    ]) {
      const nextUrl = `https://new.example/${name}`;
      address.value = nextUrl;
      handlers.input();
      deferNextOpen = true;
      handlers.keydown({ key: 'Enter', preventDefault() {} });
      const firstId = vm.runInContext('internalBrowserActiveRequestId', context);
      handlers['internal-browser:state']({ url: 'https://old.example/', pendingUrl: '', failedUrl: '',
        downloadUrl: '', navigationRequestId: firstId - 1, loading: false, canGoBack: false, canGoForward: false,
        ...staleState });
      assert.equal(address.value, nextUrl);
      assert.equal(navigationStatus.textContent, 'ページを読み込み中');
      assert.equal(vm.runInContext('internalBrowserActiveRequestId', context), firstId);
      handlers.keydown({ key: 'Enter', preventDefault() {} });
      assert.equal(messages.at(-1).pendingUrl, nextUrl);
      assert.equal(messages.at(-1).navigationRequestId, firstId + 1);
      await contents.complete(nextUrl);
      assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');
    }
    // 持続トーストを守り、代替 live 通知は一配送につき一度だけ更新する。
    context.showGenericToast = () => false;
    for (const canOpenFromToolbar of [true, false]) {
      const writesBeforeFallback = navigationWrites;
      const toastsBeforeFallback = toastMessages.length;
      handlers['internal-browser:download-blocked']({ canOpenFromToolbar });
      assert.equal(navigationWrites, writesBeforeFallback + 1);
      assert.equal(toastMessages.length, toastsBeforeFallback);
      assert.equal(navigationStatus.textContent, canOpenFromToolbar
        ? 'ダウンロードはできません。操作列の「外部ブラウザで開く」から行ってください。'
        : 'ダウンロードはできません。外部ブラウザでダウンロードしてください。');
      startPending('after-fallback');
      assert.equal(navigationStatus.textContent, 'ページを読み込み中');
      await contents.complete('https://example.org/after-fallback');
      assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');
    }
  }
});
