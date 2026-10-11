// Parity: the Python `designc check` (python/designc) must give the same findings and the same gate
// clauses as renderer/core.js on the same registry. Both sides are run on real folders.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Core = require('../renderer/core.js');
const Ledger = require('../renderer/ledger.js');

const havePython = spawnSync('python3', ['-c', 'import yaml']).status === 0;
const skip = havePython ? false : 'python3 with PyYAML is not installed';

const { ROOT, PY, nodeState, nodeReport, pyReport, tmpRegistry } = require('./helpers/parity.js');

const same = (root, label) => assert.deepEqual(pyReport(root), nodeReport(root), label);

test('the sample registry gives the documented result in both implementations', { skip }, () => {
  const root = path.join(ROOT, 'sample-registry');
  const py = pyReport(root);
  const errs = py.findings.filter(f => !f.suppressed && f.sev === 'error').map(f => f.code).sort();
  const warns = py.findings.filter(f => !f.suppressed && f.sev === 'warning').map(f => f.code).sort();
  assert.deepEqual(errs, ['DC002', 'DC004']);
  assert.deepEqual(warns, ['DC001', 'DC003', 'DC005', 'DC006', 'DC008']);
  assert.equal(py.findings.filter(f => f.suppressed).length, 1);
  same(root, 'sample-registry');
});

test('fixtures/fullstack agrees', { skip }, () => same(path.join(ROOT, 'fixtures', 'fullstack'), 'fullstack'));

const MODEL = `workspace "Shop" {
  model {
    u = person "User"
    web = softwareSystem "Web" {
      api = container "Api" "" "ASP.NET" {
        properties { "d.instances" "1" "d.critical" "yes" "d.availability" "0.999" "d.zone" "dmz" }
      }
      db = container "Orders DB" "" "SQL" "Database" {
        properties { "d.availability" "0.9999" "d.zone" "data" "d.suppress" "DC006: audited" "d.latency.max" "300" }
      }
      wk = container "Worker" { properties { "d.instances" "3" "d.zone" "data" "d.availability" 0.99 } }
      q = container "Queue"
    }
    u -> api "uses"
    api -> db "writes" "TCP" { properties { "d.interaction" "sync" "d.writes" "order" "d.concurrency" "none" "d.encrypted" "no" "d.timeout" "100" } }
    wk -> db "writes" { properties { "d.writes" "order" "d.interaction" "sync" "d.retry" "fixed" "d.idempotent" "no" } }
    api -> q "emits" { properties { "d.interaction" "async" "d.delivery" "at-least-once" "d.idempotent" "no" } }
    wk -> q "reads" { properties { "d.intraction" "async" "d.retry.max" "x" } }
    api -> wk "calls" { properties { "d.interaction" "sync" "d.retry" "fixed" "d.retry.max" "9" "d.idempotent" "yes" "d.timeout" "40" } }
    wk -> api "calls back" { properties { "d.timeout" "50" "d.fanout" "parallel" } }
  }
  views { systemContext web { include * } }
}
/* c */ // d
# e
`;

test('a synthetic model with every rule agrees', { skip }, () => {
  same(tmpRegistry({ 'model/workspace.dsl': MODEL }), 'every rule');
});

test('parse errors, unknown keywords and unbalanced braces agree', { skip }, () => {
  same(tmpRegistry({ 'model/workspace.dsl': 'workspace { model { a = person "A"\n a -> zz "x"\n bogus "x"\n b = container }\n' }), 'errors');
  same(tmpRegistry({ 'model/workspace.dsl': 'workspace { model { a = person "A" } } }\n properties { "k" }' }), 'errors 2');
});

test('deployment environments parse the same', { skip }, () => {
  const dsl = `workspace { model {
    s = softwareSystem "S" { a = container "A" }
    deploymentEnvironment "Live" {
      deploymentNode "Azure" { deploymentNode "Zone A" "" "" "" 2 { containerInstance a } }
      deploymentNode "Bad" { containerInstance nope }
      web = deploymentNode "Web" { containerInstance a }
      web -> nowhere "x"
      -> web "self" { properties { "k" "v" } }
    }
    views { deployment s "Live" "ok" { include * }
      deployment * Ghost { include * }
      deployment nowhere Live "bad-scope" { include * }
      deployment a Live "container-scope" { include * }
      deployment * Live "all" { include * }
      systemContext s "ctx" { include * } }
  } }`;
  same(tmpRegistry({ 'model/workspace.dsl': dsl }), 'deployment');
});

test('decisions, fingerprints, business evidence, requirements, ledger and scenarios agree', { skip }, () => {
  const root = tmpRegistry({
    'model/workspace.dsl': MODEL,
    'designc.json': JSON.stringify({ model: 'model/workspace.dsl', evidenceHosts: ['jira.example.com'], businessOwners: ['mike'] }),
    'decisions/D-9.yaml': 'id: D-9\nstatus: bound\nkind: business\nrequirement: R-1\npromoted_by: mike\npromoted_against: [{requirement: R-1, version: 2}]\n',
    'decisions/D-10.yaml': 'id: D-10\nstatus: bound\nkind: business\nrequirement: R-1\npromoted_by: sam\npromoted_against: [{requirement: R-1, version: 2}]\n',
    'decisions/D-1.yaml': 'id: D-1\nstatus: bound\neffect: fix\nbinds: Orders DB\nresolves: [DC002]\nchecks: [p check]\n',
    'decisions/D-2.yaml': 'id: D-2\nstatus: bound\nkind: business\nrequirement: R-1\nevidence: https://other.example.com/x\npromoted_against: [{requirement: R-1, version: 1}]\n',
    'decisions/D-3.yaml': 'id: D-3\nstatus: bound\neffect: accept\nbinds: [Api]\nresolves: [DC005]\nchecks: [x]\npromoted_against: [{element: api, name: Api, hash: deadbeefdeadbeef}]\n',
    'decisions/D-5.yaml': 'id: D-5\nstatus: bound\nkind: business\nrequirement: R-1\nevidence: https://jira.example.com/x\nassumptions:\n  - {text: Old volume figure, review_by: 2020-01-05}\n  - {text: Fine, review_by: 2999-01-01}\n  - {text: No date}\n  - {text: "🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀", review_by: 2020-02-02}\npromoted_against: [{requirement: R-1, version: 2}]\n',
    'decisions/D-6.yaml': 'id: D-6\nstatus: bound\neffect: accept\nbinds: [Api]\nresolves: [DC005]\nchecks: ["TODO command that proves it"]\nrelies_on: [D-5]\n',
    'decisions/D-7.yaml': 'id: D-7\nstatus: bound\neffect: accept\nbinds: [Api]\nresolves: [DC005]\nrelies_on: [D-5]\n',
    'decisions/D-8.yaml': 'id: D-8\nstatus: bound\neffect: fix\nchecks: ["TODO command that proves it"]\n',
    'decisions/D-4.yaml': 'id: D-4\nkind: weird\nstatus: minted\n',
    'decisions/D-4b.yaml': 'id: D-4\nstatus: minted\n',
    'decisions/broken.yaml': 'id: [unclosed\n',
    'requirements/R-1.yaml': 'id: R-1\nversion: 2\nelements: [Nope]\n',
    'requirements/R-2.yaml': 'id: R-2\nelements: [Api]\n',
    'scenarios/S-1.yaml': 'id: S-1\nattribute: availability\nartifact: Api\nmeasure: {metric: availability, op: ">=", value: 99.9}\nfitness: [run it]\n',
    'scenarios/S-2.yaml': 'id: S-2\nattribute: latency\nartifact: Ghost\nmeasure: {metric: p95, op: "<=", value: 200}\n',
    'scenarios/S-3.yaml': 'id: S-3\ntitle: incomplete\n',
    'scenarios/S-4.yaml': 'id: S-4\nattribute: latency\nartifact: Api\nmeasure: {metric: p95, op: "<=", value: 200}\nimportance: urgent\ndifficulty: high\n',
    'ledger/a.jsonl': [
      { kind: 'check', decision: 'D-1', outcome: 'pass', ts: 5 },
      { schema_version: 1, event_id: 'e1', ts: 10, kind: 'check', by: 'x', decision: 'D-3', check: 'x', outcome: 'fail', source: 'local', exit_code: 1 },
      { schema_version: 1, event_id: 'e2', ts: 11, kind: 'needs_decision', by: 'x', id: 'N-1', question: 'which?', status: 'open' },
      { schema_version: 1, event_id: 'e3', ts: 12, kind: 'needs_decision', by: 'x', id: 'N-2', question: 'done?', status: 'open' },
      { schema_version: 1, event_id: 'e4', ts: 13, kind: 'needs_decision_resolved', by: 'x', id: 'N-2' },
      { schema_version: 1, event_id: 'e1', ts: 10, kind: 'check', by: 'x', decision: 'D-3', check: 'x', outcome: 'fail', source: 'local', exit_code: 1 },
      { schema_version: 1, event_id: 'f1', ts: 14, kind: 'fitness', by: 'x', scenario: 'S-1', check: 'run it', outcome: 'fail', source: 'local', exit_code: 2 },
    ].map(e => JSON.stringify(e)).join('\n') + '\nnot json\n',
  });
  same(root, 'registry');
});

test('a bound decision with a current fingerprint matches Core.fingerprint', { skip }, () => {
  const model = Core.parse(MODEL);
  const el = [...model.elements.values()].find(e => e.name === 'Orders DB');
  const hash = Core.fingerprint(model, el.id).hash;
  const root = tmpRegistry({
    'model/workspace.dsl': MODEL,
    'decisions/D-1.yaml': `id: D-1\nstatus: bound\neffect: accept\nbinds: [Orders DB]\nresolves: [DC002]\nchecks: [x]\nrelies_on: [D-0]\npromoted_against: [{element: db, name: Orders DB, hash: "${hash}"}]\n`,
    'ledger/c.jsonl': JSON.stringify({ kind: 'check', decision: 'D-1', outcome: 'pass', ts: 1 }) + '\n',
  });
  const py = pyReport(root);
  assert.ok(!py.gate.clauses.some(c => /D-1: Orders DB changed since promotion/.test(c.text)), 'python computed the same fingerprint');
  same(root, 'fingerprint');
});

test('unicode in names hashes the same (UTF-16 code units)', { skip }, () => {
  const dsl = 'workspace { model { a = container "Café 🚀" { properties { "d.zone" "zé" } } } }';
  const model = Core.parse(dsl);
  const id = [...model.elements.keys()][0];
  const hash = Core.fingerprint(model, id).hash;
  const root = tmpRegistry({
    'model/workspace.dsl': dsl,
    'decisions/D-1.yaml': `id: D-1\nstatus: bound\nbinds: [Café 🚀]\nchecks: [x]\npromoted_against: [{element: a, name: "Café 🚀", hash: "${hash}"}]\n`,
  });
  assert.ok(!pyReport(root).gate.clauses.some(c => /changed since promotion/.test(c.text)));
});

test('exit codes: 0 ready, 1 not ready, 2 unusable folder', { skip }, () => {
  const run = root => spawnSync('python3', ['-m', 'designc', 'check', root, '--no-record'], { cwd: PY, encoding: 'utf8' });
  const clean = tmpRegistry({ 'model/workspace.dsl': 'workspace { model { a = person "A" } }' });
  assert.equal(run(clean).status, 0);
  assert.equal(run(path.join(ROOT, 'sample-registry')).status, 1);
  const none = run(path.join(os.tmpdir(), 'designc-does-not-exist'));
  assert.equal(none.status, 2);
  assert.match(none.stderr, /model\/workspace\.dsl/);
});

// ---- slice 13a: gate events and the Python ledger append path
const py = (code, input) => {
  const r = spawnSync('python3', ['-c', code], { cwd: PY, encoding: 'utf8', input });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const pyGateRecord = root => py(`import json, sys
from designc.cli import state
from designc.record import gate_record
s = state(sys.argv[1] if len(sys.argv) > 1 else ${JSON.stringify(root)})
print(json.dumps(gate_record(s['model_text'], s['diags'], s['gate'], 'local', None), ensure_ascii=False))`);
const nodeGateRecord = root => { const s = nodeState(root); return Core.gateRecord({ modelText: s.modelText, diags: s.diags, gate: s.gate, source: 'local', git: null }); };

test('the gate record is identical in both implementations', { skip }, () => {
  for (const root of [path.join(ROOT, 'sample-registry'), path.join(ROOT, 'fixtures', 'fullstack'), tmpRegistry({ 'model/workspace.dsl': MODEL }),
    tmpRegistry({ 'model/workspace.dsl': 'workspace { model { a = container "Café 🚀" { properties { "d.zone" "zé" } }\n b = container "Ünïcode → x"\n a -> b "x" { properties { "d.interaction" "async" } } } }' })]) {
    assert.deepEqual(pyGateRecord(root), nodeGateRecord(root), root);
  }
});

test('the Python validator gives the same errors as Ledger.validate', { skip }, () => {
  const gate = { kind: 'gate', by: 'u', source: 'local', revision: 'r-1', ready: false, verdict: 'v', clauses: [], findings: [] };
  const cases = [
    gate, { ...gate, commit: null, dirty: false }, { ...gate, ready: 'yes' }, { ...gate, source: 'ci' }, { ...gate, findings: {} }, { ...gate, extra: 1 },
    { kind: 'check', by: 'u', decision: 'D', check: 'x', outcome: 'fail', source: 'local' },
    { kind: 'check', by: 'u', decision: 'D', check: 'x', outcome: 'fail', source: 'local', reason: 'r' },
    { kind: 'escape', by: 'u', id: 'E-1', description: 'd', caught_by: 'S9' },
    { kind: 'escape_classified', by: 'u', escape: 'E-1', caught_by: null },
    { kind: 'handover', by: 'u', handover: 'h', revision: 'r', dirty: 1 },
    { kind: 'nope', by: 'u' }, { kind: 'gate' }, { ...gate, ts: '2026' }, { ...gate, _x: 1 }, { ...gate, schema_version: 2 }, { ...gate, payload: [] },
    { ...gate, envelope_version: 1 }, 'not an object',
  ];
  const got = py(`import json, sys
from designc.ledger import validate
print(json.dumps([validate(e) for e in json.load(sys.stdin)]))`, JSON.stringify(cases));
  assert.deepEqual(got, cases.map(e => Ledger.validate(e)));
});

test('Python appends a stamped, valid gate event to ledger/checks.jsonl, and refuses an invalid one', { skip }, () => {
  const root = tmpRegistry({ 'model/workspace.dsl': 'workspace { model { a = person "A" } }' });
  const ev = { kind: 'gate', by: 'u', source: 'local', revision: 'r-1', ready: true, verdict: 'v', clauses: [], findings: [] };
  const ok = py(`import json, sys
from designc.ledger import append_event
print(json.dumps(append_event(sys.argv[1] if len(sys.argv) > 1 else ${JSON.stringify(root)}, json.load(sys.stdin))))`, JSON.stringify(ev));
  assert.equal(ok.ok, true);
  const lines = fs.readFileSync(path.join(root, 'ledger', 'checks.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]);
  assert.deepEqual(Ledger.validate(line), []);
  assert.equal(line.schema_version, 1);
  assert.match(line.event_id, /^[0-9a-f-]{36}$/);
  assert.equal(typeof line.ts, 'number');
  const parsed = Ledger.parse(lines[0] + '\n', 'ledger/checks.jsonl');
  assert.equal(parsed.events.length, 1);
  const bad = py(`import json, sys
from designc.ledger import append_event
print(json.dumps(append_event(${JSON.stringify(root)}, json.load(sys.stdin))))`, JSON.stringify({ ...ev, ready: 'yes' }));
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, ['gate.ready: must be a boolean']);
  assert.equal(fs.readFileSync(path.join(root, 'ledger', 'checks.jsonl'), 'utf8').trim().split('\n').length, 1, 'nothing written');
});

test('Python gate_unchanged agrees with Ledger.gateUnchanged', { skip }, () => {
  const g = o => ({ kind: 'gate', source: 'local', revision: 'r-1', commit: 'c1', verdict: 'v1', _ts: 1, ...o });
  const noGit = g({}); delete noGit.commit;
  const cases = [[[], g({})], [[g({})], g({})], [[g({}), g({ _ts: 2, verdict: 'v0' })], g({})], [[g({ source: 'pipeline' })], g({})],
    [[g({ commit: 'c0' })], g({})], [[g({ commit: null })], noGit], [[{ kind: 'check', source: 'local', _ts: 9 }, g({})], g({})]];
  const got = py(`import json, sys
from designc.ledger import gate_unchanged
print(json.dumps([gate_unchanged(evs, ev) for evs, ev in json.load(sys.stdin)]))`, JSON.stringify(cases));
  assert.deepEqual(got, cases.map(([evs, ev]) => Ledger.gateUnchanged(evs, ev)));
});

test('d.code problems (rejected patterns, empty, blank entry, no d.risk) agree', { skip }, () => {
  const dsl = `workspace { model { s = softwareSystem "S" {
    a = container "A" { properties { "d.code" "src/A/**, ../x, src/[ab]" "d.risk" "low" } }
    b = container "B" { properties { "d.code" " , " "d.risk" "low" } }
    c = container "C" { properties { "d.code" "src/C/**, , ./src\\\\D/" "d.risk" "high" } }
    d = container "D" { properties { "d.code" "src/E/**" } }
    e = container "E" { properties { "d.code" "src/F/**" "d.risk" "medium" } }
  } } }`;
  const root = tmpRegistry({ 'model/workspace.dsl': dsl });
  assert.equal(nodeReport(root).findings.filter(f => f.code === 'DC000').length, 5);
  same(root, 'd.code');
});

test('DC009 overlapping and nested code areas agree', { skip }, () => {
  const dsl = `workspace { model { s = softwareSystem "S" {
    a = container "A" { properties { "d.code" "src/A/**" "d.risk" "low" }
      h = component "H" { properties { "d.code" "src/A/H/**" "d.risk" "low" } }
    }
    b = container "B" { properties { "d.code" "src/B/**, src/*.props" "d.risk" "low" } }
    c = container "C" { properties { "d.code" "src/A/x.cs, src/B/*" "d.risk" "low" } }
    d = container "D" { properties { "d.code" "src/a*" "d.risk" "low" "d.suppress" "DC009: shared props, agreed" } }
    e = container "E" { properties { "d.code" "src/E/**" "d.risk" "low" } }
  } } }`;
  const root = tmpRegistry({ 'model/workspace.dsl': dsl });
  assert.equal(nodeReport(root).findings.filter(f => f.code === 'DC009').length, 4);
  same(root, 'DC009');
});
