// ui_preview_rendered: a Factory kind (D2 slice 0). `designc record` accepts it; ui_pinned stays human only.
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
const EV = { kind: 'ui_preview_rendered', by: 'factory', screen: 'bordereaux', spec_hash: H, files: { 'previews/bordereaux/ready.png': H }, image: 'previews/bordereaux/ready.png' };

test('ledger: ui_preview_rendered needs screen, spec_hash, files and image', () => {
  assert.deepEqual(Ledger.validate(EV), []);
  for (const k of ['screen', 'spec_hash', 'files', 'image']) {
    const { [k]: _, ...rest } = EV;
    assert.ok(Ledger.validate(rest).some(e => e.includes(k)), k);
  }
  assert.ok(Ledger.validate({ ...EV, spec_hash: 'abc' }).some(e => /spec_hash/.test(e)));
  assert.ok(Ledger.validate({ ...EV, files: { 'a.png': 'zz' } }).some(e => /files/.test(e)));
  assert.equal(Ledger.KINDS.ui_preview_rendered.stream, 'designc.jsonl');
});

const record = (root, ev) => spawnSync('python3', ['-m', 'designc', 'record', root, '--by', 'factory'], { cwd: PY, input: JSON.stringify(ev) + '\n', encoding: 'utf8' });
const withRoot = fn => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-uipr-')); try { fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); } };

test('designc record accepts ui_preview_rendered and writes it to designc.jsonl', { skip }, () => withRoot(root => {
  const r = record(root, EV);
  assert.equal(r.status, 0, r.stderr);
  const { events, errors } = Ledger.parse(fs.readFileSync(path.join(root, 'ledger', 'designc.jsonl'), 'utf8'), 'designc.jsonl');
  assert.deepEqual(errors, []);
  assert.equal(events[0].kind, 'ui_preview_rendered');
}));

test('designc record rejects ui_preview_rendered with a missing field, and bad hashes', { skip }, () => withRoot(root => {
  for (const bad of [(({ image, ...r }) => r)(EV), { ...EV, spec_hash: 'abc' }, { ...EV, files: { 'a.png': 'zz' } }]) {
    const r = record(root, bad);
    assert.equal(r.status, 1);
    assert.equal(fs.existsSync(path.join(root, 'ledger')), false);
  }
}));
