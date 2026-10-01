const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Ledger = require('../renderer/ledger.js');
const Core = require('../renderer/core.js');

test('legacy pipeline events keep their fields', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'sample-registry', 'ledger', 'pipeline.jsonl'), 'utf8');
  const { events, errors } = Ledger.parse(text, 'pipeline.jsonl');
  assert.deepEqual(errors, []);
  const task = events.find(e => e.kind === 'task' && e.task === 'T-01');
  assert.equal(task.tier, 'executor');
  assert.equal(task.reruns, 0);
  assert.equal(task.turns, 9);
  assert.equal(task.tokens, 61000);
  assert.equal(task.model, 'sonnet');
  assert.equal(task.payload, undefined);
  const nd = events.find(e => e.kind === 'needs_decision');
  assert.equal(nd.id, 'ND-0003');
  assert.equal(nd.question.startsWith('The design says'), true);
  assert.equal(nd.status, 'open');
  assert.equal(nd.payload, undefined);
  const edge = events.find(e => e.kind === 'asbuilt_edge');
  assert.equal(edge.from, 'PricingPortal');
  assert.equal(edge.to, 'PricingApi');
  assert.equal(edge.payload, undefined);
});

test('task tokens split and total', () => {
  const ok = { schema_version: 1, by: 'pipeline', kind: 'task', task: 'T-1', status: 'passed', tokens_in: 100, tokens_out: 50, cost: 0.01 };
  assert.deepEqual(Ledger.validate(ok), []);
  assert.equal(Ledger.totalTokens(ok), 150);
  assert.equal(Ledger.totalTokens({ ...ok, tokens: 400 }), 400);
  assert.ok(Ledger.validate({ ...ok, status: 'done' }).some(e => /status: must be one of/.test(e)));
  assert.equal(Ledger.totalTokens({ task: 'T-1' }), 0);
});

test('gate and drift read derived pipeline events', () => {
  const nd = { kind: 'needs_decision', by: 'pipeline', id: 'ND-0001', task: 'T-06', element: 'Referral Worker', question: 'q?', status: 'open', schema_version: 1, event_id: 'nd1', ts: 1 };
  const gate1 = Core.gate({ model: { errors: [] }, diags: [], decisions: [], requirements: [], ledger: Ledger.derive([nd]) });
  assert.equal(gate1.clauses.filter(c => c.kind === 'needs').length, 1);

  const resolved = { kind: 'needs_decision_resolved', by: 'u', id: 'ND-0001', schema_version: 1, event_id: 'r1', ts: 2 };
  const gate2 = Core.gate({ model: { errors: [] }, diags: [], decisions: [], requirements: [], ledger: Ledger.derive([nd, resolved]) });
  assert.equal(gate2.clauses.filter(c => c.kind === 'needs').length, 0);

  const edge = { kind: 'asbuilt_edge', by: 'pipeline', from: 'ReferralWorker', to: 'RatingEngine', schema_version: 1, event_id: 'e1', ts: 1 };
  const model = {
    elements: new Map([
      ['rw', { id: 'rw', name: 'ReferralWorker', kind: 'service', props: {} }],
      ['re', { id: 're', name: 'RatingEngine', kind: 'service', props: {} }],
    ]),
    rels: [],
  };
  const dr = Core.drift(model, Ledger.derive([edge]));
  assert.ok(dr);
  assert.deepEqual(dr.unknownEls, []);
  assert.deepEqual(dr.undeclared, [{ from: 'ReferralWorker', to: 'RatingEngine' }]);
});
