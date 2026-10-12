// `designc check --item` (python/designc/gate.py scoped_gate) keeps the same clauses as Core.scopedGate.
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
      api = container "Quotes API"
      db = container "Quotes DB"
      mail = container "Mail"
    }
    api -> db "writes" { properties { d.interaction sync } }
    api -> mail "notifies" { properties { d.interaction sync } }
    api -> db "reads" { properties { d.interaction sync } }
  }
}
`;

test('the Python scoped gate keeps the clauses Core.scopedGate keeps', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-scope-'));
  put(root, 'designc.json', '{}');
  put(root, 'model/workspace.dsl', DSL);
  put(root, 'requirements/R-1.yaml', 'id: R-1\ntitle: t\nversion: 1\nelements: [Quotes API, Quotes DB]\n');
  put(root, 'requirements/R-2.yaml', 'id: R-2\ntitle: t\nversion: 1\nelements: [Nothing]\n');
  const decs = {
    'D-1': 'id: D-1\nstatus: minted\neffect: fix\nbinds: [Quotes DB]\nstatement: a\nchecks: ["true"]\n',
    'D-2': 'id: D-2\nstatus: minted\neffect: fix\nbinds: [Mail]\nstatement: b\nchecks: ["true"]\n',
  };
  for (const [k, t] of Object.entries(decs)) put(root, `decisions/${k}.yaml`, t);
  put(root, 'ledger/designc.jsonl', JSON.stringify({ schema_version: 1, event_id: 'n1', ts: 1, kind: 'needs_decision', by: 't', id: 'N-1', question: 'Which?', status: 'open', element: 'Mail' }) + '\n');
  put(root, 'work/W-api.yaml', 'id: W-api\nrequirement: R-1\nelements: [Quotes API, Quotes DB]\ndone_when:\n  - gate: x\n');

  const model = Core.parse(DSL), diags = Core.check(model, {});
  const decisions = Object.values(decs).map(t => yaml.load(t));
  const requirements = [{ id: 'R-1', elements: ['Quotes API', 'Quotes DB'] }, { id: 'R-2', elements: ['Nothing'] }];
  const ledger = [{ kind: 'needs_decision', id: 'N-1', question: 'Which?', status: 'open', element: 'Mail' }];
  const g = Core.gate({ model, diags, decisions, requirements, ledger });
  const js = Core.scopedGate(g, { model, elements: ['Quotes API', 'Quotes DB'], requirement: 'R-1', decisions });
  assert.ok(js.outside > 0 && js.clauses.length > 0, 'the case must filter something and keep something');

  const r = spawnSync('python3', ['-m', 'designc', 'check', root, '--item', 'W-api', '--json'], { cwd: PY, encoding: 'utf8' });
  const py = JSON.parse(r.stdout);
  assert.equal(py.item, 'W-api');
  assert.equal(py.outside, js.outside);
  assert.deepEqual(py.gate.clauses, js.clauses.map(c => ({ kind: c.kind, text: c.text })));
});

test('check --item refuses an item that is not a repo item', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-scope-'));
  put(root, 'model/workspace.dsl', DSL);
  const r = spawnSync('python3', ['-m', 'designc', 'check', root, '--item', 'nope', '--json'], { cwd: PY, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no repo work item nope/);
});
