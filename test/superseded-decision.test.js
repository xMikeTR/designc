// A superseded decision is out of the gate, in core.js and python/designc/gate.py alike.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Core = require('../renderer/core.js');

const PY = path.join(__dirname, '..', 'python');
const skip = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';
const DSL = 'workspace "Q" {\n  model {\n    s = softwareSystem "Bookings" {\n      api = container "Bookings API"\n    }\n  }\n}\n';

test('a superseded decision does not block the gate', () => {
  const model = Core.parse(DSL);
  const g = Core.gate({ model, diags: [], decisions: [{ id: 'D-1', status: 'superseded', binds: ['Bookings API'] }], requirements: [], ledger: [] });
  assert.deepEqual(g.clauses, []);
  assert.equal(g.ready, true);
});

test('a superseded decision no longer covers its finding', () => {
  const model = Core.parse(DSL);
  const finding = { code: 'DC005', sev: 'warning', loc: { label: 'Bookings API', names: ['Bookings API'] }, related: [] };
  const g = Core.gate({ model, diags: [finding], decisions: [{ id: 'D-1', status: 'superseded', effect: 'accept', resolves: ['DC005'], binds: ['Bookings API'] }], requirements: [], ledger: [] });
  assert.deepEqual(g.clauses.map(c => c.text), ['DC005 on Bookings API is neither fixed nor accepted']);
});

test('the Python gate ignores a superseded decision too', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-superseded-'));
  fs.mkdirSync(path.join(root, 'model')); fs.mkdirSync(path.join(root, 'decisions'));
  fs.writeFileSync(path.join(root, 'designc.json'), '{}');
  fs.writeFileSync(path.join(root, 'model/workspace.dsl'), DSL);
  fs.writeFileSync(path.join(root, 'decisions/D-1.yaml'), 'id: D-1\nstatus: superseded\nbinds: [Bookings API]\nstatement: a\n');
  const r = spawnSync('python3', ['-m', 'designc', 'check', root, '--json', '--no-record'], { cwd: PY, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(JSON.parse(r.stdout).gate.clauses, []);
});
