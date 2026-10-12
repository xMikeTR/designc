// The Python gate keeps the same acceptance clauses as Core.gate (python/designc/gate.py acceptance_clauses).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const Core = require('../renderer/core.js');

const PY = path.join(__dirname, '..', 'python');
const skip = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';
const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

const DSL = `workspace "Q" {
  model {
    s = softwareSystem "Quotes" {
      ui = container "Quote UI" {
        tags "UI"
      }
      portal = container "Admin UI" {
        tags "UI"
      }
      api = container "Quotes API"
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

test('Python and JS report the same acceptance clauses', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-acc-'));
  put(root, 'designc.json', '{}');
  put(root, 'model/workspace.dsl', DSL);
  put(root, 'requirements/R-1.yaml', 'id: R-1\ntitle: t\nversion: 1\nelements: [Quote UI, Admin UI]\n');
  const files = {
    'AC-1': 'id: AC-1\nrequirement: R-1\nelement: Quotes/Quote UI\nstates: [ready, loading]\ncases:\n  - { state: ready, given: a, then: b }\n  - { state: empty, given: a }\n  - { state: sad, given: a, then: b }\n',
    'AC-2': 'id: AC-2\nrequirement: R-9\ndecision: D-9\nelement: Nowhere\nstates: [ready]\ncases: []\n',
    'AC-3': 'id: AC-3\nrequirement: R-1\n',
    'AC-4': 'id: AC-4\nrequirement: R-1\nelement: Admin UI\nstates: [ready, loading, empty, error]\nlocators:\n  save: { role: button, name: Save }\n  odd: { role: widget, name: X }\n  bare: { role: link }\ncases:\n  - { state: ready, given: a, then: b, uses: [save, nope] }\n  - { state: loading, given: a, then: b }\n  - { state: empty, given: a, then: b }\n  - { state: error, given: a, then: b }\n',
  };
  for (const [k, t] of Object.entries(files)) put(root, `acceptance/${k}.yaml`, t);
  const model = Core.parse(DSL), diags = Core.check(model, {});
  const requirements = [{ id: 'R-1', elements: ['Quote UI', 'Admin UI'] }];
  const acceptance = Object.values(files).map(t => yaml.load(t));
  const js = Core.gate({ model, diags, decisions: [], requirements, ledger: [], acceptance }).clauses.filter(c => c.kind === 'acceptance');
  assert.ok(js.length >= 6, js.map(c => c.text).join('; '));
  const r = spawnSync('python3', ['-m', 'designc', 'check', root, '--json'], { cwd: PY, encoding: 'utf8' });
  const py = JSON.parse(r.stdout).gate.clauses.filter(c => c.kind === 'acceptance');
  assert.deepEqual(py, js.map(c => ({ kind: c.kind, text: c.text })));
});
