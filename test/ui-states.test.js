// D2: state names join up. The spec's states are the spine: acceptance criteria (R1), parity steps (R2), QA bugs (R3, parity-qa.test.js),
// coverage of unrecorded states (R4) and transitions that commit (R5). Opt-in: no matching spec, no change.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ui = require('../renderer/ui.js');
const { load } = require('./helpers/ui.js');

const base = load();
const run = extra => Ui.clauses({ ...base, scenarios: [], ...extra });
const texts = r => r.clauses.map(c => c.text);
const crit = (o = {}) => ({ id: 'AC-1', component: 'BordereauxList', states: ['ready', 'loading', 'empty', 'error'], cases: ['ready', 'loading', 'empty', 'error'].map(state => ({ state })), ...o });
const scen = (o = {}) => ({ id: 'bordereaux-list', screen: 'bordereaux', steps: [{ state: 'loading' }, { state: 'ready' }, { state: 'filtered' }, { state: 'empty' }, { state: 'error' }], ...o });

test('R1: a criterion state the spec does not have is a clause, with the path of the state', () => {
  assert.deepEqual(texts(run({ acceptance: [crit()] })), []);
  const r = run({ acceptance: [crit({ states: ['ready', 'forbidden'], cases: [{ state: 'ready' }, { state: 'forbidden' }] })] });
  assert.equal(r.clauses.length, 2);
  assert.match(r.clauses[0].text, /^acceptance\/AC-1\/states\/1: State 'forbidden' is not in spec bordereaux/);
  assert.match(r.clauses[1].text, /^acceptance\/AC-1\/cases\/1\/state: State 'forbidden' is not in spec bordereaux/);
  assert.ok(r.clauses.every(c => c.kind === 'ui' && c.screen === 'bordereaux'));
});
test('R1: a criterion joins a spec by component name; none matching changes nothing', () => {
  assert.deepEqual(texts(run({ acceptance: [crit({ component: 'Other', states: ['forbidden'], cases: [{ state: 'forbidden' }] })] })), []);
});
test('R1: a state outside the acceptance five is the acceptance clause\'s to say, not repeated here', () => {
  assert.deepEqual(texts(run({ acceptance: [crit({ states: ['filtered'], cases: [{ state: 'filtered' }] })] })), []);
});

test('R2: a parity step state the spec does not have is a clause; a scenario with no screen is skipped', () => {
  assert.deepEqual(texts(run({ scenarios: [scen()] })), []);
  const r = run({ scenarios: [scen({ steps: [{ state: 'loading' }, { state: 'apply-dialog' }, {}] })] });
  assert.equal(r.clauses.length, 1);
  assert.match(r.clauses[0].text, /^parity\/scenarios\/bordereaux-list\/steps\/1\/state: State 'apply-dialog' is not in spec bordereaux/);
  assert.deepEqual(texts(run({ scenarios: [scen({ screen: undefined, steps: [{ state: 'nope' }] })] })), []);
  assert.deepEqual(texts(run({ scenarios: [scen({ screen: 'other', steps: [{ state: 'nope' }] })] })), []);
});

test('R4: a spec state that no parity step records is coverage, not a clause', () => {
  const r = run({ scenarios: [scen({ steps: [{ state: 'loading' }, { state: 'ready' }] })] });
  assert.deepEqual(r.clauses, []);
  assert.deepEqual(r.coverage.filter(c => /recorded by no/.test(c)).map(c => c.match(/State '(\w+)'/)[1]), ['filtered', 'empty', 'error']);
  assert.ok(run({}).coverage.some(c => /State 'ready' is recorded by no parity step/.test(c)));
  assert.deepEqual(run({ scenarios: [scen()] }).coverage, []);
});

const withCommit = (spec, edit) => ({ ...base, specs: base.specs.map(f => { const s = JSON.parse(f.text); edit(s); return { ...f, text: JSON.stringify(s) }; }) });
test('R5: a commits transition is coverage; a state reachable only through one is uncovered', () => {
  const only = withCommit(null, s => { s.transitions.find(t => t.to === 'filtered').commits = true; });
  const r = Ui.clauses({ ...only, scenarios: [scen()] });
  assert.deepEqual(r.clauses, []);
  assert.ok(r.coverage.some(c => /\/transitions\/2: ready → filtered commits, so parity cannot record it read-only/.test(c)));
  assert.ok(r.coverage.some(c => /State 'filtered' is reachable only through transitions that commit/.test(c)));
  assert.ok(r.coverage.some(c => /State 'empty' is reachable only through transitions that commit/.test(c)));
  const other = withCommit(null, s => { s.transitions.find(t => t.to === 'ready' && t.from === 'filtered').commits = true; });
  const o = Ui.clauses({ ...other, scenarios: [scen()] });
  assert.ok(o.coverage.some(c => /\/transitions\/4: filtered → ready commits/.test(c)));
  assert.ok(!o.coverage.some(c => /reachable only through/.test(c)));
});
