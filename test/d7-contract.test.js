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

