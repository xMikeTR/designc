const { test } = require('node:test');
const assert = require('node:assert/strict');
const Look = require('../renderer/look.js');

const DAY = 86400000;
const now = 100 * DAY;
const diag = (code, label, o = {}) => ({ code, sev: 'warning', loc: { label }, ...o });
const snap = (o = {}) => Look.snapshot({
  gate: { ready: false, clauses: [{ text: 'D-1 is not bound' }] },
  diags: [diag('DC002', 'Quotes DB'), diag('DC005', 'Cat Model', { suppressed: true })],
  decisions: [{ id: 'D-1', status: 'checked' }],
  drift: { undeclared: [1, 2], unrealised: [] },
  ledger: [{ kind: 'extraction', _ts: now - DAY }, { kind: 'extraction', _ts: now - 3 * DAY }],
  ...o,
});

test('a snapshot keeps what the gate, findings, decisions, drift and extraction say', () => {
  assert.deepEqual(snap(), {
    ready: false, clauses: ['D-1 is not bound'], findings: ['DC002 on Quotes DB'],
    decisions: { 'D-1': 'checked' }, drift: { undeclared: 2, unrealised: 0 }, extractedAt: now - DAY,
  });
});

test('no previous look is a first look with nothing changed', () => {
  const d = Look.diff(null, snap(), { now });
  assert.equal(d.first, true);
  assert.equal(d.count, 0);
});

test('the same design twice has no changes', () => {
  assert.equal(Look.diff(snap(), snap(), { now }).count, 0);
});

test('the gate flipping, clauses and findings coming and going are changes', () => {
  const cur = snap({ gate: { ready: true, clauses: [] }, diags: [diag('DC004', 'Pricing API')] });
  const d = Look.diff(snap(), cur, { now });
  assert.deepEqual(d.gate, { from: false, to: true });
  assert.deepEqual(d.clauses, { added: [], removed: ['D-1 is not bound'] });
  assert.deepEqual(d.findings, { added: ['DC004 on Pricing API'], removed: ['DC002 on Quotes DB'] });
  assert.equal(d.count, 4);
});

test('a decision changing status, appearing or going is a change', () => {
  const cur = snap({ decisions: [{ id: 'D-1', status: 'bound' }, { id: 'D-2', status: 'minted' }] });
  assert.deepEqual(Look.diff(snap(), cur, { now }).decisions,
    [{ id: 'D-1', from: 'checked', to: 'bound' }, { id: 'D-2', from: null, to: 'minted' }]);
  assert.deepEqual(Look.diff(snap(), snap({ decisions: [] }), { now }).decisions, [{ id: 'D-1', from: 'checked', to: null }]);
});

test('drift counts changing is a change; drift appearing from nothing is too', () => {
  const d = Look.diff(snap(), snap({ drift: { undeclared: [1], unrealised: [1] } }), { now });
  assert.deepEqual(d.drift, { undeclared: { from: 2, to: 1 }, unrealised: { from: 0, to: 1 } });
  assert.deepEqual(Look.diff(snap({ drift: null }), snap(), { now }).drift, { undeclared: { from: 0, to: 2 }, unrealised: { from: 0, to: 0 } });
});

test('extraction age is reported, stale after a week, and is not counted as a change', () => {
  const fresh = Look.diff(snap(), snap(), { now });
  assert.deepEqual(fresh.extraction, { at: now - DAY, days: 1, stale: false });
  const old = Look.diff(snap(), snap({ ledger: [{ kind: 'extraction', _ts: now - 9 * DAY }] }), { now });
  assert.deepEqual(old.extraction, { at: now - 9 * DAY, days: 9, stale: true });
  assert.equal(old.count, 0);
  assert.equal(Look.diff(snap(), snap({ ledger: [] }), { now }).extraction, null);
});

test('a malformed stored snapshot reads as a first look', () => {
  assert.equal(Look.diff({ nonsense: 1 }, snap(), { now }).first, true);
});
