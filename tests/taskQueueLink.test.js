'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveQueueIssueUrl, resolveQueueIssuesListUrl } = require('../renderer/taskQueueLink');

test('resolveQueueIssueUrl: GitHub モードの http(s) issue URL はそのまま返す', () => {
  assert.equal(
    resolveQueueIssueUrl('https://github.com/vektor-inc/vk-orchestrator/issues/177'),
    'https://github.com/vektor-inc/vk-orchestrator/issues/177',
  );
  assert.equal(
    resolveQueueIssueUrl('http://example.com/issues/1'),
    'http://example.com/issues/1',
  );
});

test('resolveQueueIssueUrl: 前後の空白はトリムして返す', () => {
  assert.equal(
    resolveQueueIssueUrl('  https://github.com/a/b/issues/1  '),
    'https://github.com/a/b/issues/1',
  );
});

test('resolveQueueIssueUrl: ローカルモードの local:// URL は保持しない（undefined）', () => {
  assert.equal(resolveQueueIssueUrl('local://queue/abc123'), undefined);
});

test('resolveQueueIssueUrl: http(s) 以外・不正値は undefined', () => {
  assert.equal(resolveQueueIssueUrl(''), undefined);
  assert.equal(resolveQueueIssueUrl('   '), undefined);
  assert.equal(resolveQueueIssueUrl('javascript:alert(1)'), undefined);
  assert.equal(resolveQueueIssueUrl('file:///etc/passwd'), undefined);
  assert.equal(resolveQueueIssueUrl('not a url'), undefined);
  assert.equal(resolveQueueIssueUrl(undefined), undefined);
  assert.equal(resolveQueueIssueUrl(null), undefined);
  assert.equal(resolveQueueIssueUrl(12345), undefined);
});

test('resolveQueueIssueUrl: 2048 文字を超える URL は保持しない', () => {
  const longUrl = 'https://github.com/a/b/issues/1?x=' + 'a'.repeat(2048);
  assert.equal(resolveQueueIssueUrl(longUrl), undefined);
});

test('resolveQueueIssuesListUrl: 個別 issue URL から /N を落として一覧 URL を返す', () => {
  assert.equal(
    resolveQueueIssuesListUrl('https://github.com/vektor-inc/vk-orchestrator/issues/480'),
    'https://github.com/vektor-inc/vk-orchestrator/issues',
  );
  assert.equal(
    resolveQueueIssuesListUrl('http://example.com/a/b/issues/1'),
    'http://example.com/a/b/issues',
  );
});

test('resolveQueueIssuesListUrl: 前後空白・末尾スラッシュ・クエリ/ハッシュを正規化する', () => {
  assert.equal(
    resolveQueueIssuesListUrl('  https://github.com/a/b/issues/480/  '),
    'https://github.com/a/b/issues',
  );
  assert.equal(
    resolveQueueIssuesListUrl('https://github.com/a/b/issues/480?foo=bar#c'),
    'https://github.com/a/b/issues',
  );
});

test('resolveQueueIssuesListUrl: ローカルモードの local:// は undefined', () => {
  assert.equal(resolveQueueIssuesListUrl('local://queue/abc123'), undefined);
});

test('resolveQueueIssuesListUrl: /issues/N 形式でないパスは一覧化しない（undefined）', () => {
  // pull request の URL は issue 一覧化しない。
  assert.equal(resolveQueueIssuesListUrl('https://github.com/a/b/pull/480'), undefined);
  // issue 一覧そのもの（番号なし）は /N が無いので一覧化対象外。
  assert.equal(resolveQueueIssuesListUrl('https://github.com/a/b/issues'), undefined);
  // 番号部分が数字でない。
  assert.equal(resolveQueueIssuesListUrl('https://github.com/a/b/issues/new'), undefined);
  // issues セグメントが無い。
  assert.equal(resolveQueueIssuesListUrl('https://github.com/a/b/480'), undefined);
});

test('resolveQueueIssuesListUrl: http(s) 以外・不正値は undefined', () => {
  assert.equal(resolveQueueIssuesListUrl(''), undefined);
  assert.equal(resolveQueueIssuesListUrl('   '), undefined);
  assert.equal(resolveQueueIssuesListUrl('javascript:alert(1)'), undefined);
  assert.equal(resolveQueueIssuesListUrl('file:///etc/passwd'), undefined);
  assert.equal(resolveQueueIssuesListUrl('not a url'), undefined);
  assert.equal(resolveQueueIssuesListUrl(undefined), undefined);
  assert.equal(resolveQueueIssuesListUrl(null), undefined);
  assert.equal(resolveQueueIssuesListUrl(12345), undefined);
});

test('resolveQueueIssuesListUrl: 2048 文字を超える URL は undefined', () => {
  const longUrl = 'https://github.com/a/b/issues/1?x=' + 'a'.repeat(2048);
  assert.equal(resolveQueueIssuesListUrl(longUrl), undefined);
});
