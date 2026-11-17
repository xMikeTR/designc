// D7 part 1: the System 3 contract. caught_by stages, catalogue_gap, escape screen/bucket, stage_verdict.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Ledger = require('../renderer/ledger.js');
const ParityQa = require('../renderer/parity-qa.js');

const PY = path.join(__dirname, '..', 'python');
const skip = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';
const env = o => ({ schema_version: 1, event_id: 'e' + Math.random(), ts: 1000, by: 'x', ...o });
const py = ev => JSON.parse(spawnSync('python3', ['-I', '-c', 'import json,sys; sys.path.insert(0, sys.argv[1]); from designc import ledger; print(json.dumps(ledger.validate(json.loads(sys.stdin.read()))))', PY], { input: JSON.stringify(ev), encoding: 'utf8' }).stdout);

test('caught_by lists the S1 stages, the UI and delivery stages, and pipeline', () => {
  assert.deepEqual(Ledger.CAUGHT_BY, ['S1-lint', 'S1-p', 'S1-grill', 'ui-spec', 'ui-preview', 'ui-code', 'ui-visual', 'acceptance', 'holdout', 'parity', 'review', 'qa', 'pipeline']);
  for (const c of Ledger.CAUGHT_BY) assert.deepEqual(Ledger.validate(env({ kind: 'escape', id: 'E', description: 'd', caught_by: c })), [], c);
  assert.ok(Ledger.validate(env({ kind: 'escape', id: 'E', description: 'd', caught_by: 'nope' })).some(m => /caught_by/.test(m)));
  assert.deepEqual(Ledger.validate(env({ kind: 'escape_classified', escape: 'E', caught_by: 'holdout' })), []);
});

test('origin catalogue_gap validates on escape and escape_classified', () => {
  assert.ok(Ledger.ORIGINS.includes('catalogue_gap'));
  assert.deepEqual(Ledger.validate(env({ kind: 'escape', id: 'E', description: 'd', origin: 'catalogue_gap' })), []);
  assert.deepEqual(Ledger.validate(env({ kind: 'escape_classified', escape: 'E', caught_by: 'ui-spec', origin: 'catalogue_gap' })), []);
});

test('escape takes screen and bucket; bucket_member holds bucket to ParityQa.BUCKETS', () => {
  assert.deepEqual(Ledger.ESCAPE_BUCKETS, ParityQa.BUCKETS);
  const ok = { kind: 'escape', id: 'qa-b-1', description: 'k: r', screen: 'bordereaux', bucket: 'caught', caught_by: 'parity' };
  assert.deepEqual(Ledger.validate(env(ok)), []);
  assert.deepEqual(Ledger.validate(env({ ...ok, bucket: null })), []);
  assert.ok(Ledger.validate(env({ ...ok, bucket: 'lost' })).some(m => /bucket/.test(m)));
  assert.ok(Ledger.validate(env({ ...ok, screen: 3 })).some(m => /screen/.test(m)));
});

test('Python mirror agrees on the new escape fields', { skip }, () => {
  const ok = { kind: 'escape', by: 'x', id: 'qa-b-1', description: 'd', screen: 's', bucket: 'triage', caught_by: 'ui-visual', origin: 'catalogue_gap' };
  assert.deepEqual(py(ok), []);
  assert.ok(py({ ...ok, bucket: 'lost' }).some(m => /bucket/.test(m)));
  assert.ok(py({ ...ok, caught_by: 'nope' }).some(m => /caught_by/.test(m)));
  assert.ok(py({ ...ok, origin: 'nope' }).some(m => /origin/.test(m)));
});

test('STAGES in app.js labels every caught_by value', () => {
  const src = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const line = src.split('\n').find(l => l.startsWith('const STAGES = '));
  assert.deepEqual([...line.matchAll(/\['([^']+)',/g)].map(m => m[1]), Ledger.CAUGHT_BY);
  assert.match(src, /catalogue_gap: 'Catalogue gap'/);
});

// stage_verdict (slice 2)
const V = { kind: 'stage_verdict', by: 'factory', run: 'r1', stage: 'ui-code', outcome: 'pass', change_ts: 900 };
const verdict = o => env({ ...V, ...o });

test('stage_verdict: required fields, enums, pipeline kind and stream', () => {
  assert.deepEqual(Ledger.validate(verdict()), []);
  assert.deepEqual(Ledger.validate(verdict({ change_ts: null, outcome: 'could_not_run' })), []);
  for (const k of ['run', 'stage', 'outcome', 'change_ts']) {
    const { [k]: _, ...rest } = V;
    assert.ok(Ledger.validate(env(rest)).some(e => e.includes(k)), k);
  }
  for (const s of ['ui-code', 'ui-visual', 'acceptance', 'holdout', 'review', 'qa']) assert.deepEqual(Ledger.validate(verdict({ stage: s })), [], s);
  assert.ok(Ledger.validate(verdict({ stage: 'parity' })).some(e => /stage/.test(e)));
  assert.ok(Ledger.validate(verdict({ outcome: 'flaky' })).some(e => /outcome/.test(e)));
  assert.equal(Ledger.KINDS.stage_verdict.stream, 'pipeline.jsonl');
  assert.ok(Ledger.PIPELINE_KINDS.includes('stage_verdict'));
  assert.deepEqual(Ledger.validate(verdict({ task: 't', element: 'e', screen: 's', item: 'W-1', failures: [{ state: 'empty', kind: 'aria', placement: 'p', criterion: 'AC-1' }] })), []);
});

test('verdict_shape: change_ts not after ts, failures carry four keys only, round only on review', () => {
  assert.deepEqual(Ledger.validate(verdict({ change_ts: 1000 })), [], 'equal is fine');
  assert.ok(Ledger.validate(verdict({ change_ts: 1001 })).some(e => /change_ts/.test(e)));
  assert.deepEqual(Ledger.validate({ ...V, change_ts: 5 }), [], 'no ts yet: not judged');
  assert.ok(Ledger.validate(verdict({ failures: [{ state: 's', msg: 'detail' }] })).some(e => /failures\[0\]/.test(e)));
  assert.ok(Ledger.validate(verdict({ failures: [{ state: 3 }] })).some(e => /failures\[0\]/.test(e)));
  assert.ok(Ledger.validate(verdict({ round: 1 })).some(e => /round/.test(e)));
  assert.deepEqual(Ledger.validate(verdict({ stage: 'review', round: 2 })), []);
  assert.ok(Ledger.validate(verdict({ stage: 'review', round: 0 })).some(e => /round/.test(e)));
});

test('designc record accepts stage_verdict into pipeline.jsonl and refuses a bad one', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-d7r-'));
  try {
    const rec = ev => spawnSync('python3', ['-m', 'designc', 'record', root, '--by', 'factory'], { cwd: PY, input: JSON.stringify(ev) + '\n', encoding: 'utf8' });
    const ex = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'stage-verdict.example.json'), 'utf8').trim().split('\n')[0]);
    assert.equal(rec(ex).status, 0);
    const rows = fs.readFileSync(path.join(root, 'ledger', 'pipeline.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(rows.map(r => r.kind), ['stage_verdict']);
    assert.equal(rec({ ...ex, ts: 1000, change_ts: 2000 }).status, 1);
    assert.equal(rec({ ...ex, failures: [{ msg: 'x' }] }).status, 1);
    assert.equal(rec({ ...ex, stage: 'ui-code', round: 1 }).status, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the example file validates in JS', () => {
  const ex = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'stage-verdict.example.json'), 'utf8').trim().split('\n')[0]);
  assert.deepEqual(Ledger.validate(ex), []);
});
