// Eval tasks (factory/tasks/*.yaml): minted -> checked -> bound -> retired. A human binds, which appends
// factory_task_bound and pins the file's hash; editing the file afterwards makes it "changed" until re-bound.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../renderer/ledger.js');
const Policy = require('../renderer/policy.js');

let t = 0;
const at = e => ({ ...e, by: 'mike', event_id: `e${++t}`, _ts: ++t });
const bound = (task_id, hash) => at({ kind: 'factory_task_bound', task_id, hash });
const task = (id, over = {}) => ({ id, title: `Task ${id}`, status: 'minted', hash: `h-${id}`, source: { failure_mode: 'FM-01' }, ...over });
const rows = (events, tasks, extra = {}) => Ledger.factoryTasks(events, { tasks, ...extra });
const by = (r, id) => r.tasks.find(x => x.id === id);

test('factory_task_bound validates and goes to factory.jsonl', () => {
  assert.equal(Ledger.KINDS.factory_task_bound.stream, 'factory.jsonl');
  const ok = { schema_version: 1, event_id: 'x', ts: 1, by: 'mike', kind: 'factory_task_bound', task_id: 'S2-0001', hash: 'abc' };
  assert.deepEqual(Ledger.validate(ok), []);
  assert.ok(Ledger.validate({ ...ok, hash: '' }).length || Ledger.validate({ ...ok, hash: undefined }).length);
  assert.ok(Ledger.validate({ ...ok, task_id: undefined }).length);
});

test('status comes from the file until a bind matches its hash; then bound; an edit makes it changed', () => {
  const r = rows([bound('A', 'h-A'), bound('B', 'old')], [task('A'), task('B'), task('C', { status: 'checked' }), task('D', { status: 'retired' })]);
  assert.equal(by(r, 'A').status, 'bound');
  assert.equal(by(r, 'B').status, 'changed', 'edited since it was bound');
  assert.equal(by(r, 'B').boundHash, 'old');
  assert.equal(by(r, 'C').status, 'checked');
  assert.equal(by(r, 'D').status, 'retired');
  assert.equal(by(r, 'D').bindable, false);
});

test('the latest bind wins, so re-binding after an edit makes it bound again', () => {
  const r = rows([bound('A', 'old'), bound('A', 'h-A')], [task('A')]);
  assert.equal(by(r, 'A').status, 'bound');
});

test('a task with no failure mode cannot be bound; an unknown mode is a warning only', () => {
  const r = rows([], [task('A', { source: {} }), task('B', { source: { failure_mode: 'FM-99' } }), task('C')], { taxonomy: { modes: [{ id: 'FM-01', name: 'x' }] } });
  assert.equal(by(r, 'A').bindable, false);
  assert.match(by(r, 'A').bindProblem, /failure mode/);
  assert.equal(by(r, 'B').bindable, true);
  assert.match(by(r, 'B').warnings[0], /FM-99/);
  assert.equal(by(r, 'C').bindable, true);
  assert.deepEqual(by(r, 'C').warnings, []);
});

test('a bind with no failure mode is refused even for a task already bound by hand-written events', () => {
  assert.equal(Ledger.taskBindProblem(task('A', { source: null })) !== null, true);
  assert.equal(Ledger.taskBindProblem(task('A')), null);
});

test('invalid statuses and repeated ids are reported, not thrown', () => {
  const r = rows([], [task('A', { status: 'bound' }), task('A'), task('B', { status: 'weird' }), { title: 'no id', hash: 'h' }]);
  assert.equal(by(r, 'A').status, 'invalid', 'bound is never written in a file');
  assert.match(by(r, 'A').problems[0], /bound/);
  assert.equal(r.tasks.filter(x => x.id === 'A').length, 1);
  assert.ok(r.problems.some(p => /A is listed more than once/.test(p)));
  assert.match(by(r, 'B').problems[0], /status/);
  assert.ok(r.problems.some(p => /needs an id/.test(p)));
});

test('suite runs that used a different definition of a bound task are named', () => {
  const runs = [
    { suite_run_id: 'r1', tasks: [{ task_id: 'A', hash: 'h-A' }, { task_id: 'B', hash: 'h-B' }] },
    { suite_run_id: 'r2', tasks: [{ task_id: 'A', hash: 'other' }, { task_id: 'B', hash: 'h-B' }] },
  ];
  const r = rows([bound('A', 'h-A'), bound('B', 'h-B')], [task('A'), task('B')], { runs });
  assert.deepEqual(by(r, 'A').offDefinition, ['r2']);
  assert.deepEqual(by(r, 'B').offDefinition, []);
  assert.deepEqual(by(r, 'A').runs, ['r1', 'r2']);
});

test('the Analyst may write factory/tasks yaml but a task is never written as bound', () => {
  const yaml = s => JSON.parse(s);
  assert.equal(Policy.writeVerdict('analyst', 'factory/tasks/S2-0001.yaml', '{"id":"S2-0001","status":"minted"}', yaml).ok, true);
  assert.equal(Policy.writeVerdict('analyst', 'factory/tasks/S2-0001.yaml', '{"id":"S2-0001","status":"bound"}', yaml).ok, false);
  assert.equal(Policy.writeVerdict('analyst', 'factory/tasks/S2-0001.yaml', '{"id":"S2-0001","status":"minted","bound_by":"x"}', yaml).ok, false);
  assert.equal(Policy.writeVerdict('analyst', 'factory/tasks/x.txt', '{}', yaml).ok, false);
  assert.equal(Policy.writeVerdict('analyst', 'factory/taxonomy.yaml', '{}', yaml).ok, false, 'the taxonomy is a human file');
  assert.equal(Policy.writeVerdict('architect', 'factory/tasks/S2-0001.yaml', '{"id":"x"}', yaml).ok, false);
});
