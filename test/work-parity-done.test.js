// done_when parity: the agreed rules (docs/parity-contract.md): repo items only, the latest known result per
// scenario at the done commit decides and must pass, `all` with no scenarios is never met, and only results recorded
// before the item was declared done at that commit count.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Work = require('../renderer/work.js');

const C1 = '3f2a9c1d5e7b8a0c4d6e8f0a1b2c3d4e5f6a7b8c';
const C2 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const item = (parity = 'all') => ({ id: 'W-p', requirement: 'HRE-1', elements: ['Pricing API'], done_when: [{ gate: 'npm test' }, { parity }] });
const gate = { kind: 'item_gate', item: 'W-p', gate: 'npm test', outcome: 'pass', commit: C1, dirty: false, _ts: 1 };
const res = (scenario, outcome, o = {}) => ({ kind: 'parity_result', scenario, commit: C1, outcome, failures: outcome === 'fail' ? [{ step: 1, key: 'k', kind: 'text', msg: 'm' }] : [], _ts: 10, ...o });
const done = (it, events, scenarios = ['a', 'b']) => Work.doneProblems(it, { events: [gate, ...events], commit: C1, onMain: true, scenarios });

test('validate: parity only on a repo item, a known scenario when the ids are given, and still a gate', () => {
  const ctx = { requirements: [{ id: 'HRE-1', elements: ['Pricing API'] }], items: [], scenarios: ['a'] };
  assert.deepEqual(Work.validate(item('a'), ctx), []);
  assert.deepEqual(Work.validate(item('all'), ctx), []);
  assert.deepEqual(Work.validate(item('zzz'), ctx), ['W-p: done_when entry 2 names parity scenario zzz, which is not in parity/scenarios/.']);
  assert.deepEqual(Work.validate(item('zzz'), { ...ctx, scenarios: null }), [], 'ids unknown: not judged');
  assert.ok(Work.validate({ ...item(), done_when: [{ parity: 'all' }] }, ctx).some(m => /needs a gate/.test(m)));
  const target = Work.validate({ id: 'W-t', target: { jira: 'X-1' }, done_when: [{ checklist: 'a' }, { parity: 'all' }] }, ctx);
  assert.deepEqual(target, ['W-t: done_when entry 2 (parity) is allowed only on a repo item: parity is judged at the commit that finished it.']);
});

test('every scenario must pass at the done commit; all means every id', () => {
  assert.deepEqual(done(item(), [res('a', 'pass'), res('b', 'pass')]), []);
  const p = done(item(), [res('a', 'pass')]);
  assert.deepEqual(p, [`Parity b has no result at 3f2a9c1. Press Record result for Done in Parity and give it ${C1}.`]);
  assert.deepEqual(done(item('a'), [res('a', 'pass')]), [], 'one id asks for that scenario only');
  assert.match(done(item(), [res('a', 'pass'), res('b', 'pass', { commit: C2 })])[0], /Parity b has no result at 3f2a9c1/, 'another commit does not count');
});

test('the latest result decides; fail and could not run are not met; an unknown outcome is ignored', () => {
  assert.deepEqual(done(item('a'), [res('a', 'fail', { _ts: 5 }), res('a', 'pass', { _ts: 6 })]), []);
  assert.match(done(item('a'), [res('a', 'pass', { _ts: 5 }), res('a', 'fail', { _ts: 6 })])[0], /^Parity a failed at 3f2a9c1 \(1 difference\)/);
  assert.match(done(item('a'), [res('a', 'could_not_run')])[0], /^Parity a could not run/);
  assert.deepEqual(done(item('a'), [res('a', 'pass', { _ts: 5 }), res('a', 'flaky', { _ts: 6 })]), []);
});

test('no scenarios is never met; results after the item was declared done do not count', () => {
  assert.deepEqual(done(item(), [], []), ['Parity: there are no scenarios in parity/scenarios/, so parity cannot pass. Add a scenario or take the entry out.']);
  const declared = { kind: 'item_done', item: 'W-p', commit: C1, evidence: ['gate:npm test'], _ts: 8 };
  assert.match(done(item('a'), [declared, res('a', 'pass', { _ts: 9 })])[0], /Parity a has no result/);
  assert.deepEqual(done(item('a'), [res('a', 'pass', { _ts: 7 }), declared, res('a', 'fail', { _ts: 9 })]), []);
});

test('digest: an active item whose latest parity result failed is in the failed bucket until a later result', () => {
  const it = item();
  const base = { items: [it], states: { 'W-p': 'active' }, scenarios: ['a'] };
  const d = Work.digest({ ...base, events: [res('a', 'fail', { _ts: 5 })] });
  assert.deepEqual(d.failed.map(f => [f.kind, f.text]), [['parity', 'W-p: parity a failed at 3f2a9c1']]);
  assert.deepEqual(Work.digest({ ...base, events: [res('a', 'fail', { _ts: 5 }), res('a', 'pass', { _ts: 6 })] }).failed, []);
});
