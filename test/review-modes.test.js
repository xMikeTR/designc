// Error analysis, slice 2: failed reviews are grouped into the failure modes of factory/taxonomy.yaml. The latest
// review per observation counts; a pass is never in a mode; a mode the taxonomy does not list is reported, not dropped.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../renderer/ledger.js');

let t = 0;
const review = (observation, verdict, note, failure_mode, extra = {}) => ({ kind: 'trace_review', trace_id: 'tr-' + observation, observation, verdict, note, ...(failure_mode !== undefined ? { failure_mode } : {}), task: 'T-1', by: 'mike', event_id: `e${++t}`, _ts: t, ...extra });
const taxonomy = { modes: [{ id: 'FM-01', name: 'Wrote code before the test', triage: 'spec' }, { id: 'FM-02', name: 'Ignored the failing check' }] };

test('reviewModes: counts failed reviews per mode with examples, newest first; the rest are unassigned or unknown', () => {
  const r = Ledger.reviewModes([
    review('a', 'fail', 'code first', 'FM-01'),
    review('b', 'fail', 'code first again', 'FM-01'),
    review('c', 'fail', 'retried blindly'),
    review('d', 'fail', 'odd', 'FM-99'),
    review('e', 'pass', '', 'FM-02'),
    review('c', 'fail', 'retried blindly, three times', null),
  ], { taxonomy });
  assert.deepEqual(r.modes.map(m => [m.id, m.count]), [['FM-01', 2], ['FM-02', 0]]);
  assert.deepEqual(r.modes[0].examples.map(x => x.observation), ['b', 'a']);
  assert.equal(r.modes[0].examples[0].note, 'code first again');
  assert.equal(r.modes[0].examples[0].trace_id, 'tr-b');
  assert.deepEqual(r.unassigned.map(x => [x.observation, x.note]), [['c', 'retried blindly, three times']]);
  assert.deepEqual(r.unknown.map(x => [x.observation, x.failure_mode]), [['d', 'FM-99']]);
  assert.deepEqual(r.problems, []);
});

test('reviewModes: a later pass takes the attempt out of its mode; no taxonomy means every failure is unassigned or unknown', () => {
  const r = Ledger.reviewModes([review('a', 'fail', 'x', 'FM-01'), review('a', 'pass', '')], { taxonomy });
  assert.equal(r.modes[0].count, 0);
  const n = Ledger.reviewModes([review('a', 'fail', 'x', 'FM-01'), review('b', 'fail', 'y')], { taxonomy: null });
  assert.deepEqual(n.modes, []);
  assert.equal(n.unknown.length, 1);
  assert.equal(n.unassigned.length, 1);
  assert.match(Ledger.reviewModes([], { taxonomy: { modes: 'x' } }).problems.join(), /modes must be a list/);
});

const yaml = require('js-yaml');
const parse = t => yaml.load(t);
const STARTER = '# modes\nmodes:\n  - id: FM-01\n    name: Test gaming\n    triage: grader\n  - id: FM-07\n    name: Spec gap\n';

test('addTaxonomyMode: appends the next FM id at the list\'s indentation, keeping every other line', () => {
  const r = Ledger.addTaxonomyMode(STARTER, { name: 'Retried: the same patch', description: 'Kept "fixing" it' }, parse);
  assert.equal(r.id, 'FM-08');
  assert.ok(r.text.startsWith(STARTER));
  assert.deepEqual(parse(r.text).modes[2], { id: 'FM-08', name: 'Retried: the same patch', description: 'Kept "fixing" it' });
  assert.equal(Ledger.addTaxonomyMode(null, { name: 'First' }, parse).text, 'modes:\n  - id: FM-01\n    name: "First"\n');
  assert.deepEqual(parse(Ledger.addTaxonomyMode('modes:\n- id: FM-01\n  name: A', { name: 'B', triage: 'fix' }, parse).text).modes[1], { id: 'FM-02', name: 'B', triage: 'fix' });
});

test('addTaxonomyMode: refuses a blank name, a bad triage, and a file it cannot append to safely', () => {
  assert.ok(Ledger.addTaxonomyMode(STARTER, { name: ' ' }, parse).error);
  assert.ok(Ledger.addTaxonomyMode(STARTER, { name: 'x', triage: 'later' }, parse).error);
  assert.ok(Ledger.addTaxonomyMode('modes:\n  - id: FM-01\n    name: A\nnotes: after\n', { name: 'B' }, parse).error, 'modes is not the last key');
  assert.ok(Ledger.addTaxonomyMode('modes: [', { name: 'B' }, parse).error, 'does not parse');
});

const evs = [review('a', 'fail', 'code first'), review('b', 'fail', 'skipped the check', 'FM-02'), review('c', 'pass', ''), review('d', 'fail', 'retried')];

test('reviewGrouping: an Analyst grouping of failed reviews into existing or new modes, checked before anyone is asked', () => {
  const r = Ledger.reviewGrouping(evs, taxonomy, [
    { mode: 'FM-01', observations: ['a'], why: 'wrote code first' },
    { new_mode: { name: 'Blind retry', triage: 'fix' }, observations: ['d', 'b'], why: 'same patch again' },
  ]);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.groups.map(g => [g.mode, g.newMode && g.newMode.name, g.reviews.map(x => x.observation)]), [['FM-01', undefined, ['a']], [null, 'Blind retry', ['d', 'b']]]);
  assert.equal(r.changes, 3);
  assert.equal(Ledger.reviewGrouping(evs, taxonomy, [{ mode: 'FM-02', observations: ['b'], why: 'x' }]).changes, 0, 'already in that mode');
});

test('reviewGrouping: refuses what is not a latest failed review, a repeat, an unknown mode, a duplicate new name, a missing why', () => {
  const bad = groups => Ledger.reviewGrouping(evs, taxonomy, groups).error;
  assert.ok(bad([]));
  assert.ok(bad([{ mode: 'FM-01', observations: ['c'], why: 'x' }]), 'a pass');
  assert.ok(bad([{ mode: 'FM-01', observations: ['zz'], why: 'x' }]), 'never reviewed');
  assert.ok(bad([{ mode: 'FM-01', observations: ['a'], why: 'x' }, { mode: 'FM-02', observations: ['a'], why: 'x' }]), 'twice');
  assert.ok(bad([{ mode: 'FM-09', observations: ['a'], why: 'x' }]), 'unknown mode');
  assert.ok(bad([{ mode: 'FM-01', new_mode: { name: 'y' }, observations: ['a'], why: 'x' }]), 'both');
  assert.ok(bad([{ new_mode: { name: 'ignored the failing check' }, observations: ['a'], why: 'x' }]), 'name of an existing mode');
  assert.ok(bad([{ new_mode: { name: 'Z', triage: 'soon' }, observations: ['a'], why: 'x' }]), 'triage');
  assert.ok(bad([{ mode: 'FM-01', observations: ['a'], why: ' ' }]), 'no why');
  assert.ok(bad([{ mode: 'FM-01', observations: [], why: 'x' }]), 'no observations');
});
