const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const ParityQa = require('../renderer/parity-qa.js');
const Ledger = require('../renderer/ledger.js');

// D7 part 2, slice 5: Record QA escapes. ParityQa.escapes maps a report to escape rows; the button appends them.
const REG = path.join(__dirname, '../fixtures/system3-registry');
const read = p => fs.readFileSync(path.join(REG, p), 'utf8');
const report = () => {
  const scenarios = ['bordereaux-list', 'bordereaux-apply'].map(id => yaml.load(read(`parity/scenarios/${id}.yaml`)));
  const baselines = {}, reports = {};
  for (const s of scenarios) { baselines[s.id] = JSON.parse(read(`parity/baselines/${s.id}/legacy.json`)); reports[s.id] = JSON.parse(read(`parity/reports/${s.id}.json`)); }
  const qa = ParityQa.read(read('parity/qa/bordereaux.yaml'), { parseYaml: yaml.load, file: 'parity/qa/bordereaux.yaml' });
  return { r: ParityQa.report({ screen: 'bordereaux', scenarios, baselines, reports, qa }), qa };
};
const byKey = rows => Object.fromEntries(rows.map(x => [x.id, x]));

test('the fixture QA report has a bug in every bucket', () => {
  const { r } = report();
  assert.deepEqual(r.counts, { caught: 1, not_captured: 1, state_not_recorded: 2, not_flagged: 1, triage: 1 });
});

test('one escape per bug, by bucket: caught, state_not_recorded, not_flagged, not_captured (spec or none), triage skipped', () => {
  const { r } = report();
  const { rows, triage } = ParityQa.escapes(r, { hasSpec: true });
  assert.equal(triage, 1);
  assert.equal(rows.length, 5);
  const m = byKey(rows);
  const b = Object.fromEntries(r.bugs.map(x => [x.key, x.bucket]));
  for (const [key, bucket] of Object.entries(b)) {
    if (bucket === 'triage') { assert.ok(!m[`qa-bordereaux-${key}`]); continue; }
    const row = m[`qa-bordereaux-${key}`];
    assert.equal(row.screen, 'bordereaux');
    assert.equal(row.bucket, bucket);
    assert.equal(row.description, `${key}: ${r.bugs.find(x => x.key === key).reason}`);
    if (bucket === 'caught') { assert.equal(row.caught_by, 'parity'); assert.ok(!('origin' in row)); }
    if (bucket === 'state_not_recorded') assert.deepEqual([row.caught_by, row.origin], ['parity', 'spec_gap']);
    if (bucket === 'not_flagged') assert.deepEqual([row.caught_by, row.origin], ['parity', 'gate_gap']);
    if (bucket === 'not_captured') assert.equal(row.caught_by, 'ui-visual');
  }
  const none = ParityQa.escapes(r, { hasSpec: false }).rows.find(x => x.bucket === 'not_captured');
  assert.equal(none.caught_by, null, 'no spec: unclassified');
});

test('an id already in the ledger is skipped, so a second press adds nothing', () => {
  const { r } = report();
  const first = ParityQa.escapes(r, { hasSpec: true });
  const again = ParityQa.escapes(r, { hasSpec: true, existing: new Set(first.rows.map(x => x.id)) });
  assert.equal(again.rows.length, 0);
  assert.equal(again.skipped, 5);
  const part = ParityQa.escapes(r, { hasSpec: true, existing: new Set([first.rows[0].id]) });
  assert.equal(part.rows.length, 4);
});

test('no QA bug text reaches any row, and every row validates as an escape', () => {
  const { r, qa } = report();
  const { rows } = ParityQa.escapes(r, { hasSpec: true });
  for (const row of rows) {
    const text = JSON.stringify(row);
    for (const b of qa.bugs) assert.ok(!text.includes(String(b.description)), `${row.id} copies the description of ${b.key}`);
    assert.deepEqual(Object.keys(row).filter(k => !['id', 'description', 'screen', 'bucket', 'caught_by', 'origin'].includes(k)), [], 'only the mapped fields');
    assert.deepEqual(Ledger.validate({ kind: 'escape', by: 'x', schema_version: 1, event_id: 'e', ts: 1, ...row }), []);
  }
});
