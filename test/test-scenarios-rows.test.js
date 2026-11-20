// C4: given/then example rows (C-D5). Records part (slice 1) and mint part (slice 2).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const Rec = require('../renderer/records.js');
const TS = require('../renderer/test-scenarios.js');
const Core = require('../renderer/core.js');
const { BOUND } = require('./helpers/scenario-handover.js');

const ROWS = yaml.load(`
examples:
  - title: prefix match
    match: A-
    tag: Priority
    given: { Order: [{ id: 1, ref: A-100 }, { id: 2, ref: B-200 }] }
    then:  { Order: [{ id: 1, tag: Priority }, { id: 2, tag: null }] }
  - title: whole reference
    match: B-200
    tag: Hold
    then:  { Order: [{ id: 2, tag: Hold }] }
`).examples;
const WITH = { ...BOUND, examples: ROWS };
const errs = rec => Rec.validate('test_scenario', rec);
const withEx = ex => ({ ...BOUND, examples: [{ ...ROWS[0], ...ex }] });

test('records: valid rows validate', () => {
  assert.deepEqual(errs(WITH), []);
});
test('records: each row error fires', () => {
  assert.ok(errs(withEx({ given: [] })).includes('examples[0].given: a mapping of entity name to a list of rows'));
  assert.ok(errs(withEx({ then: 'x' })).includes('examples[0].then: a mapping of entity name to a list of rows'));
  assert.ok(errs(withEx({ then: { Order: [] } })).includes('examples[0].then.Order: a non-empty list of rows'));
  assert.ok(errs(withEx({ then: { Order: [{}] } })).includes('examples[0].then.Order[0]: a row is a mapping of field to value with at least one field'));
  assert.ok(errs(withEx({ then: { Order: ['x'] } })).includes('examples[0].then.Order[0]: a row is a mapping of field to value with at least one field'));
  const r = { ...BOUND, effect: { operation: 'tagOrders', body: { a: '{given}', b: '{given}' } }, examples: [ROWS[0]] };
  const e = errs(r).filter(m => /reserved/.test(m));
  assert.deepEqual(e, ['effect.body uses {given}: {given} is reserved for an example\'s rows: rename the placeholder']);
  const s = { ...BOUND, steps: [{ ...BOUND.steps[0], value: '{then}' }, ...BOUND.steps.slice(1)] };
  assert.ok(errs(s).some(m => /^steps\[0\] uses \{then\}: .*reserved/.test(m)));
});
test('records: flat records and rowless structured scenarios are unchanged', () => {
  assert.deepEqual(errs(BOUND), []);
  assert.deepEqual(errs({ id: 'x-ts-01', requirement: 'x', title: 't', given: ['a'], when: ['b'], then: ['c'] }), []);
});
test('records: bindProblem returns the first row error', () => {
  assert.equal(TS.bindProblem(withEx({ then: { Order: [] } })), 'examples[0].then.Order: a non-empty list of rows');
  assert.equal(TS.bindProblem(WITH), null);
});
