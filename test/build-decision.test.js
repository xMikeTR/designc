'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const jsyaml = require('js-yaml');
const Core = require('../renderer/core.js');

// An effect: build decision acknowledges a finding that the code has to answer. It covers the finding while its work
// item is open, and the finding blocks again once the item is done and the model still raises it.
const DSL = `workspace {
  model {
    s = softwareSystem "S" {
      top = container "Top"
      a = container "A"
      b = container "B"
      c = container "C"
      top -> a "calls"
      a -> b "calls"
      b -> c "calls"
      c -> a "calls"
    }
  }
}
`;
const OPTS = { chainHops: 3 };
const m = Core.parse(DSL);
const diags = Core.check(m, OPTS);
const f = diags.find(d => d.code === 'DC003');
const dec = (o = {}) => ({
  id: 'build-dc003', status: 'bound', kind: 'technical', effect: 'build', work: 'W-1', binds: f.loc.names, resolves: ['DC003'], checks: [],
  promoted_against: f.loc.names.map(n => { const e = [...m.elements.values()].find(x => x.name === n); return { element: e.id, name: e.name, hash: Core.fingerprint(m, e.id).hash }; }), ...o });
const gate = (d, workStates) => Core.gate({ model: m, diags, decisions: d ? [d] : [], requirements: [], ledger: [], workStates }).clauses.map(c => c.text);
const finding = t => /neither fixed nor accepted/.test(t);

test('the finding is open with no decision', () => {
  assert.ok(gate(null, {}).some(finding));
});

test('a bound build decision covers the finding while its item is open', () => {
  for (const st of ['backlog', 'active']) assert.deepEqual(gate(dec(), { 'W-1': st }).filter(t => finding(t) || /build-dc003/.test(t)), []);
});

test('a done item stops covering it, and the decision says why', () => {
  const out = gate(dec(), { 'W-1': 'done' });
  assert.ok(out.some(finding));
  assert.ok(out.includes('build-dc003 says DC003 is built, but the model still raises it'));
});

test('a build decision needs a work item that exists', () => {
  assert.ok(gate(dec({ work: undefined }), {}).includes('build-dc003 builds a fix but names no work item'));
  const out = gate(dec(), {});
  assert.ok(out.includes('build-dc003: work item W-1 does not exist'));
  assert.ok(out.some(finding));
});

test('an unbound build decision does not cover the finding', () => {
  assert.ok(gate(dec({ status: 'minted' }), { 'W-1': 'active' }).some(finding));
});

test('the Python CLI reaches the same clauses', () => {
  const states = { missing: null, backlog: [], active: [{ kind: 'item_pulled', item: 'W-1' }], done: [{ kind: 'item_pulled', item: 'W-1' }, { kind: 'item_done', item: 'W-1', commit: 'abc', evidence: [] }] };
  for (const [name, events] of Object.entries(states)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-'));
    for (const d of ['model', 'decisions', 'work', 'ledger']) fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, 'model', 'workspace.dsl'), DSL);
    fs.writeFileSync(path.join(dir, 'designc.json'), JSON.stringify({ model: 'model/workspace.dsl', chainHops: 3 }));
    fs.writeFileSync(path.join(dir, 'decisions', 'build-dc003.yaml'), jsyaml.dump(dec()));
    if (events !== null) fs.writeFileSync(path.join(dir, 'work', 'W-1.yaml'), 'id: W-1\ntitle: t\nrequirement: R-1\nelements: []\ndone_when:\n  - gate: "true"\n');
    if (events && events.length) fs.writeFileSync(path.join(dir, 'ledger', 'designc.jsonl'), events.map((e, i) => JSON.stringify({ schema_version: 1, event_id: `e${i}`, ts: 1000 + i, by: 'x', ...e })).join('\n') + '\n');
    const r = spawnSync('python3', ['-m', 'designc', 'check', dir, '--json'], { cwd: path.join(__dirname, '..', 'python'), encoding: 'utf8' });
    const py = JSON.parse(r.stdout).gate.clauses.map(c => c.text).filter(t => /build-dc003|DC003/.test(t)).sort();
    const js = gate(dec(), { 'W-1': events === null ? undefined : name === 'missing' ? undefined : name }).filter(t => /build-dc003|DC003/.test(t)).sort();
    assert.deepEqual(py, js, name);
  }
});
