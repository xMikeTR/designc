// Failure modes: escapes in the design registries, classified by a person against factory/taxonomy.yaml.
// `failure_mode_classified` is written to the factory's own ledger; the latest per escape wins; an id the taxonomy
// does not list is a warning, never a block.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../renderer/ledger.js');

let t = 0;
const at = e => ({ ...e, by: 'mike', event_id: `e${++t}`, _ts: ++t });
const fm = (registry, escape, failure_mode) => at({ kind: 'failure_mode_classified', registry, escape, failure_mode });
const TAX = { modes: [
  { id: 'FM-01', name: 'Test gaming', triage: 'grader' },
  { id: 'FM-02', name: 'Spec gap', triage: 'spec', description: 'The handover did not say' },
  { id: 'FM-03', name: 'Retry storm' },
] };
const ESC = [{ registry: 'design', id: 'E-1' }, { registry: 'design', id: 'E-2' }, { registry: 'design', id: 'E-3' }, { registry: 'shop', id: 'E-1' }];

test('failure_mode_classified validates, goes to factory.jsonl, and allows null to clear', () => {
  assert.equal(Ledger.KINDS.failure_mode_classified.stream, 'factory.jsonl');
  const ok = { schema_version: 1, event_id: 'x', ts: 1, by: 'mike', kind: 'failure_mode_classified', registry: 'design', escape: 'E-1', failure_mode: 'FM-01' };
  assert.deepEqual(Ledger.validate(ok), []);
  assert.deepEqual(Ledger.validate({ ...ok, failure_mode: null }), []);
  assert.ok(Ledger.validate({ ...ok, failure_mode: undefined }).length, 'failure_mode is required (null means not classified)');
  assert.ok(Ledger.validate({ ...ok, failure_mode: 3 }).length);
  assert.ok(Ledger.validate({ ...ok, registry: undefined }).length);
});

test('counts escapes per mode, latest classification per registry and escape wins', () => {
  const r = Ledger.failureModes([fm('design', 'E-1', 'FM-02'), fm('design', 'E-1', 'FM-01'), fm('design', 'E-2', 'FM-01'), fm('shop', 'E-1', 'FM-02')], { taxonomy: TAX, escapes: ESC });
  assert.deepEqual(r.modes.map(m => [m.id, m.count]), [['FM-01', 2], ['FM-02', 1], ['FM-03', 0]]);
  assert.deepEqual(r.modes[0].escapes, [{ registry: 'design', escape: 'E-1' }, { registry: 'design', escape: 'E-2' }]);
  assert.equal(r.modes[2].triage, null, 'not triaged yet');
  assert.equal(r.modes[1].description, 'The handover did not say');
  assert.equal(r.byEscape.get('design/E-1'), 'FM-01');
  assert.equal(r.byEscape.get('shop/E-1'), 'FM-02', 'the same escape id in another registry is another escape');
  assert.deepEqual(r.unclassified, [{ registry: 'design', escape: 'E-3' }]);
  assert.deepEqual(r.unknown, []);
});

test('null clears a classification', () => {
  const r = Ledger.failureModes([fm('design', 'E-1', 'FM-01'), fm('design', 'E-1', null)], { taxonomy: TAX, escapes: ESC });
  assert.equal(r.modes[0].count, 0);
  assert.equal(r.byEscape.has('design/E-1'), false);
  assert.ok(r.unclassified.some(u => u.escape === 'E-1' && u.registry === 'design'));
});

test('an id the taxonomy does not list is a warning that names the escape, and is not counted', () => {
  const r = Ledger.failureModes([fm('design', 'E-1', 'FM-99'), fm('design', 'E-2', 'FM-01')], { taxonomy: TAX, escapes: ESC });
  assert.deepEqual(r.unknown, [{ registry: 'design', escape: 'E-1', failure_mode: 'FM-99' }]);
  assert.equal(r.modes.reduce((n, m) => n + m.count, 0), 1);
  assert.equal(r.byEscape.get('design/E-1'), 'FM-99', 'still shown as classified so the person can fix it');
  const none = Ledger.failureModes([fm('design', 'E-1', 'FM-01')], { taxonomy: null, escapes: ESC });
  assert.deepEqual(none.modes, []);
  assert.equal(none.unknown.length, 1, 'with no taxonomy every id is unknown');
});

test('taxonomy problems are reported, not thrown: missing id or name, repeated id, bad triage, not a list', () => {
  const r = Ledger.failureModes([], { taxonomy: { modes: [{ id: 'FM-01', name: 'A' }, { id: 'FM-01', name: 'B' }, { name: 'C' }, { id: 'FM-04' }, { id: 'FM-05', name: 'E', triage: 'later' }] }, escapes: [] });
  assert.deepEqual(r.problems, [
    'FM-01 is listed more than once',
    'mode 3 needs an id',
    'FM-04 needs a name',
    'FM-05: triage must be spec, fix or grader',
  ]);
  assert.deepEqual(r.modes.map(m => m.id), ['FM-01', 'FM-04', 'FM-05'], 'the first of a repeated id counts; a mode with no id is left out');
  assert.deepEqual(Ledger.failureModes([], { taxonomy: { modes: 'x' }, escapes: [] }).problems, ['modes must be a list']);
  assert.deepEqual(Ledger.failureModes([], { taxonomy: [], escapes: [] }).problems, ['factory/taxonomy.yaml must be a mapping with a modes list']);
});

test('classifications of escapes not in the list still count (the registry may be unreachable)', () => {
  const r = Ledger.failureModes([fm('gone', 'E-7', 'FM-01')], { taxonomy: TAX, escapes: [] });
  assert.equal(r.modes[0].count, 1);
  assert.deepEqual(r.unclassified, []);
});
