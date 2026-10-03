// designc, not the eval runner, decides pass or fail: the runner reports metrics, the thresholds in evals/<id>.yaml judge them.
// JS (Core.parseThreshold, Core.scoreEval) and Python (designc.evals) must agree case by case.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const Core = require('../renderer/core.js');

const PY = path.join(__dirname, '..', 'python');
const havePython = spawnSync('python3', ['-c', 'import yaml']).status === 0;
const skip = havePython ? false : 'python3 with PyYAML is not installed';

test('parseThreshold reads metric, operator and number', () => {
  assert.deepEqual(Core.parseThreshold('task_success >= 0.85'), { metric: 'task_success', op: '>=', value: 0.85 });
  assert.deepEqual(Core.parseThreshold('  p95_latency_ms<=1200 '), { metric: 'p95_latency_ms', op: '<=', value: 1200 });
  assert.deepEqual(Core.parseThreshold('errors == 0'), { metric: 'errors', op: '==', value: 0 });
  assert.deepEqual(Core.parseThreshold('cost.per_task < 0.5'), { metric: 'cost.per_task', op: '<', value: 0.5 });
});

test('parseThreshold refuses anything else', () => {
  for (const bad of ['task_success', '>= 0.5', 'a => 1', 'a >= x', 'a >= 1 && b >= 2', '', 7, null])
    assert.ok(Core.parseThreshold(bad).error, `expected an error for ${JSON.stringify(bad)}`);
});

const def = { id: 'e1', thresholds: ['task_success >= 0.85', 'p95_latency_ms <= 1200'] };

test('scoreEval passes when every threshold is met', () => {
  const r = Core.scoreEval(def, { metrics: { task_success: 0.9, p95_latency_ms: 800 }, cases: 40 });
  assert.equal(r.outcome, 'pass');
  assert.equal(r.cases, 40);
  assert.deepEqual(r.metrics, { task_success: 0.9, p95_latency_ms: 800 });
  assert.deepEqual(r.thresholds.map(t => t.ok), [true, true]);
});

test('scoreEval fails with a reason naming each unmet threshold', () => {
  const r = Core.scoreEval(def, { metrics: { task_success: 0.8, p95_latency_ms: 800 }, cases: 40 });
  assert.equal(r.outcome, 'fail');
  assert.equal(r.reason, 'task_success 0.8 is not >= 0.85');
});

test('scoreEval fails when a judged metric is missing', () => {
  const r = Core.scoreEval(def, { metrics: { task_success: 0.9 }, cases: 3 });
  assert.equal(r.outcome, 'fail');
  assert.equal(r.reason, 'p95_latency_ms is missing from the results');
});

test('scoreEval returns an error, not a verdict, for results or an eval it cannot read', () => {
  assert.match(Core.scoreEval(def, null).error, /results must be an object/);
  assert.match(Core.scoreEval(def, { metrics: { a: 'x' }, cases: 1 }).error, /metrics/);
  assert.match(Core.scoreEval(def, { metrics: {}, cases: 1.5 }).error, /cases/);
  assert.match(Core.scoreEval(def, { metrics: {} }).error, /cases/);
  assert.match(Core.scoreEval({ id: 'e', thresholds: [] }, { metrics: {}, cases: 1 }).error, /no thresholds/);
  assert.match(Core.scoreEval({ id: 'e', thresholds: ['nonsense'] }, { metrics: {}, cases: 1 }).error, /nonsense/);
});

const PARITY = [
  [def, { metrics: { task_success: 0.9, p95_latency_ms: 800 }, cases: 40 }],
  [def, { metrics: { task_success: 0.8, p95_latency_ms: 2000 }, cases: 40 }],
  [def, { metrics: { task_success: 1.0, p95_latency_ms: 800.5 }, cases: 0 }],
  [def, { metrics: { task_success: 0.9 }, cases: 3 }],
  [def, null],
  [def, { metrics: { a: 'x' }, cases: 1 }],
  [def, { metrics: {}, cases: -1 }],
  [{ id: 'e', thresholds: [] }, { metrics: {}, cases: 1 }],
  [{ id: 'e', thresholds: ['x ~ 1'] }, { metrics: {}, cases: 1 }],
  [{ id: 'e', thresholds: ['x == 1', 'y > 2'] }, { metrics: { x: 1, y: 2 }, cases: 2 }],
];

test('Python scoreEval agrees with JS on every case', { skip }, () => {
  const py = `import json,sys\nfrom designc.evals import score_eval\nprint(json.dumps([score_eval(d, r) for d, r in json.load(sys.stdin)]))`;
  const r = spawnSync('python3', ['-c', py], { cwd: PY, input: JSON.stringify(PARITY), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  PARITY.forEach(([d, res], i) => assert.deepEqual(got[i], JSON.parse(JSON.stringify(Core.scoreEval(d, res))), `case ${i}`));
});
