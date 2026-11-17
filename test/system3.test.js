const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Ledger = require('../renderer/ledger.js');

// D7 part 2, slice 4: Ledger.system3 over fixtures/system3-registry (the Factory's projected rows from F8, plus
// hand-written escapes and a classification). One test per formula in docs/ui-contract.md "Feeding System 3".
const REG = path.join(__dirname, '../fixtures/system3-registry');
const load = () => {
  const events = [];
  for (const f of fs.readdirSync(path.join(REG, 'ledger')).filter(n => n.endsWith('.jsonl'))) {
    events.push(...Ledger.parse(fs.readFileSync(path.join(REG, 'ledger', f), 'utf8'), `ledger/${f}`).events);
  }
  return Ledger.order(events);
};
const SPECS = [{ screen: 'bordereaux', component: 'Portal' }, { screen: 'summary', component: 'Summary' }];
const SCENARIOS = [{ id: 'bordereaux-list', screen: 'bordereaux' }, { id: 'bordereaux-apply', screen: 'bordereaux' }];
const run = (opts = { specs: SPECS, scenarios: SCENARIOS }, events = load()) => Ledger.system3(events, opts);
const stage = (r, s) => r.stages.find(x => x.stage === s);

test('the fixture rows all validate', () => {
  for (const e of load()) assert.deepEqual(Ledger.validate(Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('_')))), [], e.kind);
});

test('time to signal: first verdict per (run, task, stage) with a change_ts; median and n per stage', () => {
  const r = run();
  assert.deepEqual(stage(r, 'ui-code').signal, { median: 7000, n: 1 });
  assert.deepEqual(stage(r, 'ui-visual').signal, { median: 8500, n: 2 });
  assert.deepEqual(stage(r, 'acceptance').signal, { median: 79000, n: 1 });
  assert.deepEqual(stage(r, 'holdout').signal, { median: 63500, n: 2 });
  assert.deepEqual(stage(r, 'review').signal, { median: 43000, n: 2 }, 'round 2 of T-A is not the first verdict');
  assert.deepEqual(stage(r, 'qa').signal, { median: 60000, n: 1 });
  for (const s of ['ui-spec', 'ui-preview', 'parity']) assert.deepEqual(stage(r, s).signal, { median: null, n: 0 }, s);
});

test('time to signal skips a null change_ts, and takes the first verdict by ts', () => {
  const v = (o) => ({ kind: 'stage_verdict', run: 'r', outcome: 'pass', event_id: Math.random() + '', ...o });
  const ev = [
    v({ stage: 'ui-code', change_ts: null, ts: 5, _ts: 5 }),
    v({ stage: 'ui-visual', task: 't', change_ts: 100, ts: 400, _ts: 400 }),
    v({ stage: 'ui-visual', task: 't', change_ts: 100, ts: 200, _ts: 200 }),
  ];
  const r = Ledger.system3(ev, {});
  assert.deepEqual(stage(r, 'ui-code').signal, { median: null, n: 0 });
  assert.deepEqual(stage(r, 'ui-visual').signal, { median: 100, n: 1 });
});

test('escape rate: escaped / (caught + escaped), classification applied, ui-spec and ui-preview show escapes only', () => {
  const r = run();
  assert.deepEqual(stage(r, 'ui-visual').rate, { caught: 1, escaped: 2, rate: 2 / 3 }, 'E-s3000002 is classified later');
  assert.deepEqual(stage(r, 'holdout').rate, { caught: 1, escaped: 1, rate: 0.5 });
  assert.deepEqual(stage(r, 'parity').rate, { caught: 1, escaped: 1, rate: 0.5 }, 'parity counts parity_result fails');
  assert.deepEqual(stage(r, 'acceptance').rate, { caught: 1, escaped: 0, rate: 0 });
  assert.deepEqual(stage(r, 'review').rate, { caught: 1, escaped: 0, rate: 0 }, 'two review verdicts of one task are one catch');
  assert.deepEqual(stage(r, 'ui-code').rate, { caught: 0, escaped: 0, rate: null });
  assert.deepEqual(stage(r, 'ui-spec').rate, { caught: null, escaped: 0, rate: null });
  assert.deepEqual(stage(r, 'ui-preview').rate, { caught: null, escaped: 0, rate: null });
});

test('the overall rate counts unclassified escapes on both sides', () => {
  const r = run();
  assert.deepEqual(r.overall, { caught: 6, escaped: 5, unclassified: 1, rate: 5 / 11 });
});

test('could_not_run is in no numerator and no denominator', () => {
  const ev = load().map(e => (e.kind === 'stage_verdict' && e.stage === 'review' && e.task === 'T-A' && e.round === 1 ? { ...e, outcome: 'could_not_run' } : e))
    .map(e => (e.kind === 'stage_verdict' && e.stage === 'qa' ? { ...e, outcome: 'could_not_run' } : e));
  const r = run(undefined, ev);
  assert.deepEqual(stage(r, 'review').rate, { caught: 0, escaped: 0, rate: null });
  assert.deepEqual(r.review, { n: 2, vetoed: 0, veto: 0, recovered: 0, recovery: null });
  assert.deepEqual(r.qa, { n: 0, vetoed: 0, veto: null, recovered: 0, recovery: null });
  assert.equal(stage(r, 'qa').rate.caught, 0);
});

test('review veto and recovery', () => {
  const r = run();
  assert.deepEqual(r.review, { n: 2, vetoed: 1, veto: 0.5, recovered: 1, recovery: 1 });
  const ev = load().map(e => (e.kind === 'task' && e.task === 'T-A' ? { ...e, status: 'failed' } : e));
  assert.deepEqual(run(undefined, ev).review, { n: 2, vetoed: 1, veto: 0.5, recovered: 0, recovery: 0 }, 'the latest task row decides');
});

test('QA veto and recovery: a later run of the same item that passes qa', () => {
  const r = run();
  assert.deepEqual(r.qa, { n: 1, vetoed: 1, veto: 1, recovered: 0, recovery: 0 });
  const later = { kind: 'stage_verdict', run: 'run-s4', stage: 'qa', outcome: 'pass', change_ts: 1, item: 'W-ui', ts: 1794909800000, _ts: 1794909800000, event_id: 'later' };
  assert.deepEqual(run(undefined, [...load(), later]).qa, { n: 2, vetoed: 1, veto: 0.5, recovered: 1, recovery: 1 });
  const earlier = { ...later, ts: 1, _ts: 1, event_id: 'earlier' };
  assert.equal(run(undefined, [...load(), earlier]).qa.recovered, 0, 'a pass before the veto is not a recovery');
  const otherItem = { ...later, item: 'W-other', event_id: 'other' };
  assert.equal(run(undefined, [...load(), otherItem]).qa.recovered, 0);
});

test('QA recovery falls back to the handover when a run has no item', () => {
  const v = (o) => ({ kind: 'stage_verdict', stage: 'qa', change_ts: 1, event_id: Math.random() + '', ...o });
  const ev = [
    { kind: 'run_started', run: 'a', handover: 'H1', ts: 1, _ts: 1, event_id: 'ra' },
    { kind: 'run_started', run: 'b', handover: 'H1', ts: 5, _ts: 5, event_id: 'rb' },
    v({ run: 'a', outcome: 'fail', ts: 2, _ts: 2 }),
    v({ run: 'b', outcome: 'pass', ts: 6, _ts: 6 }),
  ];
  assert.deepEqual(Ledger.system3(ev, {}).qa, { n: 2, vetoed: 1, veto: 0.5, recovered: 1, recovery: 1 });
});

test('caught but reached QA: escapes with bucket caught', () => {
  const r = run();
  assert.equal(r.caughtReachedQa, 1);
  assert.equal(r.screens.bordereaux.caughtReachedQa, 1);
  assert.equal(r.screens.summary.caughtReachedQa, 0);
});

test('screen join: the row screen, else the task element matched to a spec component, else "no screen"', () => {
  const r = run();
  assert.deepEqual(Object.keys(r.screens).sort(), ['bordereaux', 'no screen', 'summary']);
  // bordereaux: the T-A review rows carry only an element (App/Portal)
  assert.deepEqual(r.screens.bordereaux.review, { n: 1, vetoed: 1, veto: 1, recovered: 1, recovery: 1 });
  assert.deepEqual(r.screens.bordereaux.stages.find(s => s.stage === 'ui-visual').signal, { median: 10000, n: 1 });
  assert.deepEqual(r.screens.bordereaux.stages.find(s => s.stage === 'ui-visual').rate, { caught: 1, escaped: 2, rate: 2 / 3 });
  assert.deepEqual(r.screens.bordereaux.stages.find(s => s.stage === 'parity').rate, { caught: 1, escaped: 1, rate: 0.5 }, 'scenario -> screen');
  assert.deepEqual(r.screens.summary.review, { n: 1, vetoed: 0, veto: 0, recovered: 0, recovery: null });
  assert.deepEqual(r.screens.summary.stages.find(s => s.stage === 'holdout').rate, { caught: 1, escaped: 1, rate: 0.5 });
  // acceptance rows have an element and no screen: the spec join finds summary
  assert.deepEqual(r.screens.summary.stages.find(s => s.stage === 'acceptance').signal, { median: 79000, n: 1 });
  // the QA verdict names neither, and neither does escape E-s3000004
  assert.deepEqual(r.screens['no screen'].qa, { n: 1, vetoed: 1, veto: 1, recovered: 0, recovery: 0 });
  assert.equal(r.screens['no screen'].stages.find(s => s.stage === 'qa').signal.median, 60000);
  assert.equal(r.screens['no screen'].overall.unclassified, 1);
});

test('with no specs, an acceptance verdict that has only an element falls to "no screen"', () => {
  const r = run({ specs: [], scenarios: [] });
  assert.deepEqual(r.screens['no screen'].stages.find(s => s.stage === 'acceptance').signal, { median: 79000, n: 1 });
  assert.deepEqual(r.screens.summary.stages.find(s => s.stage === 'acceptance').signal, { median: null, n: 0 });
  assert.equal(r.screens.bordereaux.review.n, 0, 'the element does not match any spec');
  assert.equal(r.screens['no screen'].review.n, 2);
});

test('system3 does not mutate its input and ignores non-system3 kinds', () => {
  const ev = load();
  const copy = JSON.stringify(ev);
  run(undefined, ev);
  assert.equal(JSON.stringify(ev), copy);
  assert.equal(Ledger.system3([], {}).overall.rate, null);
});
