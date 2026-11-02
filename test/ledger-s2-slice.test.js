'use strict';
// Slice 1b (intelligence plane): task.cause, the trace and outcome kinds, escape.ref/run, and Ledger.taskOutcomes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../renderer/ledger.js');

const base = { schema_version: 1, by: 'pipeline' };
const task = (o = {}) => ({ ...base, kind: 'task', task: 'T-1', status: 'failed', ...o });
const trace = (o = {}) => ({ ...base, kind: 'trace', run: 'R1', task: 'T-1', outcome: 'passed', bundle_id: null, models: ['claude-sonnet'], procedures: [], tokens_in: 100, tokens_out: 20, ...o });
const outcome = (o = {}) => ({ ...base, kind: 'outcome', run: 'R1', cause: 'ci_failed', ref: { kind: 'ci', id: 'build-42' }, ...o });
const errs = ev => Ledger.validate(ev);

test('task.cause is optional and must fit the status', () => {
  assert.deepEqual(errs(task()), []);
  assert.deepEqual(errs(task({ cause: 'stalled' })), []);
  assert.deepEqual(errs(task({ cause: 'abandoned' })), []);
  assert.deepEqual(errs(task({ status: 'blocked', cause: 'parked' })), []);
  assert.deepEqual(errs(task({ cause: 'gate_failed:unit-tests' })), []);
  assert.deepEqual(errs(task({ status: 'blocked', cause: 'gate_failed:lint' })), []);
  assert.match(errs(task({ status: 'passed', cause: 'stalled' })).join(), /cause: stalled needs status failed/);
  assert.match(errs(task({ cause: 'parked' })).join(), /cause: parked needs status blocked/);
  assert.match(errs(task({ status: 'passed', cause: 'gate_failed:x' })).join(), /gate_failed needs status failed or blocked/);
  assert.match(errs(task({ cause: 'gate_failed:' })).join(), /cause: must be stalled, abandoned, parked or gate_failed:<gate>/);
  assert.match(errs(task({ cause: 'gate_failed:Bad Gate' })).join(), /cause: must be/);
  assert.match(errs(task({ cause: 'oops' })).join(), /cause: must be/);
});

test('trace: one row per run and task, with bundle, models, procedures and tokens', () => {
  assert.deepEqual(errs(trace()), []);
  assert.deepEqual(errs(trace({ outcome: 'failed', cause: 'stalled', bundle_id: 'sha256:ab', trace_id: 't', jira: 'ABC-1', cost: 0.2,
    procedures: [{ id: 'proc-a', version: '3', hash: 'h1' }] })), []);
  for (const f of ['run', 'task', 'outcome', 'bundle_id', 'models', 'procedures', 'tokens_in', 'tokens_out']) {
    const ev = trace(); delete ev[f];
    assert.match(errs(ev).join(), new RegExp(`trace\\.${f}: required`), f);
  }
  assert.match(errs(trace({ outcome: 'running' })).join(), /outcome: must be one of passed\|failed\|blocked/);
  assert.match(errs(trace({ outcome: 'passed', cause: 'stalled' })).join(), /cause: stalled needs status failed/);
  assert.match(errs(trace({ bundle_id: 3 })).join(), /bundle_id: must be a string or null/);
  assert.match(errs(trace({ models: ['', 'x'] })).join(), /models\[0\]: must be a non-empty string/);
  assert.match(errs(trace({ procedures: [{ id: 'p', version: '1' }] })).join(), /procedures\[0\]: must be \{id, version, hash\}/);
  assert.match(errs(trace({ tokens_in: 1.5 })).join(), /tokens_in: must be a whole number of at least 0/);
  assert.match(errs(trace({ extra: 1 })).join(), /extra: unknown field/);
});

test('outcome: a later verdict on a run or one task, with a reference', () => {
  assert.deepEqual(errs(outcome()), []);
  assert.deepEqual(errs(outcome({ task: 'T-1', cause: 'qa_failed', ref: { kind: 'qa', id: 'QA-9' }, commit: 'abc' })), []);
  assert.match(errs(outcome({ cause: 'flaky' })).join(), /cause: must be one of ci_failed\|qa_failed\|integration_failed\|integration_unrunnable\|parity_failed/);
  assert.match(errs(outcome({ ref: { kind: 'jira', id: 'X-1' } })).join(), /ref: must be \{kind: ci\|qa\|parity\|integration, id\}/);
  assert.match(errs(outcome({ ref: { kind: 'ci', id: '' } })).join(), /ref: must be/);
  const noRef = outcome(); delete noRef.ref;
  assert.match(errs(noRef).join(), /outcome\.ref: required/);
});

test('escape may carry a jira ref and a run', () => {
  const esc = { ...base, kind: 'escape', id: 'E-1', description: 'd' };
  assert.deepEqual(errs({ ...esc, ref: { kind: 'jira', id: 'ABC-2' }, run: 'R1' }), []);
  assert.match(errs({ ...esc, ref: { kind: 'ci', id: 'x' } }).join(), /ref: must be \{kind: jira, id\}/);
  assert.match(errs({ ...esc, run: 3 }).join(), /run: must be a string/);
});

test('trace and outcome are pipeline kinds written to pipeline.jsonl', () => {
  for (const k of ['trace', 'outcome']) {
    assert.ok(Ledger.PIPELINE_KINDS.includes(k), k);
    assert.equal(Ledger.KINDS[k].stream, 'pipeline.jsonl');
  }
});

// Events as Ledger.order gives them: oldest first.
const stamp = evs => evs.map((e, i) => ({ ...e, event_id: `e${i}`, _ts: i + 1 }));

test('taskOutcomes: latest trace per run and task; later outcome decides the cause; success needs delivery', () => {
  const evs = stamp([
    { ...base, kind: 'run_started', run: 'R1', handover: 'H1' },
    trace({ outcome: 'failed', cause: 'stalled', tokens_in: 10 }),
    trace({ tokens_in: 50 }),
    trace({ task: 'T-2', tokens_in: 5 }),
    trace({ run: 'R2', task: 'T-3', outcome: 'blocked', cause: 'parked' }),
    { ...base, kind: 'handover_closed', handover: 'H1', outcome: 'delivered' },
  ]);
  const rows = Ledger.taskOutcomes(evs);
  assert.deepEqual(rows.map(r => `${r.run}/${r.task}`), ['R1/T-1', 'R1/T-2', 'R2/T-3']);
  const t1 = rows[0];
  assert.equal(t1.outcome, 'passed');
  assert.equal(t1.cause, null);
  assert.equal(t1.tokens_in, 50);
  assert.equal(t1.handover, 'H1');
  assert.equal(t1.delivered, true);
  assert.equal(t1.success, true);
  assert.equal(rows[2].cause, 'parked');
  assert.equal(rows[2].final, false, 'blocked is not final');
  assert.equal(rows[2].success, false);

  const later = Ledger.taskOutcomes(stamp([
    { ...base, kind: 'run_started', run: 'R1', handover: 'H1' },
    outcome({ cause: 'qa_failed', ref: { kind: 'qa', id: 'early' } }),
    trace(),
    trace({ task: 'T-2' }),
    outcome({ task: 'T-2', cause: 'parity_failed', ref: { kind: 'parity', id: 'tags-list' } }),
    { ...base, kind: 'handover_closed', handover: 'H1', outcome: 'delivered' },
  ]));
  assert.equal(later[0].cause, null, 'an outcome before the trace row does not count');
  assert.equal(later[0].success, true);
  assert.equal(later[1].cause, 'parity_failed');
  assert.deepEqual(later[1].ref, { kind: 'parity', id: 'tags-list' });
  assert.equal(later[1].success, false);

  const runLevel = Ledger.taskOutcomes(stamp([trace(), outcome()]));
  assert.equal(runLevel[0].cause, 'ci_failed');
  assert.equal(runLevel[0].delivered, false);
  assert.equal(runLevel[0].success, false);
});

test('taskOutcomes: a later success on the same run overturns an earlier run-level outcome (resumed run)', () => {
  const started = { ...base, kind: 'run_started', run: 'R1', handover: 'H1' };
  const ended = st => ({ ...base, kind: 'run_ended', run: 'R1', handover: 'H1', status: st, ...(st === 'succeeded' ? {} : { reason: 'x' }) });
  const resumed = Ledger.taskOutcomes(stamp([
    started, trace(), trace({ task: 'T-2' }),
    outcome({ task: 'T-2', cause: 'ci_failed', ref: { kind: 'ci', id: 'lint' } }),
    outcome({ cause: 'integration_failed', ref: { kind: 'integration', id: 'att-1' } }), ended('failed'),
    started, ended('succeeded'),
    { ...base, kind: 'handover_closed', handover: 'H1', outcome: 'delivered' },
  ]));
  assert.equal(resumed[0].cause, null, 'attempt 1 run-level failure is overturned');
  assert.equal(resumed[0].ref, null);
  assert.equal(resumed[0].success, true);
  assert.equal(resumed[1].cause, 'ci_failed', 'a task-level outcome is not overturned');
  assert.equal(resumed[1].success, false);

  const closedOnly = Ledger.taskOutcomes(stamp([started, trace(), outcome({ cause: 'qa_failed', ref: { kind: 'qa', id: 'a' } }),
    { ...base, kind: 'handover_closed', handover: 'H1', outcome: 'delivered' }]));
  assert.equal(closedOnly[0].cause, null, 'a delivered handover also overturns it');

  const after = Ledger.taskOutcomes(stamp([started, trace(), ended('succeeded'),
    outcome({ cause: 'qa_failed', ref: { kind: 'qa', id: 'b' } })]));
  assert.equal(after[0].cause, 'qa_failed', 'an outcome after the success still counts');

  const other = Ledger.taskOutcomes(stamp([started, trace(), outcome({ cause: 'qa_failed', ref: { kind: 'qa', id: 'c' } }),
    { ...base, kind: 'run_ended', run: 'R9', handover: 'H1', status: 'succeeded' }, ended('failed')]));
  assert.equal(other[0].cause, 'qa_failed', 'another run, or a failed end, overturns nothing');
});

const { spawnSync } = require('child_process');
const path = require('path');
const skipPy = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';

test('python validates the slice with the same errors', { skip: skipPy }, () => {
  const cases = [
    task(), task({ cause: 'stalled' }), task({ status: 'passed', cause: 'stalled' }), task({ cause: 'parked' }),
    task({ status: 'passed', cause: 'gate_failed:x' }), task({ cause: 'gate_failed:' }), task({ cause: 'stalled\n' }),
    trace(), trace({ outcome: 'passed', cause: 'abandoned' }), trace({ models: ['x', ''] }), trace({ procedures: [{ id: 'p', version: '1' }] }),
    trace({ tokens_out: -1 }), trace({ bundle_id: 3 }),
    outcome(), outcome({ cause: 'flaky' }), outcome({ ref: { kind: 'jira', id: 'X' } }),
    { ...base, kind: 'escape', id: 'E-1', description: 'd', ref: { kind: 'ci', id: 'x' } },
    { ...base, kind: 'escape', id: 'E-1', description: 'd', ref: { kind: 'jira', id: 'A-1' }, run: 'R1' },
  ];
  const r = spawnSync('python3', ['-c', 'import json,sys; from designc.ledger import validate; print(json.dumps([validate(e) for e in json.loads(sys.argv[1])]))', JSON.stringify(cases)], { cwd: path.join(__dirname, '..', 'python'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), cases.map(c => Ledger.validate(c)));
});
