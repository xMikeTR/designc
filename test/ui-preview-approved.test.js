// ui_preview_approved and ui_spec_bound (D3 slice 1): human only. `designc record` refuses both; the app writes them.
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
const APPROVED = { kind: 'ui_preview_approved', by: 'mike', screen: 'bordereaux', spec: H, files: { 'ready-chromium-linux.png': H, 'placements/ready__header-chromium-linux.png': H } };
const BOUND = { kind: 'ui_spec_bound', by: 'mike', screen: 'bordereaux', hash: H };

test('ledger: ui_preview_approved needs screen, spec and files, all hashes 64 hex', () => {
  assert.deepEqual(Ledger.validate(APPROVED), []);
  for (const k of ['screen', 'spec', 'files']) {
    const { [k]: _, ...rest } = APPROVED;
    assert.ok(Ledger.validate(rest).some(e => e.includes(k)), k);
  }
  assert.ok(Ledger.validate({ ...APPROVED, spec: 'abc' }).some(e => /spec/.test(e)));
  assert.ok(Ledger.validate({ ...APPROVED, files: { 'a.png': 'zz' } }).some(e => /files/.test(e)));
  assert.equal(Ledger.KINDS.ui_preview_approved.stream, 'designc.jsonl');
});

test('ledger: ui_spec_bound needs screen and a 64 hex hash', () => {
  assert.deepEqual(Ledger.validate(BOUND), []);
  for (const k of ['screen', 'hash']) {
    const { [k]: _, ...rest } = BOUND;
    assert.ok(Ledger.validate(rest).some(e => e.includes(k)), k);
  }
  assert.ok(Ledger.validate({ ...BOUND, hash: 'abc' }).some(e => /hash/.test(e)));
  assert.equal(Ledger.KINDS.ui_spec_bound.stream, 'designc.jsonl');
});

const record = (root, ev, by = 'factory') => spawnSync('python3', ['-m', 'designc', 'record', root, '--by', by], { cwd: PY, input: JSON.stringify(ev) + '\n', encoding: 'utf8' });
const withRoot = fn => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-uipa-')); try { fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); } };

test('designc record refuses ui_preview_approved and ui_spec_bound: approving and binding are human only', { skip }, () => withRoot(root => {
  for (const ev of [APPROVED, BOUND]) {
    const r = record(root, { ...ev, by: 'agent' });
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, new RegExp(`kind '${ev.kind}' cannot be recorded here`));
    assert.equal(fs.existsSync(path.join(root, 'ledger')), false);
  }
}));

test('the python ledger rejects the same malformed rows as the JS one', { skip }, () => {
  const code = `
import json, sys
from designc import ledger
ev = json.loads(sys.stdin.read())
print(json.dumps(ledger.validate(ev)))`;
  const bads = [{ ...APPROVED, spec: 'abc' }, { ...APPROVED, files: { 'a.png': 'zz' } }, { ...BOUND, hash: 'abc' }, (({ files, ...r }) => r)(APPROVED), (({ hash, ...r }) => r)(BOUND)];
  for (const ev of [APPROVED, BOUND, ...bads]) {
    const r = spawnSync('python3', ['-c', code], { cwd: PY, input: JSON.stringify(ev), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const py = JSON.parse(r.stdout).length > 0, js = Ledger.validate(ev).length > 0;
    assert.equal(py, js, JSON.stringify(ev));
  }
});
