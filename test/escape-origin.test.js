const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../renderer/ledger.js');

const env = (o) => ({ schema_version: 1, event_id: 'e' + Math.random(), ts: 1, by: 'x', ...o });

test('origin is a closed list on escape and escape_classified', () => {
  assert.deepEqual(Ledger.ORIGINS, ['spec_gap', 'design_error', 'translation_error', 'gate_gap']);
  assert.deepEqual(Ledger.validate(env({ kind: 'escape', id: 'E-1', description: 'd', origin: 'spec_gap' })), []);
  const bad = Ledger.validate(env({ kind: 'escape', id: 'E-1', description: 'd', origin: 'defect' }));
  assert.ok(bad.some(m => /origin/.test(m)), bad.join('; '));
  assert.deepEqual(Ledger.validate(env({ kind: 'escape_classified', escape: 'E-1', caught_by: null, origin: null })), []);
});

test('derive folds the latest origin into the escape and keeps caught_by', () => {
  const ev = [
    { kind: 'escape', id: 'E-1', description: 'd', caught_by: 'S1-lint', event_id: 'a', _ts: 1 },
    { kind: 'escape_classified', escape: 'E-1', caught_by: 'S1-lint', origin: 'design_error', event_id: 'b', _ts: 2 },
    { kind: 'escape_classified', escape: 'E-1', caught_by: 'S1-lint', origin: 'gate_gap', event_id: 'c', _ts: 3 },
  ];
  const [e] = Ledger.derive(ev);
  assert.equal(e.origin, 'gate_gap');
  assert.equal(e.caught_by, 'S1-lint');
});

test('escapeMetrics: by origin, UI share, acceptance first pass, tamper attempts', () => {
  const ev = [
    { kind: 'escape', id: 'E-1', element: 'Portal', origin: 'spec_gap' },
    { kind: 'escape', id: 'E-2', element: 'Pricing API' },
    { kind: 'item_done', item: 'W-a' }, { kind: 'item_done', item: 'W-b' },
    { kind: 'ui_acceptance_failed', task: 'W-b', ac: 'AC-1' },
    { kind: 'unapproved_change', path: 'tests/acceptance/portal/AC-1.spec.ts' },
    { kind: 'unapproved_change', path: 'model/workspace.dsl' },
  ];
  const m = Ledger.escapeMetrics(ev, { uiElements: ['Portal'] });
  assert.equal(m.escapes, 2);
  assert.equal(m.uiEscapes, 1);
  assert.equal(m.byOrigin.spec_gap, 1);
  assert.equal(m.unclassified, 1);
  assert.deepEqual(m.acceptance, { done: 2, firstPass: 1 });
  assert.equal(m.tamper, 1);
  assert.equal(m.uiEscapeRate, 0.5, 'UI escapes per done item');
  assert.equal(Ledger.escapeMetrics([{ kind: 'escape', element: 'Portal' }], { uiElements: ['Portal'] }).uiEscapeRate, null);
  assert.deepEqual(Ledger.escapeMetrics(ev, { items: ['W-a'] }).acceptance, { done: 1, firstPass: 1 });
});
