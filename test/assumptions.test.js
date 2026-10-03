// Slice 20: a decision's assumptions carry a review date; an overdue or malformed one blocks the gate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');
const Policy = require('../renderer/policy.js');
const jsyaml = require('js-yaml');

const m = Core.parse(`workspace { model { s = softwareSystem "S" { api = container "Api" "" "" } } }`);
const NOW = Date.parse('2026-10-03T10:00:00Z');
const dec = (assumptions, o = {}) => ({ id: 'D-1', status: 'bound', kind: 'business', requirement: 'R-1', evidence: 'https://x', promoted_against: [{ requirement: 'R-1', version: 1 }], ...(assumptions === undefined ? {} : { assumptions }), ...o });
const clauses = (d, now = NOW) => Core.gate({ model: m, diags: [], decisions: [d], requirements: [{ id: 'R-1', version: 1, elements: ['Api'] }], ledger: [], evidenceHosts: ['x'], now })
  .clauses.map(c => c.text).filter(t => /assumption/.test(t));

test('a decision with no assumptions, or with future review dates, is unaffected', () => {
  assert.deepEqual(clauses(dec()), []);
  assert.deepEqual(clauses(dec([{ text: 'Volume stays under 1k/day', review_by: '2027-01-01' }])), []);
});

test('an assumption is due after its review date, not on it', () => {
  assert.deepEqual(clauses(dec([{ text: 'Volume stays low', review_by: '2026-10-03' }])), []);
  assert.deepEqual(clauses(dec([{ text: 'Volume stays low', review_by: '2026-10-02' }])), ['D-1: assumption "Volume stays low" was due for review on 2026-10-02']);
});

test('a YAML date is read the same as the string', () => {
  const d = jsyaml.load('id: D-1\nassumptions:\n  - text: Volume stays low\n    review_by: 2026-01-05\n');
  assert.deepEqual(clauses(dec(d.assumptions)), ['D-1: assumption "Volume stays low" was due for review on 2026-01-05']);
});

test('a malformed assumption blocks', () => {
  const bad = 'D-1: each assumption needs text and a review_by date (YYYY-MM-DD)';
  assert.deepEqual(clauses(dec([{ text: 'No date' }])), [bad]);
  assert.deepEqual(clauses(dec([{ review_by: '2027-01-01' }])), [bad]);
  assert.deepEqual(clauses(dec([{ text: 'x', review_by: '2027-13-40' }])), [bad]);
  assert.deepEqual(clauses(dec('soon')), [bad]);
});

test('a decision that is not bound is not judged for assumptions', () => {
  assert.deepEqual(clauses(dec([{ text: 'old', review_by: '2020-01-01' }], { status: 'minted' })), []);
});

test('agents cannot write review records on an assumption', () => {
  const yaml = a => `id: D-9\nstatus: minted\nassumptions: ${JSON.stringify(a)}\n`;
  const w = a => Policy.writeVerdict('grill', 'decisions/D-9.yaml', yaml(a), jsyaml.load);
  assert.equal(w([{ text: 'x', review_by: '2027-01-01' }]).ok, true);
  assert.equal(w([{ text: 'x', review_by: '2027-01-01', reviewed_by: 'me' }]).ok, false);
  assert.equal(w([{ text: 'x', review_by: '2027-01-01', reviewed_at: '2026-10-03' }]).ok, false);
});
