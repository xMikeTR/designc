const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../renderer/ledger.js');

test('legacy escape names are upcast to code and caught_by', () => {
  const lines = [
    JSON.stringify({ kind: 'escape', id: 'E-0001', description: 'd', rule: 'DC003', stage: 'S1-lint', ts: 1 }),
    JSON.stringify({ kind: 'escape_classified', escape: 'E-0001', stage: 'pipeline', ts: 2 }),
  ];
  const { events, errors } = Ledger.parse(lines.join('\n'), 'designc.jsonl');
  assert.deepEqual(errors, []);
  assert.equal(events[0].code, 'DC003');
  assert.equal(events[0].caught_by, 'S1-lint');
  assert.equal('rule' in events[0], false);
  assert.equal('stage' in events[0], false);
  assert.equal(events[1].caught_by, 'pipeline');
  assert.equal('stage' in events[1], false);
});

test('v1 escapes enforce the MAF names and the caught_by vocabulary', () => {
  const base = { schema_version: 1, by: 'u', kind: 'escape', id: 'E-0001', description: 'd' };
  assert.ok(Ledger.validate({ ...base, stage: 'S1-lint' }).some(e => /stage: unknown field/.test(e)));
  assert.ok(Ledger.validate({ ...base, rule: 'DC003' }).some(e => /rule: unknown field/.test(e)));
  assert.ok(Ledger.validate({ ...base, caught_by: 'S9' }).some(e => /caught_by: must be null or one of/.test(e)));
  assert.deepEqual(Ledger.validate({ ...base, caught_by: 'S1-lint' }), []);
  assert.deepEqual(Ledger.validate({ ...base, caught_by: null }), []);
  assert.deepEqual(Ledger.validate(base), []);

  const cbase = { schema_version: 1, by: 'u', kind: 'escape_classified', escape: 'E-0001' };
  assert.ok(Ledger.validate(cbase).some(e => /escape_classified\.caught_by: required/.test(e)));
  assert.deepEqual(Ledger.validate({ ...cbase, caught_by: null }), []);
  assert.deepEqual(Ledger.validate({ ...cbase, caught_by: 'S1-p' }), []);
});

test('classification folds onto escapes in file order', () => {
  const escape = { kind: 'escape', id: 'E-0001', description: 'd', ts: 1, schema_version: 1, event_id: 'e1', by: 'u' };
  const v1classified1 = { kind: 'escape_classified', escape: 'E-0001', caught_by: 'S1-p', ts: 2, schema_version: 1, event_id: 'e2', by: 'u' };
  const legacyClassified = { kind: 'escape_classified', escape: 'E-0001', stage: 'S1-grill', ts: 3 };
  const v1classified2 = { kind: 'escape_classified', escape: 'E-0001', caught_by: null, ts: 4, schema_version: 1, event_id: 'e4', by: 'u' };

  const all = [escape, v1classified1, legacyClassified, v1classified2].map((e, i) => {
    if (e.schema_version === undefined) return { ...Ledger.upcast(e), schema_version: 1, event_id: `legacy:x:${i}`, _legacy: true };
    return e;
  });
  const derived = Ledger.derive(all);
  assert.equal(derived.length, 1);
  assert.equal(derived[0].kind, 'escape');
  assert.equal(derived[0].caught_by, null);

  const dropLast = Ledger.derive(all.slice(0, 3));
  assert.equal(dropLast.length, 1);
  assert.equal(dropLast[0].caught_by, 'S1-grill');
});
