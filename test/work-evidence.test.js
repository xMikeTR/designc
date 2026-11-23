// work item `evidence:` (S6): validate sentences. Python says the same words (test/work-parity.test.js fixtures).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Work = require('../renderer/work.js');

const ctx = { requirements: [{ id: 'DEMO-1', elements: ['Fares API'] }], items: [], scenarios: ['tags-list'] };
const repo = (evidence, o = {}) => ({ id: 'W-1', requirement: 'DEMO-1', elements: ['Fares API'], done_when: [{ gate: 'x' }], evidence, ...o });
const probs = (evidence, o, c = ctx) => Work.validate(repo(evidence, o), c);

test('evidence: absent, empty or valid entries of each kind give no problem', () => {
  assert.deepEqual(Work.validate({ ...repo(), evidence: undefined }, ctx), []);
  assert.deepEqual(probs([]), []);
  assert.deepEqual(probs(null), []);
  assert.deepEqual(probs([{ parity: 'tags-list', step: 3 }, { jira: 'RE-1234' }, { escape: 'E-0012' }]), []);
});
test('evidence must be a list', () => {
  assert.deepEqual(probs('RE-1'), ['W-1: evidence must be a list of entries, each { parity, step }, { jira } or { escape }.']);
  assert.deepEqual(probs({ jira: 'RE-1' }), ['W-1: evidence must be a list of entries, each { parity, step }, { jira } or { escape }.']);
});
test('evidence is only for repo items, one sentence for the whole list', () => {
  const t = { requirement: undefined, elements: undefined, target: { jira: 'RE-9' } };
  assert.deepEqual(probs([{ jira: 'RE-1' }, { escape: 'E-1' }], t), ['W-1: evidence is allowed only on a repo item: it travels in the handover. Take it out, or make the item a repo item.']);
  assert.deepEqual(probs([], t), []);
});
test('evidence entries: unknown keys, kind count, empty value', () => {
  assert.deepEqual(probs([{ parity: 'tags-list', step: 1, why: 'x' }]), ['W-1: evidence entry 1 has unknown key why; use parity (with step), jira or escape.']);
  assert.deepEqual(probs([{ jira: 'RE-1', step: 1 }]), ['W-1: evidence entry 1 has unknown key step; use parity (with step), jira or escape.']);
  assert.deepEqual(probs([{ jira: 'RE-1' }, { jira: 'RE-1', escape: 'E-1' }]), ['W-1: evidence entry 2 must have exactly one of parity, jira or escape.']);
  assert.deepEqual(probs(['RE-1']), ['W-1: evidence entry 1 must have exactly one of parity, jira or escape.']);
  assert.deepEqual(probs([{ escape: '' }]), ['W-1: evidence entry 1 (escape) is empty.']);
});
test('evidence parity: step is a whole number from 1; scenario must exist when known; all is refused', () => {
  const need = n => `W-1: evidence entry ${n} (parity) needs step, the step number of the failing step (1 or more).`;
  assert.deepEqual(probs([{ parity: 'tags-list' }, { parity: 'tags-list', step: 0 }, { parity: 'tags-list', step: '3' }, { parity: 'tags-list', step: 2.5 }]), [need(1), need(2), need(3), need(4)]);
  assert.deepEqual(probs([{ parity: 'nope', step: 1 }]), ['W-1: evidence entry 1 names parity scenario nope, which is not in parity/scenarios/.']);
  assert.deepEqual(probs([{ parity: 'all', step: 1 }]), ['W-1: evidence entry 1 names parity scenario all, which is not in parity/scenarios/.']);
  assert.deepEqual(probs([{ parity: 'nope', step: 1 }], {}, { ...ctx, scenarios: null }), []);
});
test('evidence jira must be a Jira key', () => {
  assert.deepEqual(probs([{ jira: 'abc' }]), ['W-1: evidence entry 1 (jira) is not a Jira key like ABC-123.']);
});
