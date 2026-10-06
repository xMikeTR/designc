// `designc record`: the eval harness's one way into the ledger. Only the factory kinds, all lines or none, no model needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Ledger = require('../renderer/ledger.js');

const PY = path.join(__dirname, '..', 'python');
const skip = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'DESIGNC_BY'));

const RUN = { kind: 'suite_run', suite_run_id: 'run-1', suite: 's2-regression', harness_version: 'abc1234', model: 'm', prompt_version: 'p7', trials: 1,
  tasks: { 'S2-0001': { hash: 'h1', gates: ['build'] } } };
const GRADER = { kind: 'grader', suite_run_id: 'run-1', task_id: 'S2-0001', trial: 1, grader: 'build', verdict: 'pass', trace_id: 'lf-1' };
const DONE = { kind: 'suite_run_finished', suite_run_id: 'run-1', outcome: 'completed' };

const empty = () => fs.mkdtempSync(path.join(os.tmpdir(), 'designc-record-'));
const lines = (...evs) => evs.map(e => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
const record = (root, input, ...args) => spawnSync('python3', ['-m', 'designc', 'record', root, ...args], { cwd: PY, input, encoding: 'utf8', env: ENV });
const ledgerOf = root => { const f = path.join(root, 'ledger', 'factory.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };

test('records a suite run into a folder with no model or settings', { skip }, () => {
  const root = empty();
  const r = record(root, lines(RUN, GRADER, DONE), '--by', 'harness');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /recorded 3 events/);
  const { events, errors } = Ledger.parse(ledgerOf(root), 'factory.jsonl');
  assert.deepEqual(errors, []);
  assert.deepEqual(events.map(e => e.kind), ['suite_run', 'grader', 'suite_run_finished']);
  assert.ok(events.every(e => e.by === 'harness' && e.schema_version === 1 && e.event_id));
  assert.equal(events[1].trace_id, 'lf-1');
});

test('refuses any kind outside the factory allowlist by name, and writes nothing', { skip }, () => {
  for (const kind of ['gate', 'decision_promoted', 'needs_decision_resolved', 'failure_mode_classified', 'escape', 'SessionStarted', 'nonsense']) {
    const root = empty();
    const r = record(root, lines(RUN, { kind, by: 'x' }), '--by', 'harness');
    assert.equal(r.status, 1, kind);
    assert.match(r.stderr, new RegExp(`line 2: .*${kind}`), kind);
    assert.match(r.stderr, /suite_run, grader, suite_run_finished/);
    assert.equal(ledgerOf(root), '', `${kind}: nothing may be written`);
  }
});

test('an invalid line or bad JSON anywhere in the batch writes nothing', { skip }, () => {
  const root = empty();
  let r = record(root, lines(RUN, { ...GRADER, verdict: 'ok' }, DONE), '--by', 'harness');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /line 2: grader\.verdict/);
  r = record(root, lines(RUN, '{not json'), '--by', 'harness');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /line 2: not valid JSON/);
  assert.equal(ledgerOf(root), '');
});

test('--json reports what happened; blank lines are skipped; an event keeps its own by', { skip }, () => {
  const root = empty();
  const r = record(root, '\n' + lines({ ...RUN, by: 'ci-bot' }, '', GRADER), '--by', 'harness', '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.recorded, 2);
  assert.deepEqual(Ledger.parse(ledgerOf(root), 'f').events.map(e => e.by), ['ci-bot', 'harness']);
  const bad = JSON.parse(record(root, lines({ kind: 'gate' }), '--json').stdout);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].line, 1);
});

test('a folder that does not exist exits 2; empty input records nothing', { skip }, () => {
  assert.equal(record(path.join(empty(), 'missing'), lines(RUN)).status, 2);
  const root = empty();
  const r = record(root, '');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /recorded 0 events/);
});

test('the recorded ledger passes verify-ledger', { skip }, () => {
  const root = empty();
  record(root, lines(RUN, GRADER, DONE), '--by', 'harness');
  const r = spawnSync('python3', ['-m', 'designc', 'verify-ledger', root], { cwd: PY, encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
