// S8: "Record as escape" on Done. Work.escapeRow builds the fields for recordEvent('escape', ...); the row must pass Ledger.validate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Work = require('../renderer/work.js');
const Ledger = require('../renderer/ledger.js');

const UUID = '1234abcd-0000-4000-8000-000000000000';
const item = (o = {}) => ({ id: 'W-fix', title: 'Fix the fare total', requirement: 'QT-1', elements: ['Fares API', 'Fares DB'], evidence: [{ parity: 'tags-list', step: 1 }, { jira: 'RE-1234' }, { jira: 'RE-9' }], ...o });
const valid = row => Ledger.validate({ kind: 'escape', by: 'mike', ...row });

test('countermeasures, lowest first', () => {
  assert.deepEqual(Work.COUNTERMEASURES, ['lint', 'test', 'journey', 'designc_rule']);
});

test('escapeRow: each countermeasure gives a valid row naming the item, the first Jira key and the gate', () => {
  for (const countermeasure of Work.COUNTERMEASURES) {
    const r = Work.escapeRow(item(), { countermeasure, gate: 'no-float-money' }, UUID);
    assert.equal(r.error, undefined);
    assert.deepEqual(r, {
      id: 'E-1234abcd', description: 'W-fix: Fix the fare total', source: 'designc-done', element: 'Fares API',
      ref: { kind: 'jira', id: 'RE-1234' }, payload: { item: 'W-fix', countermeasure, gate: 'no-float-money', reference: 'RE-1234' },
    });
    assert.deepEqual(valid(r), []);
  }
});

test('escapeRow: strengthens only on a journey, and trimmed', () => {
  const r = Work.escapeRow(item(), { countermeasure: 'journey', gate: ' booking-flow ', strengthens: ' fares/booking ' }, UUID);
  assert.deepEqual(r.payload, { item: 'W-fix', countermeasure: 'journey', gate: 'booking-flow', strengthens: 'fares/booking', reference: 'RE-1234' });
  assert.deepEqual(valid(r), []);
  const blank = Work.escapeRow(item(), { countermeasure: 'journey', gate: 'g', strengthens: '  ' }, UUID);
  assert.ok(!('strengthens' in blank.payload));
});

test('escapeRow: one plain sentence for each mistake', () => {
  const ok = { countermeasure: 'test', gate: 'g' };
  assert.deepEqual(Work.escapeRow(item({ evidence: [{ parity: 'tags-list', step: 1 }] }), ok, UUID), { error: 'W-fix has no Jira evidence, so there is no bug to record as an escape.' });
  assert.deepEqual(Work.escapeRow(item({ evidence: undefined }), ok, UUID), { error: 'W-fix has no Jira evidence, so there is no bug to record as an escape.' });
  assert.deepEqual(Work.escapeRow(item(), { ...ok, countermeasure: 'prayer' }, UUID), { error: 'The countermeasure is lint, test, journey or designc_rule.' });
  assert.deepEqual(Work.escapeRow(item(), { ...ok, gate: '  ' }, UUID), { error: 'Name the check that now stops this: a lint rule id, a test name, a journey or a designc rule.' });
  assert.deepEqual(Work.escapeRow(item(), { ...ok, gate: undefined }, UUID), { error: 'Name the check that now stops this: a lint rule id, a test name, a journey or a designc rule.' });
  assert.deepEqual(Work.escapeRow(item(), { ...ok, strengthens: 'a/b' }, UUID), { error: 'Only a journey can strengthen an existing one.' });
});

test('escapeRow: nothing from Jira or the item beyond its key, id and title reaches the row', () => {
  const it = item({ evidence: [{ jira: 'RE-1234', title: 'SECRETTITLE', summary: 'SECRETSUM' }], notes: 'SECRETNOTE', jira: { labels: ['SECRETLABEL'] } });
  const r = Work.escapeRow(it, { countermeasure: 'lint', gate: 'g' }, UUID);
  assert.equal(r.error, undefined);
  const text = JSON.stringify(r);
  for (const leak of ['SECRET', 'tags-list']) assert.ok(!text.includes(leak), leak);
  assert.deepEqual(valid(r), []);
});

test('escapeRow: an item with no element still gives a valid row without one', () => {
  const r = Work.escapeRow(item({ elements: [] }), { countermeasure: 'test', gate: 'g' }, UUID);
  assert.ok(!('element' in r));
  assert.deepEqual(valid(r), []);
});
