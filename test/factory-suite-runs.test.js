// Ledger.suiteRuns: a trial's outcome derived from the gate graders its suite run pinned, and pass@1 / pass^k per task and run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../renderer/ledger.js');

let t = 0;
const at = e => ({ ...e, by: 'h', event_id: `e${++t}`, _ts: t });
const run = (over = {}) => at({ kind: 'suite_run', suite_run_id: 'r1', suite: 's2-regression', harness_version: 'v1', model: 'm', prompt_version: 'p1', trials: 2,
  tasks: { A: { hash: 'ha', gates: ['build', 'tests'], gradients: ['judge:gaming'] }, B: { hash: 'hb', gates: ['build'] } }, ...over });
const g = (task_id, trial, grader, verdict, over = {}) => at({ kind: 'grader', suite_run_id: 'r1', task_id, trial, grader, verdict, ...over });
const done = (outcome = 'completed') => at({ kind: 'suite_run_finished', suite_run_id: 'r1', outcome, ...(outcome === 'aborted' ? { reason: 'x' } : {}) });
const task = (r, id) => r.tasks.find(x => x.task_id === id);
const trial = (r, id, n) => task(r, id).trials.find(x => x.trial === n);

test('a trial passes when every gate passes, and fails as soon as one gate fails', () => {
  const [r] = Ledger.suiteRuns([run(), g('A', 1, 'build', 'pass'), g('A', 1, 'tests', 'pass'), g('A', 2, 'build', 'fail'), g('B', 1, 'build', 'pass')]);
  assert.equal(trial(r, 'A', 1).outcome, 'pass');
  assert.equal(trial(r, 'A', 2).outcome, 'fail', 'fails before tests have reported');
  assert.equal(trial(r, 'B', 1).outcome, 'pass');
  assert.equal(trial(r, 'B', 2).outcome, 'incomplete', 'no events yet');
  assert.equal(r.status, 'running');
});

test('gradients never decide a trial', () => {
  const [r] = Ledger.suiteRuns([run(), g('A', 1, 'build', 'pass'), g('A', 1, 'tests', 'pass'), g('A', 1, 'judge:gaming', 'fail')]);
  assert.equal(trial(r, 'A', 1).outcome, 'pass');
  assert.deepEqual(trial(r, 'A', 1).gradients, { 'judge:gaming': 'fail' });
});

test('once the run has finished, a trial still missing a gate is a harness failure, not an agent failure', () => {
  const [r] = Ledger.suiteRuns([run(), g('A', 1, 'build', 'pass'), g('A', 1, 'tests', 'unknown'), g('A', 2, 'build', 'pass'), done()]);
  assert.equal(trial(r, 'A', 1).outcome, 'harness', 'an unknown gate with no fail');
  assert.equal(trial(r, 'A', 2).outcome, 'harness', 'tests never reported');
  assert.equal(trial(r, 'B', 1).outcome, 'harness');
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.counts, { pass: 0, fail: 0, incomplete: 0, harness: 4 });
});

test('gate events after the run finished are ignored; late gradients still count', () => {
  const [r] = Ledger.suiteRuns([run(), g('A', 1, 'build', 'pass'), done('aborted'), g('A', 1, 'tests', 'pass'), g('A', 1, 'judge:gaming', 'pass')]);
  assert.equal(trial(r, 'A', 1).outcome, 'harness');
  assert.equal(trial(r, 'A', 1).gates.tests, undefined);
  assert.equal(trial(r, 'A', 1).gradients['judge:gaming'], 'pass');
  assert.equal(r.status, 'aborted');
  assert.equal(r.finished.reason, 'x');
});

test('the latest event for a grader wins', () => {
  const [r] = Ledger.suiteRuns([run(), g('B', 1, 'build', 'fail'), g('B', 1, 'build', 'pass')]);
  assert.equal(trial(r, 'B', 1).outcome, 'pass');
});

test('events for an undeclared task, trial or grader are counted as stray and judge nothing', () => {
  const [r] = Ledger.suiteRuns([run(), g('C', 1, 'build', 'pass'), g('B', 3, 'build', 'pass'), g('B', 1, 'lint', 'fail'), g('B', 1, 'build', 'pass')]);
  assert.equal(r.stray, 3);
  assert.equal(trial(r, 'B', 1).outcome, 'pass');
  assert.equal(task(r, 'C'), undefined);
});

test('pass@1 counts only judged trials; pass^k is its k-th power; every-trial-passed is shown beside it', () => {
  const evs = [run({ trials: 4 }), ...[1, 2, 3].map(n => g('B', n, 'build', 'pass')), g('B', 4, 'build', 'fail'),
    ...[1, 2, 3, 4].map(n => g('A', n, 'build', 'pass')), ...[1, 2, 3, 4].map(n => g('A', n, 'tests', 'pass')), done()];
  const [r] = Ledger.suiteRuns(evs, { k: 3 });
  assert.equal(task(r, 'B').passAt1, 0.75);
  assert.ok(Math.abs(task(r, 'B').passK - 0.421875) < 1e-9);
  assert.equal(task(r, 'B').allPassed, false);
  assert.equal(task(r, 'A').passAt1, 1);
  assert.equal(task(r, 'A').allPassed, true);
  assert.equal(r.k, 3);
  assert.equal(r.passAt1, 0.875, 'mean over tasks');
  assert.ok(Math.abs(r.passK - (1 + 0.421875) / 2) < 1e-9);
  assert.equal(r.allPassed, 1, 'tasks with every trial passed');
});

test('a task with no judged trial has no score and is left out of the run mean', () => {
  const [r] = Ledger.suiteRuns([run(), g('B', 1, 'build', 'pass'), done()]);
  assert.equal(task(r, 'A').passAt1, null);
  assert.equal(task(r, 'A').passK, null);
  assert.equal(r.passAt1, 1);
  const [empty] = Ledger.suiteRuns([run()]);
  assert.equal(empty.passAt1, null);
});

test('runs keep their versions; a repeated suite_run_id keeps the first; sample events are ignored', () => {
  const evs = [run(), run({ harness_version: 'other' }), at({ ...run({ suite_run_id: 'r2' }), sample: true }),
    at({ kind: 'suite_run', suite_run_id: 'r3', suite: 's', harness_version: 'v2', model: 'm', prompt_version: 'p2', trials: 1, configurator: 'laya', tasks: { A: { hash: 'h', gates: ['build'] } } })];
  const rs = Ledger.suiteRuns(evs);
  assert.deepEqual(rs.map(r => r.suite_run_id), ['r1', 'r3']);
  assert.equal(rs[0].harness_version, 'v1');
  assert.equal(rs[1].configurator, 'laya');
  assert.equal(rs[1].started, evs[3]._ts);
});
