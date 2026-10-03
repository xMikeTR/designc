const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../renderer/ledger.js');

const ev = (outcome, ts, metrics, o = {}) => ({ kind: 'eval', eval: 'EV-1', agent: 'A', outcome, source: 'local', cases: 10, metrics, _ts: ts, ...o });

test('evalTrends: one row per eval with counts, the latest result and metric change against the run before', () => {
  const [r] = Ledger.evalTrends([ev('pass', 30, { m: 0.9 }), ev('fail', 10, { m: 0.7 }), ev('pass', 20, { m: 0.8, n: 1 })]);
  assert.equal(r.runs, 3); assert.equal(r.passed, 2); assert.equal(r.failed, 1);
  assert.deepEqual(r.metrics.m.values, [0.7, 0.8, 0.9], 'oldest first');
  assert.equal(r.metrics.m.latest, 0.9);
  assert.ok(Math.abs(r.metrics.m.change - 0.1) < 1e-9);
  assert.equal(r.metrics.n.change, null, 'a single value has no change');
  assert.equal(r.latest.outcome, 'pass'); assert.equal(r.latest.ts, 30);
});

test('evalTrends: separates evals, skips samples and other kinds', () => {
  const rows = Ledger.evalTrends([ev('pass', 1, {}), ev('pass', 2, {}, { eval: 'EV-2', agent: 'B' }), ev('pass', 3, {}, { sample: true }), { kind: 'check', _ts: 4 }]);
  assert.deepEqual(rows.map(r => r.eval), ['EV-1', 'EV-2']);
  assert.deepEqual(Ledger.evalTrends([]), []);
});
