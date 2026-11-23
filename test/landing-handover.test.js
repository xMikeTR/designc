// S5 F: Landing.forHandover picks the approved, unchanged landings of the requirements a handover carries. Pure.
const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const Landing = require('../renderer/landing.js');

const BASE = (req, what = 'filter') => ({ requirement: req, author: 'human', status: 'proposed', entry: { kind: 'action', node: 'Api' }, path: [{ stage: 'api', node: 'Api' }], changes: [{ node: 'Api/Orders', what }], principle: { none: 'plumbing' }, proposed: {}, correction: {}, approved: {} });
function approved(req, over = {}) {
  const rec = BASE(req);
  const text = yaml.dump(rec, { lineWidth: -1, noRefs: true });
  const r = Landing.prepareApprove({ rec, loadedText: text, currentText: text, yaml, file: `landings/${req}.yaml`, by: 'mike', at: '2026-11-23T10:00:00Z', effects: { callers: [1, 2], readers: [1], consumers: [], unknown: [] }, ...over });
  assert.equal(r.ok, true, r.error);
  return { rec: r.record, row: { kind: 'landing_approved', ...r.ledgerRow }, file: { path: `landings/${req}.yaml`, record: r.record, text: r.text } };
}

test('forHandover: an approved note of a listed requirement is an item with the hash, the record and the stored effects', () => {
  const a = approved('RE-1');
  const r = Landing.forHandover([a.file], ['RE-1'], [a.row]);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].requirement, 'RE-1');
  assert.equal(r.items[0].hash, Landing.contentHash(a.rec));
  assert.equal(r.items[0].record, a.rec);
  assert.equal(r.items[0].corrected, false);
  assert.deepEqual(r.items[0].effects, { callers: 2, readers: 1, consumers: 0, unknown: 0 });
});

test('forHandover: edited after approval is skipped with that reason', () => {
  const a = approved('RE-1');
  const edited = { ...a.rec, changes: [{ node: 'Api/Orders', what: 'something else' }] };
  const r = Landing.forHandover([{ path: a.file.path, record: edited, text: '' }], ['RE-1'], [a.row]);
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.skipped, [{ requirement: 'RE-1', reason: 'edited after approval' }]);
});

test('forHandover: status approved written by hand, no ledger row, is skipped: no approval recorded', () => {
  const a = approved('RE-1');
  const r = Landing.forHandover([a.file], ['RE-1'], []);
  assert.deepEqual(r.skipped, [{ requirement: 'RE-1', reason: 'no approval recorded' }]);
  const hand = { ...BASE('RE-2'), status: 'approved' };
  assert.deepEqual(Landing.forHandover([{ path: 'landings/RE-2.yaml', record: hand, text: '' }], ['RE-2'], []).skipped, [{ requirement: 'RE-2', reason: 'no approval recorded' }]);
});

test('forHandover: a proposed note is skipped as not approved', () => {
  const r = Landing.forHandover([{ path: 'landings/RE-3.yaml', record: BASE('RE-3'), text: '' }], ['RE-3'], []);
  assert.deepEqual(r.skipped, [{ requirement: 'RE-3', reason: 'not approved' }]);
});

test('forHandover: a note for a requirement not in the list is neither; a requirement with no note is neither', () => {
  const a = approved('RE-1');
  const r = Landing.forHandover([a.file], ['RE-9'], [a.row]);
  assert.deepEqual(r, { items: [], skipped: [] });
  assert.deepEqual(Landing.forHandover([], ['RE-1'], []), { items: [], skipped: [] });
  assert.deepEqual(Landing.forHandover(undefined, ['RE-1'], undefined), { items: [], skipped: [] });
});

test('forHandover: a file that did not parse (no record) is ignored', () => {
  assert.deepEqual(Landing.forHandover([{ path: 'landings/RE-1.yaml', record: null, errors: ['x'], text: '' }], ['RE-1'], []), { items: [], skipped: [] });
});
