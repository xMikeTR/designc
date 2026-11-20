const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROOT, PY, tmpRegistry } = require('./helpers/parity.js');

const skip = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';
const run = (root, ...args) => spawnSync('python3', ['-m', 'designc', 'eval', root, ...args], { cwd: PY, encoding: 'utf8', env: { ...process.env, CI: '', GITHUB_ACTIONS: '', TF_BUILD: '', GITLAB_CI: '' } });
const gate = root => spawnSync('python3', ['-m', 'designc', 'check', root, '--no-record'], { cwd: PY, encoding: 'utf8' });
const MOCK = path.join(ROOT, 'dev', 'mock-eval.js');
const DSL = `workspace { model { s = softwareSystem "S" {
  a = container "Agent" "" "MAF" { properties { "d.agent.pattern" "single-call" "d.agent.autonomy" "approve-writes" "d.agent.eval" "e1" } }
  q = container "Advisor" "" "MAF" { properties { "d.agent.pattern" "single-call" "d.agent.autonomy" "suggest" } }
} } }
`;
const reg = (command = `node ${MOCK} evals/r.json`) => tmpRegistry({
  'model/workspace.dsl': DSL,
  'evals/e1.yaml': `id: e1\nagent: Agent\ncommand: ${command}\nresults: evals/r.json\nthresholds:\n  - task_success >= 0.85\n`,
});
const events = root => fs.readFileSync(path.join(root, 'ledger/checks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('a passing eval is recorded and clears the gate', { skip }, () => {
  const root = reg();
  assert.match(gate(root).stdout, /needs a passing eval/);
  const r = run(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /pass {2}e1/);
  assert.match(r.stdout, /warning {2}Advisor \(suggest\)/);
  const [ev] = events(root);
  assert.equal(ev.kind, 'eval'); assert.equal(ev.outcome, 'pass'); assert.equal(ev.source, 'local'); assert.equal(ev.cases, 40);
  assert.match(gate(root).stdout, /Ready for handover/);
});

test('a failing eval exits 1 and records the reason', { skip }, () => {
  const root = reg(`MOCK_EVAL_SCORE=0.5 node ${MOCK} evals/r.json`);
  const r = run(root, '--source', 'pipeline');
  assert.equal(r.status, 1);
  const [ev] = events(root);
  assert.equal(ev.outcome, 'fail'); assert.equal(ev.source, 'pipeline'); assert.match(ev.reason, /task_success 0.5 is not >= 0.85/);
  assert.match(gate(root).stdout, /eval e1 failed/);
});

test('a results file that is not JSON fails with a reason', { skip }, () => {
  const root = reg(`MOCK_EVAL_BROKEN=1 node ${MOCK} evals/r.json`);
  assert.equal(run(root).status, 1);
  assert.match(events(root)[0].reason, /could not be read as JSON/);
});

test('an unknown --id and an unreadable registry exit 2', { skip }, () => {
  assert.equal(run(reg(), '--id', 'nope').status, 2);
  assert.equal(run('/nonexistent/registry').status, 2);
});

// ---- `designc-core eval` is the command; `python -m designc eval` is a shim over it
const core = (root, ...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/designc-core.js'), 'eval', root, ...args], { encoding: 'utf8', env: { ...process.env, CI: '', GITHUB_ACTIONS: '', TF_BUILD: '', GITLAB_CI: '' } });
const strip = ev => { const { event_id, ts, ms, by, ...rest } = ev; return rest; };

test('the core eval and the shim print the same and record the same rows', { skip }, () => {
  const a = reg(), b = reg();
  const ra = core(a), rb = run(b);
  assert.equal(ra.status, 0, ra.stdout + ra.stderr);
  assert.equal(ra.stdout, rb.stdout); assert.equal(ra.status, rb.status);
  assert.deepEqual(events(a).map(strip), events(b).map(strip));
  const [ev] = events(a);
  assert.equal(ev.schema_version, 1); assert.equal(ev.exit_code, 0); assert.match(ev.fingerprint, /^[0-9a-f]{16}$/); assert.match(ev.eval_hash, /^[0-9a-f]{16}$/);
});

test('--id runs one eval; an invalid definition and an eval for another agent fail without running', { skip }, () => {
  const root = tmpRegistry({
    'model/workspace.dsl': DSL,
    'evals/e1.yaml': `id: e1\nagent: Someone else\ncommand: node ${MOCK} evals/r.json\nresults: evals/r.json\nthresholds:\n  - task_success >= 0.85\n`,
  });
  const r = core(root, '--id', 'e1');
  assert.equal(r.status, 1); assert.match(r.stdout, /fail {2}e1: eval is for "Someone else", not Agent/);
  assert.equal(fs.existsSync(path.join(root, 'ledger/checks.jsonl')), false);
  const bad = tmpRegistry({ 'model/workspace.dsl': DSL, 'evals/e1.yaml': 'id: e1\nagent: Agent\n' });
  const rb = core(bad);
  assert.equal(rb.status, 1); assert.match(rb.stdout, /fail {2}e1: needs command, results; needs thresholds/);
});

test('a failing command exit code fails a passing score, with the reason', { skip }, () => {
  const root = reg(`node ${MOCK} evals/r.json; exit 3`);
  const r = core(root);
  assert.equal(r.status, 1);
  const [ev] = events(root);
  assert.equal(ev.outcome, 'fail'); assert.equal(ev.exit_code, 3); assert.equal(ev.reason, 'the command exited with 3');
});

test('eval through the shim without Node reports could not run (exit 2)', () => {
  const empty = fs.mkdtempSync(path.join(require('os').tmpdir(), 'designc-nonode-'));
  const py3 = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim();
  const r = spawnSync(py3, ['-m', 'designc', 'eval', reg()], { cwd: PY, encoding: 'utf8', env: { PATH: empty } });
  assert.equal(r.status, 2); assert.match(r.stderr, /could not run/);
});
