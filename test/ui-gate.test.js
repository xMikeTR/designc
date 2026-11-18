// The ui gate: opt-in, joins the gate through Core.gate, and a pin is human only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Core = require('../renderer/core.js');
const Ledger = require('../renderer/ledger.js');
const { load, BROKEN } = require('./helpers/ui.js');

const m = Core.parse('workspace { model { a = person "A"\n b = softwareSystem "B"\n a -> b "uses" } }');
const gate = (ui, ledger = []) => Core.gate({ model: m, diags: [], decisions: [], requirements: [], ledger, ui });

test('gate: without ui the result is unchanged and carries no notes or coverage', () => {
  const g = gate(null);
  assert.equal(g.notes, undefined);
  assert.equal(g.coverage, undefined);
});
test('gate: GATE_INPUTS includes ui', () => assert.ok(Core.GATE_INPUTS.includes('ui')));
test('gate: a pinned, clean pack and spec leave the gate ready, with no coverage gap', () => {
  const { ledger, ...ui } = load();
  const g = gate(ui, ledger);
  assert.equal(g.ready, true);
  assert.deepEqual(g.coverage, []);
});
test('gate: ui clauses carry kind ui and block the gate', () => {
  const { ledger, ...ui } = load();
  ui.specs = [...ui.specs, { path: 'ui/specs/broken.json', text: BROKEN }];
  const g = gate(ui, ledger);
  assert.equal(g.ready, false);
  assert.equal(g.clauses.filter(c => c.kind === 'ui').length, 13);
  assert.equal(g.notes.length, 4);
});
test('gate: the design tokens the gate already reads feed the ui checks', () => {
  const { ledger, tokens, ...ui } = load();
  const g = Core.gate({ model: m, diags: [], decisions: [], requirements: [], ledger, tokens, ui });
  assert.deepEqual(g.clauses.filter(c => c.kind === 'ui'), []);
  const none = Core.gate({ model: m, diags: [], decisions: [], requirements: [], ledger, ui });
  assert.ok(none.clauses.some(c => c.kind === 'ui' && /design-tokens\/tokens\.json is missing/.test(c.text)));
});
test('ledger: ui_pinned needs pack, registry and a hash that is not blank', () => {
  const ev = { kind: 'ui_pinned', by: 'mike', pack: 'acme-ui', registry: 'acme-ui', hash: 'abc' };
  assert.deepEqual(Ledger.validate(ev), []);
  assert.ok(Ledger.validate({ ...ev, hash: ' ' }).length);
  assert.ok(Ledger.validate({ kind: 'ui_pinned', by: 'mike', pack: 'x' }).length);
});

const PY = path.join(__dirname, '..', 'python');
const skip = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';
test('designc record refuses ui_pinned: a pin is human only', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-ui-record-'));
  try {
    const ev = JSON.stringify({ kind: 'ui_pinned', by: 'agent', pack: 'acme-ui', registry: 'acme-ui', hash: 'abc' }) + '\n';
    const r = spawnSync('python3', ['-m', 'designc', 'record', root], { cwd: PY, input: ev, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /kind 'ui_pinned' cannot be recorded here/);
    assert.equal(fs.existsSync(path.join(root, 'ledger')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
