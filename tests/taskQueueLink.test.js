'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveQueueIssueUrl } = require('../renderer/taskQueueLink');

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
