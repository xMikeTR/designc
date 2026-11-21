// The command line (designc-core check) keeps the same acceptance clauses as Core.gate on hand-built inputs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const Core = require('../renderer/core.js');
const { CORE } = require('./helpers/parity.js');

const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

const DSL = `workspace "Q" {
  model {
    s = softwareSystem "Bookings" {
      ui = container "Booking UI" {
        tags "UI"
      }
      portal = container "Admin UI" {
        tags "UI"
      }
      api = container "Bookings API"
    }
    ui -> api "calls" {
      properties {
        d.interaction "sync"
        d.authenticated "yes"
      }
    }
  }
}
`;

test('the CLI and Core.gate report the same acceptance clauses', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-acc-'));
  put(root, 'designc.json', '{}');
  put(root, 'model/workspace.dsl', DSL);
  put(root, 'requirements/R-1.yaml', 'id: R-1\ntitle: t\nversion: 1\nelements: [Booking UI, Admin UI]\n');
  const files = {
    'AC-1': 'id: AC-1\nrequirement: R-1\nelement: Bookings/Booking UI\nstates: [ready, loading]\ncases:\n  - { state: ready, given: a, then: b }\n  - { state: empty, given: a }\n  - { state: sad, given: a, then: b }\n',
    'AC-2': 'id: AC-2\nrequirement: R-9\ndecision: D-9\nelement: Nowhere\nstates: [ready]\ncases: []\n',
    'AC-3': 'id: AC-3\nrequirement: R-1\n',
    'AC-4': 'id: AC-4\nrequirement: R-1\nelement: Admin UI\nstates: [ready, loading, empty, error]\nlocators:\n  save: { role: button, name: Save }\n  odd: { role: widget, name: X }\n  bare: { role: link }\ncases:\n  - { state: ready, given: a, then: b, uses: [save, nope] }\n  - { state: loading, given: a, then: b }\n  - { state: empty, given: a, then: b }\n  - { state: error, given: a, then: b }\n',
  };
  for (const [k, t] of Object.entries(files)) put(root, `acceptance/${k}.yaml`, t);
  const model = Core.parse(DSL), diags = Core.check(model, {});
  const requirements = [{ id: 'R-1', elements: ['Booking UI', 'Admin UI'] }];
  const acceptance = Object.values(files).map(t => yaml.load(t));
  const js = Core.gate({ model, diags, decisions: [], requirements, ledger: [], acceptance }).clauses.filter(c => c.kind === 'acceptance');
  assert.ok(js.length >= 6, js.map(c => c.text).join('; '));
  const r = spawnSync(process.execPath, [CORE, 'check', root, '--json'], { encoding: 'utf8' });
  const py = JSON.parse(r.stdout).gate.clauses.filter(c => c.kind === 'acceptance');
  assert.deepEqual(py, js.map(c => ({ kind: c.kind, text: c.text })));
});

test('the CLI and Core.gate report the same holdout clauses', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-hold-'));
  put(root, 'designc.json', '{}');
  put(root, 'model/workspace.dsl', DSL);
  put(root, 'requirements/R-1.yaml', 'id: R-1\ntitle: t\nversion: 1\nelements: [Booking UI, Admin UI]\n');
  const cs = (extra = {}) => ['ready', 'loading', 'empty', 'error', 'forbidden'].map(s => `  - { state: ${s}, given: a, then: b${extra[s] || ''} }\n`).join('');
  const files = {
    'AC-1': `id: AC-1\nrequirement: R-1\nelement: Bookings/Booking UI\nstates: [ready, loading, empty, error, forbidden]\ncases:\n${cs({ empty: ', holdout: true', ready: ', holdout: yes' })}`,
    'AC-2': `id: AC-2\nrequirement: R-1\nelement: Admin UI\nstates: [ready, loading, empty, error]\ncases:\n${cs({ ready: ', holdout: true' })}  - { state: ready, given: c, then: d }\n`,
  };
  for (const [k, t] of Object.entries(files)) put(root, `acceptance/${k}.yaml`, t);
  const model = Core.parse(DSL), diags = Core.check(model, {});
  const requirements = [{ id: 'R-1', elements: ['Booking UI', 'Admin UI'] }];
  const acceptance = Object.values(files).map(t => yaml.load(t));
  const js = Core.gate({ model, diags, decisions: [], requirements, ledger: [], acceptance }).clauses.filter(c => c.kind === 'acceptance');
  assert.ok(js.some(c => /only case for state empty is holdout/.test(c.text)) && js.some(c => /holdout must be true or false/.test(c.text)), js.map(c => c.text).join('; '));
  const r = spawnSync(process.execPath, [CORE, 'check', root, '--json'], { encoding: 'utf8' });
  const py = JSON.parse(r.stdout).gate.clauses.filter(c => c.kind === 'acceptance');
  assert.deepEqual(py, js.map(c => ({ kind: c.kind, text: c.text })));
});
