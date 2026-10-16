// Error analysis (Improve, Review): a person reads one task attempt of a pipeline run, step by step, and records a
// verdict and a note. `trace_review` is a person's judgement in designc.jsonl; the latest per observation wins.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../renderer/ledger.js');

let t = 0;
const at = e => ({ ...e, by: 'mike', event_id: `e${++t}`, _ts: ++t });
const review = (observation, verdict, note = '', extra = {}) => at({ kind: 'trace_review', trace_id: 'tr1', observation, verdict, note, ...extra });
const ok = { schema_version: 1, event_id: 'x', ts: 1, by: 'mike', kind: 'trace_review', trace_id: 'tr1', observation: 'o1', verdict: 'fail', note: 'wrote the test after the code' };

test('trace_review validates, goes to designc.jsonl, and is not a kind a pipeline writes', () => {
  assert.equal(Ledger.KINDS.trace_review.stream, 'designc.jsonl');
  assert.ok(!Ledger.PIPELINE_KINDS.includes('trace_review'));
  assert.deepEqual(Ledger.validate(ok), []);
  assert.deepEqual(Ledger.validate({ ...ok, verdict: 'pass', note: '' }), [], 'a pass may have no note');
  assert.deepEqual(Ledger.validate({ ...ok, task: 'T-001', run_id: 'r1', attempt: 2, failure_mode: 'FM-01' }), []);
  assert.deepEqual(Ledger.validate({ ...ok, failure_mode: null }), []);
  assert.ok(Ledger.validate({ ...ok, verdict: 'maybe' }).length);
  assert.ok(Ledger.validate({ ...ok, observation: undefined }).length);
  assert.ok(Ledger.validate({ ...ok, trace_id: undefined }).length);
  assert.ok(Ledger.validate({ ...ok, note: undefined }).length);
  assert.ok(Ledger.validate({ ...ok, attempt: '2' }).length);
  assert.match(Ledger.validate({ ...ok, note: '  ' }).join(), /note/, 'a fail says what went wrong');
});

test('traceReviews: the latest per observation wins', () => {
  const m = Ledger.traceReviews([review('o1', 'pass'), review('o2', 'fail', 'x'), review('o1', 'fail', 'second look')]);
  assert.equal(m.size, 2);
  assert.equal(m.get('o1').verdict, 'fail');
  assert.equal(m.get('o1').note, 'second look');
});

const span = (id, outcome, start) => ({ id, traceId: 'tr1', task: 'T-' + id, outcome, start, steps: 3 });

test('reviewQueue: failed attempts first, then the rest unreviewed, then reviewed; newest first in each', () => {
  const spans = [span('a', 'passed', 1), span('b', 'failed', 2), span('c', 'unknown', 3), span('d', 'failed', 4), span('e', 'passed', 5)];
  const q = Ledger.reviewQueue(spans, [review('d', 'fail', 'x'), review('e', 'pass')]);
  assert.deepEqual(q.rows.map(r => r.id), ['b', 'c', 'a', 'e', 'd']);
  assert.equal(q.rows.find(r => r.id === 'd').review.verdict, 'fail');
  assert.equal(q.rows.find(r => r.id === 'a').review, null);
  assert.deepEqual(q.counts, { total: 5, failed: 2, reviewed: 2, pass: 1, fail: 1, toReview: 3 });
});

test('reviewQueue: a review of an attempt no longer in the window is kept out of the counts', () => {
  const q = Ledger.reviewQueue([span('a', 'failed', 1)], [review('gone', 'fail', 'x')]);
  assert.deepEqual(q.counts, { total: 1, failed: 1, reviewed: 0, pass: 0, fail: 0, toReview: 1 });
});
