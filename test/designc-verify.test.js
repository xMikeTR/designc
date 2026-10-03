// verify-ledger: the Python rules give exactly the JS result, and the command's exit codes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Ledger = require('../renderer/ledger.js');

const PY = path.join(__dirname, '..', 'python');
const skip = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';
let n = 0;
const ev = (kind, f = {}) => ({ schema_version: 1, event_id: `e${++n}`, ts: 1000 + n, kind, by: 'me', ...f });
const gate = (f = {}) => ev('gate', { source: 'local', revision: 'r-aaaa1111', ready: true, verdict: 'v', clauses: [], findings: [], ...f });
const handover = (f = {}) => ev('handover', { handover: 'H-1', revision: 'aaaa1111', ...f });
const jl = list => list.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n') + '\n';
const pyVerify = (files, opts) => {
  const r = spawnSync('python3', ['-c', 'import json,sys\nfrom designc.verify import verify\nd=json.load(sys.stdin)\nprint(json.dumps(verify(d["files"],d["handovers"],d["decisions"],d.get("handoverEvals"))))'],
    { cwd: PY, encoding: 'utf8', input: JSON.stringify({ files, ...opts }) });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const dup = gate({ event_id: 'dup' });
const CASES = {
  clean: { files: [['checks', [gate(), handover()]]], handovers: ['H-1'] },
  v1: { files: [['checks', [gate({ revision: 'r-x' }), handover()]]], handovers: ['H-1'] },
  v1red: { files: [['checks', [gate({ ready: false }), handover()]]], handovers: ['H-1'] },
  v1predates: { files: [['checks', [handover({ ts: 1 }), gate({ ts: 5 })]]], handovers: ['H-1'] },
  v2: { files: [['checks', [gate(), handover({ dirty: true })]]], handovers: ['H-1'] },
  v3: { files: [['checks', [ev('decision_promoted', { decision: 'D-1' }), ev('decision_promoted', { decision: 'D-2' })]]], decisions: [{ id: 'D-1' }, { id: 'D-2', kind: 'business' }] },
  v3late: { files: [['checks', [ev('decision_promoted', { decision: 'D-1', ts: 5 }), ev('check', { decision: 'D-1', check: 'c', outcome: 'pass', source: 'local', ts: 6 })]]], decisions: [{ id: 'D-1', kind: 'technical' }] },
  v4: { files: [['checks', ['nope', '[1]', { ...gate(), verdict: undefined }, { schema_version: 2, kind: 'gate' }, { schema_version: 1, envelope_version: 1, kind: 'gate' }, { kind: 'task', task: 'T', status: 'passed' }, { envelope_version: 1, kind: 'SessionStarted' }, gate()]]] },
  v4unicode: { files: [['checks', [gate({ clauses: [{ kind: 'x', text: 'Büro ☃' }] }), ev('handover', { handover: 'Ünï', revision: 7 })]]], handovers: ['Ünï'] },
  v5: { files: [['a', [dup]], ['b', [{ ...dup, ready: false }]]] },
  v5same: { files: [['a', [dup]], ['b', [{ ...dup }]]] },
  v6: { files: [['checks', [ev('unapproved_change', { agent: 'claude', role: 'architect', path: 'model/workspace.dsl', via: 'acp' })]]] },
  v7: { files: [['checks', [gate(), handover(), ev('handover', { handover: 'H-2', revision: 'aaaa1111' })]]], handovers: ['H-1', 'H-9'] },
  v8: { files: [['checks', [gate(), handover(), ev('eval', { eval: 'EV-1', agent: 'A', outcome: 'pass', metrics: { m: 1 }, cases: 1, source: 'pipeline', fingerprint: 'f', eval_hash: 'new' })]]], handovers: ['H-1'], handoverEvals: { 'H-1': { 'EV-1': 'old' } } },
  v8ok: { files: [['checks', [gate(), handover(), ev('eval', { eval: 'EV-1', agent: 'A', outcome: 'pass', metrics: { m: 1 }, cases: 1, source: 'pipeline', fingerprint: 'f', eval_hash: 'old' })]]], handovers: ['H-1'], handoverEvals: { 'H-1': { 'EV-1': 'old' } } },
  sample: { files: [['checks', [gate({ sample: true }), handover({ sample: true, dirty: true })]]], decisions: [] },
  order: { files: [['z', ['bad']], ['a', ['worse']]] },
};

for (const [name, c] of Object.entries(CASES)) {
  test(`verify parity: ${name}`, { skip }, () => {
    const files = c.files.map(([f, list]) => ({ path: `ledger/${f}.jsonl`, text: jl(list) }));
    const opts = { handovers: c.handovers || [], decisions: c.decisions || [], handoverEvals: c.handoverEvals };
    assert.deepEqual(pyVerify(files, opts), JSON.parse(JSON.stringify(Ledger.verify(files, opts))));
  });
}

const run = (root, args = []) => spawnSync('python3', ['-m', 'designc', 'verify-ledger', root, ...args], { cwd: PY, encoding: 'utf8' });
const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const reg = () => fs.mkdtempSync(path.join(os.tmpdir(), 'designc-ver-'));

test('verify-ledger: exit 0 when clean, 1 with errors, 2 when the folder is missing', { skip }, () => {
  const root = reg();
  put(root, 'ledger/checks.jsonl', jl([gate(), handover()]));
  put(root, 'handovers/H-1/handover.yaml', 'id: H-1\nrevision: r-aaaa1111\n');
  const ok = run(root);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /Ledger is consistent/);
  put(root, 'ledger/checks.jsonl', jl([gate(), handover({ dirty: true })]));
  const bad = run(root);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /V2  error/);
  assert.equal(JSON.parse(run(root, ['--json']).stdout).errors[0].rule, 'V2');
  assert.equal(run(path.join(root, 'missing')).status, 2);
});

test('verify-ledger finds flat and folder handovers and decision kinds on disk', { skip }, () => {
  const root = reg();
  put(root, 'ledger/checks.jsonl', jl([gate(), handover(), ev('handover', { handover: 'H-2', revision: 'aaaa1111' }), ev('decision_promoted', { decision: 'D-1' }), ev('decision_promoted', { decision: 'D-2' })]));
  put(root, 'handovers/H-1/handover.yaml', 'id: H-1\n');
  put(root, 'handovers/H-2.yaml', 'id: H-2\n');
  put(root, 'decisions/D-1.yaml', 'id: D-1\nkind: business\n');
  put(root, 'decisions/D-2.yaml', 'id: D-2\n');
  const r = JSON.parse(run(root, ['--json']).stdout);
  assert.deepEqual(r.errors.map(e => e.rule), ['V3']);
  assert.match(r.errors[0].msg, /D-2/);
});

test('verify-ledger V8 reads the evals a handover froze from handover.yaml', { skip }, () => {
  const root = reg();
  const e = hash => ev('eval', { eval: 'EV-1', agent: 'A', outcome: 'pass', metrics: { m: 1 }, cases: 1, source: 'pipeline', fingerprint: 'f', eval_hash: hash });
  put(root, 'handovers/H-1/handover.yaml', 'id: H-1\nrevision: r-aaaa1111\nevals: {"EV-1": "abc"}\n');
  put(root, 'ledger/checks.jsonl', jl([gate(), handover(), e('abc')]));
  assert.equal(run(root).status, 0);
  put(root, 'ledger/checks.jsonl', jl([gate(), handover(), e('xyz')]));
  const r = JSON.parse(run(root, ['--json']).stdout);
  assert.deepEqual(r.errors.map(x => x.rule), ['V8']);
});

test('the sample registry has a consistent ledger', { skip }, () => {
  assert.equal(run(path.join(__dirname, '..', 'sample-registry')).status, 0);
});
