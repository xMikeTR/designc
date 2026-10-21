// The Python file rules for work items (python/designc/work.py) say the same as renderer/work.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const Work = require('../renderer/work.js');

const PY = path.join(__dirname, '..', 'python');
const skip = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';
const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

const FILES = {
  'ok': 'id: ok\nrequirement: HRE-1\nelements: [Pricing API]\nwrites: ["src/Api/**"]\ndone_when:\n  - gate: dotnet test\n  - judge: clarity\n',
  'no-gate': 'id: no-gate\nrequirement: HRE-1\nelements: [Quotes DB]\ndone_when:\n  - checklist: Note\n',
  'judge-alone': 'id: judge-alone\ntarget: { document: "https://x/y" }\ndone_when:\n  - judge: clarity\n',
  'both': 'id: both\nrequirement: HRE-1\nelements: [A]\ntarget: { jira: HRE-9 }\ndone_when:\n  - gate: x\n',
  'neither': 'id: neither\ndone_when:\n  - checklist: a\n',
  'bad-target': 'id: bad-target\ntarget: { ticket: HRE-9 }\ndone_when:\n  - checklist: a\n',
  'unknowns': 'id: unknowns\nrequirement: HRE-404\nelements: []\ndepends_on: [nope]\nwrites: ["../etc/**"]\ndone_when:\n  - gate: x\n',
  'entries': 'id: entries\nrequirement: HRE-1\nelements: [A]\ndone_when:\n  - gate: x\n    review: y\n  - smoke: y\n  - review: ""\n',
  'empty': 'id: empty\nrequirement: HRE-1\nelements: [A]\ndone_when: []\n',
  'clash': 'id: clash\nrequirement: HRE-1\nelements: [Pricing API]\nwrites: ["src/Api/Quotes/*.cs"]\ndone_when:\n  - gate: x\n',
  'doc-a': 'id: doc-a\ntarget: { document: "https://c/p/1" }\ndone_when:\n  - checklist: a\n',
  'multi': 'id: multi\nrequirement: [HRE-1, HRE-2]\nelements: [Pricing API, Quotes DB]\ndone_when:\n  - gate: x\n',
  'multi-out': 'id: multi-out\nrequirement: [HRE-1, HRE-2]\nelements: [Mail]\ndone_when:\n  - gate: x\n',
  'multi-missing': 'id: multi-missing\nrequirement: [HRE-1, HRE-404]\nelements: [Pricing API]\ndone_when:\n  - gate: x\n',
  'doc-b': 'id: doc-b\ntarget: { document: "https://c/p/1" }\ndone_when:\n  - checklist: a\n',
};

test('the Python work report matches renderer/work.js on the same files', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-work-'));
  put(root, 'model/workspace.dsl', 'workspace { model { a = person "A" } }');
  put(root, 'requirements/HRE-1.yaml', 'id: HRE-1\ntitle: t\nversion: 1\nelements: [Pricing API]\n');
  put(root, 'requirements/HRE-2.yaml', 'id: HRE-2\ntitle: t\nversion: 1\nelements: [Quotes DB]\n');
  for (const [name, text] of Object.entries(FILES)) put(root, `work/${name}.yaml`, text);
  const items = Object.entries(FILES).map(([name, text]) => ({ ...yaml.load(text), _path: `work/${name}.yaml` }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const ids = items.map(i => i.id);
  // clash and ok are active; the rest are backlog.
  const events = ['ok', 'clash', 'doc-a', 'doc-b'].map((item, i) => ({ kind: 'item_pulled', item, ts: 1000 + i, schema_version: 1, event_id: `e${i}`, by: 't' }));
  put(root, 'ledger/designc.jsonl', events.map(e => JSON.stringify(e)).join('\n') + '\n');

  const r = spawnSync('python3', ['-m', 'designc', 'work', root, '--json'], { cwd: PY, encoding: 'utf8' });
  const py = JSON.parse(r.stdout);
  const reqs = [{ id: 'HRE-1', elements: ['Pricing API'] }, { id: 'HRE-2', elements: ['Quotes DB'] }];
  assert.deepEqual(py.uncovered, Work.coverage(items, reqs), 'uncovered');
  const st = Work.states(items, events.map(e => ({ ...e, _ts: e.ts })));
  const active = items.filter(i => st[i.id] === 'active');
  assert.deepEqual(py.items.map(x => x.id), ids);
  for (const it of items) {
    const row = py.items.find(x => x.id === it.id);
    const js = Work.validate(it, { requirements: reqs, items: ids.filter(x => x !== it.id) });
    assert.deepEqual(row.problems, js, `problems for ${it.id}`);
    assert.equal(row.state, st[it.id], `state for ${it.id}`);
    assert.deepEqual(row.conflicts.map(c => [c.with, c.reason, c.detail]), Work.conflicts(it, active).map(c => [c.with, c.reason, c.detail]), `conflicts for ${it.id}`);
  }
  assert.equal(r.status, 1, 'problems give exit 1');
  assert.ok(py.items.find(x => x.id === 'clash').conflicts.length >= 1);
});

test('designc work exits 0 for a sound folder and 2 for a missing one', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-work-'));
  put(root, 'requirements/HRE-1.yaml', 'id: HRE-1\ntitle: t\nversion: 1\nelements: [Pricing API]\n');
  put(root, 'work/a.yaml', FILES.ok);
  assert.equal(spawnSync('python3', ['-m', 'designc', 'work', root], { cwd: PY, encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('python3', ['-m', 'designc', 'work', path.join(root, 'nope')], { cwd: PY, encoding: 'utf8' }).status, 2);
});
