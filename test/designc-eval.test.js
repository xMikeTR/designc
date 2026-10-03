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
  a = container "Agent" "" "MAF" { properties { "d.agent.autonomy" "approve-writes" "d.agent.eval" "e1" } }
  q = container "Advisor" "" "MAF" { properties { "d.agent.autonomy" "suggest" } }
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
