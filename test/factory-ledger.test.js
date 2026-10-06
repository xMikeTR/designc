// The factory eval kinds (suite_run, grader, suite_run_finished): what an eval harness run of System 2 leaves behind.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Ledger = require('../renderer/ledger.js');

const PY = path.join(__dirname, '..', 'python');
const skip = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';

const RUN = {
  kind: 'suite_run', by: 'harness', suite_run_id: 'run-1', suite: 's2-regression', harness_version: 'abc1234',
  model: 'claude-sonnet-5-5', prompt_version: 'p7', trials: 3,
  tasks: { 'S2-0001': { hash: '0123456789abcdef', gates: ['build', 'tests'], gradients: ['judge:test-gaming'] } },
};
const GRADER = { kind: 'grader', by: 'harness', suite_run_id: 'run-1', task_id: 'S2-0001', trial: 1, grader: 'build', verdict: 'pass' };
const DONE = { kind: 'suite_run_finished', by: 'harness', suite_run_id: 'run-1', outcome: 'completed' };

test('the three harness kinds validate and go to factory.jsonl', () => {
  for (const ev of [RUN, GRADER, DONE]) {
    assert.deepEqual(Ledger.validate(ev), [], ev.kind);
    assert.equal(Ledger.KINDS[ev.kind].stream, 'factory.jsonl');
  }
  assert.deepEqual(Ledger.validate({ ...GRADER, trace_id: 'lf-7c1e', judge_version: 'j2', rubric_hash: 'ffff', ms: 12, reason: 'x' }), []);
  assert.deepEqual(Ledger.validate({ ...RUN, configurator: 'laya' }), []);
});

test('each field is required and typed', () => {
  for (const [ev, fields] of [[RUN, ['suite_run_id', 'suite', 'harness_version', 'model', 'prompt_version', 'trials', 'tasks']],
    [GRADER, ['suite_run_id', 'task_id', 'trial', 'grader', 'verdict']], [DONE, ['suite_run_id', 'outcome']]]) {
    for (const f of fields) {
      const { [f]: _, ...rest } = ev;
      assert.ok(Ledger.validate(rest).some(e => e.includes(`${ev.kind}.${f}`)), `${ev.kind}.${f} should be required`);
    }
  }
  assert.ok(Ledger.validate({ ...GRADER, verdict: 'passed' }).length);
  assert.ok(Ledger.validate({ ...GRADER, trial: '1' }).length);
  assert.ok(Ledger.validate({ ...DONE, outcome: 'done' }).length);
});

test('a suite run states each task as a hash with at least one gate', () => {
  const bad = tasks => Ledger.validate({ ...RUN, tasks });
  assert.ok(bad([]).length);
  assert.ok(bad({}).length, 'a run with no tasks');
  assert.ok(bad({ 'S2-0001': { gates: ['build'], gradients: [] } }).length, 'no hash');
  assert.ok(bad({ 'S2-0001': { hash: 'x', gates: [], gradients: [] } }).length, 'no gate');
  assert.ok(bad({ 'S2-0001': { hash: 'x', gates: ['build'], gradients: 'judge' } }).length, 'gradients not a list');
  assert.ok(bad({ 'S2-0001': { hash: 'x', gates: ['build', 2] } }).length, 'a gate that is not a name');
  assert.deepEqual(bad({ 'S2-0001': { hash: 'x', gates: ['build'] } }), [], 'gradients may be left out');
  assert.ok(Ledger.validate({ ...RUN, trials: 0 }).length);
  assert.ok(Ledger.validate({ ...RUN, trials: 1.5 }).length);
});

test('an aborted run says why', () => {
  assert.ok(Ledger.validate({ ...DONE, outcome: 'aborted' }).length);
  assert.deepEqual(Ledger.validate({ ...DONE, outcome: 'aborted', reason: 'worktree pool exhausted' }), []);
});

test('the Python append path gives the same verdicts', { skip }, () => {
  const cases = [RUN, GRADER, DONE, { ...DONE, outcome: 'aborted' }, { ...RUN, tasks: {} }, { ...RUN, trials: 1.5 },
    { ...RUN, tasks: { a: { hash: 'x', gates: [] } } }, { ...GRADER, verdict: 'ok' }];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-factory-'));
  for (const ev of cases) {
    const r = spawnSync('python3', ['-c', 'import json,sys; from designc.ledger import validate; print(json.dumps(validate(json.loads(sys.argv[1]))))', JSON.stringify(ev)], { cwd: PY, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), Ledger.validate(ev), JSON.stringify(ev));
  }
  fs.rmSync(root, { recursive: true, force: true });
});
