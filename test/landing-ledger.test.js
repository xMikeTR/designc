// landing_approved (S4 L): human only. `designc record` refuses it; the app writes it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Ledger = require('../renderer/ledger.js');

const PY = path.join(__dirname, '..', 'python');
const skip = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';
const H = 'a'.repeat(64);
const ROW = { kind: 'landing_approved', by: 'mike', requirement: 'R-1', hash: H, author: 'agent', corrected: false };

test('ledger: landing_approved validates and lands in designc.jsonl', () => {
  assert.deepEqual(Ledger.validate(ROW), []);
  assert.deepEqual(Ledger.validate({ ...ROW, corrected: true, correction: { proposal: 'P-9' } }), []);
  assert.equal(Ledger.KINDS.landing_approved.stream, 'designc.jsonl');
});

test('ledger: landing_approved refuses missing fields', () => {
  for (const k of ['requirement', 'hash', 'author', 'corrected']) {
    const { [k]: _, ...rest } = ROW;
    assert.ok(Ledger.validate(rest).some(e => e.includes(k)), k);
  }
});

test('designc record refuses landing_approved: approving is human only', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-land-'));
  try {
    const r = spawnSync('python3', ['-m', 'designc', 'record', root, '--by', 'factory'], { cwd: PY, input: JSON.stringify({ ...ROW, by: 'agent' }) + '\n', encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /kind 'landing_approved' cannot be recorded here/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
