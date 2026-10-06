// Ledger.suiteCompare: each suite run against the latest earlier run of the same suite on a different harness_version,
// task by task and only where the eval task's hash is unchanged, so a score move is never an artefact of an edited task.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../renderer/ledger.js');

let t = 0;
const at = e => ({ ...e, by: 'h', event_id: `e${++t}`, _ts: ++t });
const run = (id, harness_version, tasks, over = {}) => at({ kind: 'suite_run', suite_run_id: id, suite: 's2', harness_version, model: 'm', prompt_version: 'p', trials: 2,
  tasks: Object.fromEntries(Object.entries(tasks).map(([k, hash]) => [k, { hash, gates: ['build'] }])), ...over });
const g = (id, task_id, trial, verdict) => at({ kind: 'grader', suite_run_id: id, task_id, trial, grader: 'build', verdict });
// Both trials of a task: 'pp' passes twice, 'pf' once, 'ff' never.
const score = (id, task, s) => [g(id, task, 1, s[0] === 'p' ? 'pass' : 'fail'), g(id, task, 2, s[1] === 'p' ? 'pass' : 'fail')];
const cmp = evs => Ledger.suiteCompare(Ledger.suiteRuns(evs, { k: 2 }));

test('a run is compared with the latest earlier run on a different harness version, task by task', () => {
  const c = cmp([run('a', 'v1', { A: 'ha', B: 'hb' }), ...score('a', 'A', 'pf'), ...score('a', 'B', 'ff'),
    run('b', 'v2', { A: 'ha', B: 'hb' }), ...score('b', 'A', 'pp'), ...score('b', 'B', 'pf')]);
  assert.equal(c.get('a').baseline, null, 'the first version has nothing to compare with');
  const b = c.get('b');
  assert.equal(b.baseline, 'a');
  assert.equal(b.compared, 2);
  assert.equal(b.tasks.A.status, 'compared');
  assert.equal(b.tasks.A.passAt1, 0.5);
  assert.equal(b.tasks.A.passK, 0.75, '1 - 0.25');
  assert.equal(b.passAt1, 0.5, 'mean of the task deltas');
  assert.equal(b.passK, 0.5);
});

test('a run on the same harness version is a repeat and is not used as a baseline', () => {
  const c = cmp([run('a', 'v1', { A: 'ha' }), ...score('a', 'A', 'ff'), run('b', 'v2', { A: 'ha' }), ...score('b', 'A', 'pf'),
    run('c', 'v2', { A: 'ha' }), ...score('c', 'A', 'pp')]);
  assert.equal(c.get('b').repeatOf, null);
  assert.equal(c.get('c').repeatOf, 'b');
  assert.equal(c.get('c').baseline, 'a', 'still compared with the previous version, not its own repeat');
  assert.equal(c.get('c').passAt1, 1);
});

test('only tasks with the same hash are compared; edited, new and dropped tasks are named', () => {
  const c = cmp([run('a', 'v1', { A: 'ha', B: 'hb', D: 'hd' }), ...score('a', 'A', 'pp'), ...score('a', 'B', 'pp'), ...score('a', 'D', 'pp'),
    run('b', 'v2', { A: 'ha', B: 'hb2', C: 'hc' }), ...score('b', 'A', 'pf'), ...score('b', 'B', 'ff'), ...score('b', 'C', 'ff')]);
  const b = c.get('b');
  assert.equal(b.tasks.A.status, 'compared');
  assert.equal(b.tasks.B.status, 'changed');
  assert.equal(b.tasks.B.passAt1, undefined, 'an edited task is not scored against its old version');
  assert.equal(b.tasks.C.status, 'new');
  assert.deepEqual(b.dropped, ['D']);
  assert.equal(b.compared, 1);
  assert.equal(b.passAt1, -0.5, 'only A counts');
});

test('a task with no judged trial on either side is unscored; with nothing comparable the run has no delta', () => {
  const c = cmp([run('a', 'v1', { A: 'ha', B: 'hb' }), ...score('a', 'A', 'pp'),
    run('b', 'v2', { A: 'ha', B: 'hb' }), ...score('b', 'B', 'pp')]);
  const b = c.get('b');
  assert.equal(b.tasks.A.status, 'unscored');
  assert.equal(b.tasks.B.status, 'unscored');
  assert.equal(b.compared, 0);
  assert.equal(b.passAt1, null);
  assert.equal(b.passK, null);
});

test('a baseline must have a score, and suites are never compared with each other', () => {
  const c = cmp([run('a', 'v1', { A: 'ha' }), ...score('a', 'A', 'pf'), run('x', 'v0', { A: 'ha' }, { suite: 'other' }), ...score('x', 'A', 'pp'),
    run('b', 'v2', { A: 'ha' }), run('c', 'v3', { A: 'ha' }), ...score('c', 'A', 'pp')]);
  assert.equal(c.get('c').baseline, 'a', 'b has no judged trial; x is another suite');
  assert.equal(c.get('x').baseline, null);
});
