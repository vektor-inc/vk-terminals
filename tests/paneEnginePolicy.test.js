const test = require('node:test');
const assert = require('node:assert/strict');
const { withInheritedEngine } = require('../renderer/paneEnginePolicy');

for (const [initialEngine, automatedEngine] of [['claude', 'codex'], ['codex', 'claude']]) {
  test(`既定 ${initialEngine}・自動 ${automatedEngine} からの手動追加は既定エンジンを使う`, () => {
    const result = withInheritedEngine({ noClaude: false }, { engine: automatedEngine, createdByAutomation: true }, initialEngine, 'gpt-5.5');
    assert.equal(result.engine || 'claude', initialEngine);
    assert.equal(result.noClaude, false);
    assert.equal(result.model, initialEngine === 'codex' ? 'gpt-5.5' : undefined);
  });
}

test('通常の手動ペインからは追加・分割でエンジンを引き継ぐ', () => {
  assert.deepEqual(withInheritedEngine({ noClaude: true }, { engine: 'codex', createdByAutomation: false }, 'claude', ''), { noClaude: true, engine: 'codex' });
  assert.deepEqual(withInheritedEngine({}, { engine: 'claude' }, 'codex', 'gpt-5.5'), { engine: 'claude' });
});
