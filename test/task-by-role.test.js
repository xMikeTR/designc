'use strict';
// A task row may carry `by_role`: the task's tokens split by the role that spent them (planner, test author, coder...),
// so Build shows where the spend went. Any pipeline: the role is the pipeline's own word. Display only.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const Ledger = require('../renderer/ledger.js');

const PY = path.join(__dirname, '..', 'python');
const skipPy = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';
const H = '20261016-9de366a9';
const ev = (kind, ts, f) => ({ kind, by: 'some-pipeline', _ts: ts, ...f });
const planner = { role: 'planner', turns: 1, tokens_in: 500, tokens_out: 50 };
const author = { role: 'test-author', turns: 2, tokens_in: 400, tokens_out: 40 };
const task = { kind: 'task', by: 'p', task: 'T-3', status: 'running', by_role: [planner, author] };

const bad = [
  [{ ...task, by_role: 'planner' }, /task\.by_role: must be a list/],
  [{ ...task, by_role: [3] }, /by_role\[0\]: must be an object/],
  [{ ...task, by_role: [{ ...planner, role: '' }] }, /by_role\[0\]\.role: must be a non-empty string/],
  [{ ...task, by_role: [planner, { ...author, turns: 1.5 }] }, /by_role\[1\]\.turns: must be a whole number of at least 0/],
  [{ ...task, by_role: [{ ...planner, tokens_in: -1 }] }, /by_role\[0\]\.tokens_in: must be a whole number of at least 0/],
  [{ ...task, by_role: [{ ...planner, tokens_out: undefined }] }, /by_role\[0\]\.tokens_out: must be a whole number of at least 0/],
  [{ ...task, by_role: [{ ...planner, cold: 1.5 }] }, /by_role\[0\]\.cold: must be a whole number of at least 0/],
  [{ ...task, by_role: [{ ...planner, cold: 2 }] }, /by_role\[0\]\.cold: cannot be more than turns/],
];

test('by_role is optional on a task, a list of role entries with whole-number turns and tokens', () => {
  assert.deepEqual(Ledger.validate({ ...task, by_role: undefined }), []);
  assert.deepEqual(Ledger.validate(task), []);
  assert.deepEqual(Ledger.validate({ ...task, by_role: [] }), []);
  for (const [e, re] of bad) assert.ok(Ledger.validate(e).some(x => re.test(x)), `${re} in ${Ledger.validate(e)}`);
});

test('python validates by_role with the same errors', { skip: skipPy }, () => {
  for (const e of [task, ...bad.map(b => b[0])]) {
    const clean = JSON.parse(JSON.stringify(e));
    const r = spawnSync('python3', ['-c', 'import json,sys; from designc.ledger import validate; print(json.dumps(validate(json.loads(sys.argv[1]))))', JSON.stringify(clean)], { cwd: PY, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), Ledger.validate(clean));
  }
});

test('Build Runs: each task carries its roles, and the run totals them per role', () => {
  const [run] = Ledger.liveRuns([
    ev('run_started', 100, { run: 'r1', handover: H }),
    ev('task', 110, { task: 'T-1', status: 'running', handover: H, run: 'r1', by_role: [planner] }),
    ev('task', 120, { task: 'T-1', status: 'passed', handover: H, run: 'r1', by_role: [planner, author] }),
    ev('task', 130, { task: 'T-2', status: 'running', handover: H, run: 'r1', by_role: [{ ...planner, turns: 0, tokens_in: 10, tokens_out: 10 }] }),
    ev('task', 140, { task: 'T-3', status: 'running', handover: H, run: 'r1' }),
  ], { now: 200 });
  assert.deepEqual(run.tasks.find(t => t.task === 'T-1').by_role, [planner, author]);
  assert.equal(run.tasks.find(t => t.task === 'T-3').by_role, null);
  assert.deepEqual(run.by_role, [
    { role: 'planner', turns: 1, tokens_in: 510, tokens_out: 60, tokens: 570, cold: 0 },
    { role: 'test-author', turns: 2, tokens_in: 400, tokens_out: 40, tokens: 440, cold: 0 },
  ]);
});

test('cold counts the turns whose prompt cache missed, optional per role, and the run sums it', () => {
  const warm = { ...author, cold: 1 };
  assert.deepEqual(Ledger.validate({ ...task, by_role: [planner, warm] }), []);
  const [run] = Ledger.liveRuns([
    ev('run_started', 100, { run: 'r1', handover: H }),
    ev('task', 110, { task: 'T-1', status: 'passed', handover: H, run: 'r1', by_role: [warm] }),
    ev('task', 120, { task: 'T-2', status: 'passed', handover: H, run: 'r1', by_role: [{ ...author, cold: 2 }] }),
    ev('task', 130, { task: 'T-3', status: 'passed', handover: H, run: 'r1', by_role: [planner] }),
  ], { now: 200 });
  assert.equal(run.by_role.find(r => r.role === 'test-author').cold, 3);
  assert.equal(run.by_role.find(r => r.role === 'planner').cold, 0);
});
