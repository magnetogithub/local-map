const {test} = require('node:test');
const assert = require('node:assert/strict');
const {summarizeRequiredTurns} = require('./audit-current-frontiers.cjs');
const complete = () => [['PRK', 'KOR'], ['KOR', 'PRK'], ['PRK', 'CHN']].map(([actor, target]) =>
  ({actor, target, executed: true, completed: true, ok: true}));

test('all three required frontier targets must complete successfully', () => {
  assert.deepEqual(summarizeRequiredTurns(complete()), {
    required: 3, executed: 3, passed: 3, failed: 0, missingTargets: [], duplicateTargets: [], unexpected: [],
  });
});
test('missing frontier turn is a failure even when all existing records pass', () => {
  const turns = complete().slice(0, 2), result = summarizeRequiredTurns(turns);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.missingTargets, ['CHN']);
  assert.equal(summarizeRequiredTurns([]).failed, 3);
});
for (const failure of ['selection-failed', 'empty-selection', 'commit-failed', 'history-assertion-failed', 'not-executed']) {
  test(`${failure} cannot count as a successful required turn`, () => {
    const turns = complete();
    turns[2] = {...turns[2], executed: failure !== 'not-executed', completed: false, ok: false, error: failure};
    assert.equal(summarizeRequiredTurns(turns).passed, 2);
    assert.equal(summarizeRequiredTurns(turns).failed, 1);
  });
}
test('duplicate or unexpected records cannot replace a required target', () => {
  const turns = complete();
  assert.equal(summarizeRequiredTurns([...turns, turns[0]]).failed, 1);
  assert.equal(summarizeRequiredTurns([...turns, {...turns[0], target: 'USA'}]).failed, 1);
});
