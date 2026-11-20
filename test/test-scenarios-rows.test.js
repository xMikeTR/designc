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

// ---- mint part ----
const yamlLoad = yaml.load;
const pack = (id, body) => ({ key: id, load: yamlLoad, text: `id: ${id}\nversion: 1\naggregates:\n${body}\n` });
const ORDERS = pack('orders', '  Order: { id: OrderId, fields: { ref: string, tag: string } }');
const ctx = (o = {}) => ({
  pageText: BOUND.source, specs: [], entities: Core.packAggregates([ORDERS]), resolveOperation: () => ({}), ...o,
});
// Only the row reasons: the spec is absent, so screen/locator problems are filtered out here.
const ROW_REASONS = ['no_domain_pack', 'unknown_entity', 'unknown_field', 'rows_incomplete', 'placeholder_in_rows'];
const probs = (rec, c) => TS.mintProblems(rec, c).filter(p => ROW_REASONS.includes(p.reason));

test('mint: valid rows give no row problem', () => assert.deepEqual(probs(WITH, ctx()), []));
test('mint: no_domain_pack once per scenario when no pack is pinned', () => {
  const p = probs(WITH, ctx({ entities: [] }));
  assert.deepEqual(p.map(x => x.reason), ['no_domain_pack']);
  assert.match(p[0].message, /none is pinned \(domain\/\*\.yaml\)/);
});
test('mint: unknown_entity names the example and the section', () => {
  const p = probs(withEx({ given: { Ordr: [{ id: 1 }] } }), ctx());
  assert.equal(p[0].reason, 'unknown_entity');
  assert.match(p[0].message, /^examples\[0\]\.given\.Ordr: no pinned pack defines aggregate Ordr/);
});
test('mint: an ambiguous bare name is unknown_entity with the qualified hint', () => {
  const p = probs(WITH, ctx({ entities: Core.packAggregates([ORDERS, pack('billing', '  Order: { id: OId }')]) }));
  assert.equal(p[0].reason, 'unknown_entity');
  assert.match(p[0].message, /Order is defined by billing and orders: write billing\/Order/);
});
test('mint: unknown_field lists the declared fields', () => {
  const p = probs(withEx({ then: { Order: [{ id: 1, tagz: 'x' }] } }), ctx());
  assert.equal(p[0].reason, 'unknown_field');
  assert.match(p[0].message, /^examples\[0\]\.then\.Order\[0\]\.tagz: Order has no field tagz \(fields: id, ref, tag\)/);
});
test('mint: rows_incomplete when some example has rows and another has no then', () => {
  const rec = { ...BOUND, examples: [ROWS[0], { title: 'bare', match: 'x', tag: 'y' }] };
  const p = probs(rec, ctx());
  assert.deepEqual(p.map(x => x.reason), ['rows_incomplete']);
  assert.match(p[0].message, /^examples\[1\]: has no then rows, but examples\[0\] does/);
});
test('mint: placeholder_in_rows', () => {
  const p = probs(withEx({ then: { Order: [{ id: 1, tag: '{tag}' }] } }), ctx());
  assert.equal(p[0].reason, 'placeholder_in_rows');
  assert.match(p[0].message, /^examples\[0\]\.then\.Order\[0\]\.tag: rows are literal: write this example's value, not \{tag\}/);
});
test('mint: no rows and no packs adds no problem; flat records only source_not_in_page', () => {
  assert.deepEqual(probs(BOUND, ctx({ entities: [] })), []);
  assert.deepEqual(TS.mintProblems({ id: 'x', requirement: 'r', title: 't', source: 'nope', given: ['a'], when: ['b'], then: ['c'] }, ctx({ entities: [] })).map(x => x.reason), ['source_not_in_page']);
});
