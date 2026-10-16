const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../renderer/ledger.js');

// Whether a parked pipeline run can be resumed: what it waited on has been answered in a form the pipeline accepts.
const H = '20261016-aaaaaaaa';
const opts = { options: [{ id: 'A', summary: 'a' }, { id: 'B', summary: 'b' }], recommended: 'B' };
const nd = (id, o = {}) => ({ kind: 'needs_decision', id, question: 'q', status: 'open', _ts: 1, ...o });
const res = (id, o = {}) => ({ kind: 'needs_decision_resolved', id, by: 'mike', _ts: 3, ...o });
const parked = (o = {}) => [{ kind: 'run_started', run: 'r1', handover: H, _ts: 0 }, { kind: 'run_ended', run: 'r1', handover: H, status: 'parked', reason: 'ND-0002', _ts: 2, ...o }];
const check = ev => Ledger.resumeCheck(Ledger.derive(ev), 'r1');

test('a run parked on a needs-decision answered with an offered option can resume', () => {
  const r = check([nd('ND-0002', { payload: opts }), ...parked(), res('ND-0002', { payload: { option: 'A', note: 'n' } })]);
  assert.deepEqual(r, { ok: true, run: 'r1', handover: H, blockers: [], confirm: [], answered: ['ND-0002'], decisions: [] });
});

test('an open needs-decision blocks, named in the reason or tied to the run', () => {
  const r = check([nd('ND-0002'), nd('ND-0003', { payload: { run_id: 'r1' } }), nd('ND-0004', { payload: { run_id: 'other' } }), ...parked()]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.blockers, [
    'ND-0002 is not answered yet: choose an option, answer it with a decision or mark it resolved, then resume.',
    'ND-0003 is not answered yet: choose an option, answer it with a decision or mark it resolved, then resume.',
  ]);
});

test('an option the pipeline did not offer blocks: it would refuse it and park again', () => {
  const r = check([nd('ND-0002', { payload: opts }), ...parked(), res('ND-0002', { payload: { option: 'D' } })]);
  assert.deepEqual(r.blockers, ['ND-0002 was answered with option D, which is not one it offered (A, B). The run would refuse it and park again: answer it again.']);
});

test('options offered but closed without an option, note or decision asks first', () => {
  const r = check([nd('ND-0002', { payload: opts }), ...parked(), res('ND-0002')]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.confirm, ['ND-0002 was closed without choosing an option, a note or a decision, so the agent is only told to re-read the handover and decisions.']);
  assert.deepEqual(check([nd('ND-0002', { payload: opts }), ...parked(), res('ND-0002', { decision: 'use-redis' })]).decisions, ['use-redis']);
  assert.deepEqual(check([nd('ND-0002'), ...parked(), res('ND-0002')]).confirm, []);
});

test('only a parked run of an open handover can resume', () => {
  assert.deepEqual(Ledger.resumeCheck([], 'r1').blockers, ['There is no run r1 in the ledger.']);
  assert.deepEqual(check([...parked({ status: 'failed' })]).blockers, ['Run r1 is not parked: it failed.']);
  assert.deepEqual(check([...parked(), { kind: 'run_started', run: 'r1', handover: H, _ts: 5 }]).blockers, ['Run r1 is running again.']);
  assert.deepEqual(check([...parked(), { kind: 'handover_closed', handover: H, outcome: 'abandoned', _ts: 5 }]).blockers, [`Handover ${H} was closed (abandoned), so its runs are final.`]);
});

test('parkedOn: the needs-decisions a reason names, as whole words', () => {
  const ev = [nd('ND-1'), nd('ND-12'), nd('X.1')];
  assert.deepEqual(Ledger.parkedOn(ev, 'waiting on ND-12 and X.1').map(e => e.id), ['ND-12', 'X.1']);
  assert.deepEqual(Ledger.parkedOn(ev, ''), []);
});
