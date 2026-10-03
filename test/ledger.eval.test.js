// The `eval` ledger kind: what a run of evals/<id>.yaml leaves behind, under a fingerprint and the eval file's hash.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Ledger = require('../renderer/ledger.js');
const store = require('../ledger-store.js');

const PY = path.join(__dirname, '..', 'python');
const skip = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';

const GOOD = { kind: 'eval', by: 'u', eval: 'task-agent-evals', agent: 'Task agent', outcome: 'pass', metrics: { task_success: 0.9 }, cases: 40, source: 'local', fingerprint: '0123456789abcdef', eval_hash: 'fedcba9876543210' };

test('a valid eval event validates and is routed to checks.jsonl', () => {
  assert.deepEqual(Ledger.validate(GOOD), []);
  assert.equal(Ledger.KINDS.eval.stream, 'checks.jsonl');
});

test('an eval event needs every field, the right types and evidence for a failure', () => {
  for (const f of ['eval', 'agent', 'outcome', 'metrics', 'cases', 'source', 'fingerprint', 'eval_hash']) {
    const { [f]: _, ...rest } = GOOD;
    assert.ok(Ledger.validate(rest).some(e => e.includes(`eval.${f}`)), `${f} should be required`);
  }
  assert.ok(Ledger.validate({ ...GOOD, outcome: 'passed' }).length);
  assert.ok(Ledger.validate({ ...GOOD, source: 'remote' }).length);
  assert.ok(Ledger.validate({ ...GOOD, metrics: [1] }).length);
  assert.ok(Ledger.validate({ ...GOOD, metrics: null }).length);
  assert.ok(Ledger.validate({ ...GOOD, cases: '40' }).length);
  assert.ok(Ledger.validate({ ...GOOD, outcome: 'fail' }).length);
  assert.deepEqual(Ledger.validate({ ...GOOD, outcome: 'fail', reason: 'task_success 0.8 is not >= 0.85' }), []);
});

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'designc-eval-')); }

test('the JS append path writes an eval event and refuses an invalid one', async () => {
  const root = tmp();
  assert.ok((await store.appendEvent(root, GOOD)).ok);
  const lines = fs.readFileSync(path.join(root, 'ledger', 'checks.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).eval, 'task-agent-evals');
  const bad = await store.appendEvent(root, { ...GOOD, metrics: 'x' });
  assert.equal(bad.ok, false);
  assert.equal(fs.readFileSync(path.join(root, 'ledger', 'checks.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('the Python append path gives the same verdicts', { skip }, () => {
  const run = ev => {
    const root = tmp();
    const py = `import json,sys\nfrom designc.ledger import append_event\nprint(json.dumps(append_event(sys.argv[1], json.loads(sys.argv[2]))))`;
    const r = spawnSync('python3', ['-c', py, root, JSON.stringify(ev)], { cwd: PY, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return { out: JSON.parse(r.stdout), root };
  };
  const ok = run(GOOD);
  assert.equal(ok.out.ok, true);
  assert.ok(fs.existsSync(path.join(ok.root, 'ledger', 'checks.jsonl')));
  for (const bad of [{ ...GOOD, metrics: [1] }, { ...GOOD, cases: '40' }, { ...GOOD, outcome: 'fail' }, { ...GOOD, source: 'remote' }]) {
    const r = run(bad);
    assert.equal(r.out.ok, false);
    assert.deepEqual(r.out.errors, Ledger.validate(bad));
    assert.equal(fs.existsSync(path.join(r.root, 'ledger')), false);
  }
});
