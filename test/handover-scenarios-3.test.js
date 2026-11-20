// C4b slice 3: designc.handover.scenarios/3 (request on api examples). With no request everything is byte-identical to /1 and /2.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const yaml = require('js-yaml');
const Core = require('../renderer/core.js');
const { fixture, inputs, BOUND, MINTED } = require('./helpers/scenario-handover.js');

const ROWS = [
  { title: 'prefix match', match: 'A-', tag: 'Priority', given: { Order: [{ id: 1, ref: 'A-100' }, { id: 2, ref: 'B-200' }] }, then: { Order: [{ id: 1, tag: 'Priority' }, { id: 2, tag: null }] } },
  { title: 'whole reference', match: 'B-200', tag: 'Hold', then: { Order: [{ id: 2, tag: 'Hold' }] } },
];
const REQ = [{ ...ROWS[0], request: { query: { dryRun: false } } }, { ...ROWS[1], request: {} }];
const sc = s => ({ path: `test-scenarios/${s.id}.yaml`, text: yaml.dump(s, { lineWidth: -1 }) });
const PACK = { key: 'orders', text: 'id: orders\nversion: 1\naggregates:\n  Order: { id: OrderId, fields: { ref: string, tag: string } }\n' };
const read = n => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', n), 'utf8'));
const ORDERS = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'scenario-registry', 'contracts', 'openapi', 'orders.yaml'), 'utf8');
const DRY = ORDERS.replace('      requestBody:', "      parameters: [{ name: dryRun, in: query, schema: { type: boolean } }]\n      requestBody:");
const PATHED = ORDERS.replace('/orders/tags:', '/orders/{orderId}/tags:');
const mk = (scs, contract = DRY) => { const f = fixture(); f.testScenarios = [...scs.map(sc), sc(MINTED)]; f.apiContracts = [{ path: 'contracts/openapi/orders.yaml', text: contract }]; return f; };
const plan = (f, o = {}) => Core.handoverPlan(inputs(f, { domain: [PACK], ...o }));
const at = (p, rel) => p.files.find(x => x.path === `handovers/${p.id}/${rel}`);
const docOf = p => JSON.parse(at(p, 'scenarios.json').text);
const TEST = 'ui-contract/tests/orders.scenarios.page.test.tsx';
const golden = fs.readFileSync(path.join(__dirname, 'golden', 'orders.scenarios.page.test.tsx'), 'utf8');
const Ajv2020 = require('ajv/dist/2020');
const schema3 = read('handover-scenarios-3.schema.json');
const validate3 = new Ajv2020({ strict: false, allErrors: true }).compile(schema3);
const REQD = { ...BOUND, examples: REQ };

test('baseline: no request keeps /1 and /2 ids and files exactly as at e05d17e', () => {
  assert.equal(Core.handoverPlan(inputs(fixture())).id, '20261120-a5a67adf');
  assert.deepEqual(docOf(Core.handoverPlan(inputs(fixture()))), read('handover-scenarios.example.json'));
  const rows = mk([{ ...BOUND, examples: ROWS }], ORDERS), p = plan(rows);
  assert.equal(p.id, '20261120-6c2b1335');
  assert.deepEqual(docOf(p), read('handover-scenarios-2.example.json'));
});
test('with requests: /3, validates, equals the /3 example, body filled from effect.body, UI test unchanged', () => {
  const p = plan(mk([REQD])), doc = docOf(p), v2 = docOf(plan(mk([{ ...BOUND, examples: ROWS }], ORDERS)));
  assert.equal(doc.schema, 'designc.handover.scenarios/3');
  assert.deepEqual(doc.api[0].examples[0].request, { path: {}, query: { dryRun: false }, body: { match: 'A-', tag: 'Priority' } });
  assert.deepEqual(doc.api[0].examples[1].request, { path: {}, query: {}, body: { match: 'B-200', tag: 'Hold' } });
  assert.deepEqual(Object.keys(doc.api[0].examples[0]), ['index', 'title', 'given', 'then', 'request']);
  assert.equal(schema3.$id, 'designc.handover.scenarios/3');
  assert.ok(validate3(doc), JSON.stringify(validate3.errors));
  assert.deepEqual(doc, read('handover-scenarios-3.example.json'));
  assert.equal(at(p, TEST).text, golden);
  const strip = d => { const c = JSON.parse(JSON.stringify(d)); c.screens[0].scenarios[0].sha256 = 'x'; return { screens: c.screens, skipped: c.skipped, entities: c.entities }; };
  assert.deepEqual(strip(doc), strip(v2));
});
test('a path parameter freezes as a number', () => {
  const p = plan(mk([{ ...BOUND, examples: [{ ...ROWS[0], request: { path: { orderId: 7 } } }, { ...ROWS[1], request: { path: { orderId: 8 } } }] }], PATHED));
  const r = docOf(p).api[0].examples[0].request;
  assert.deepEqual(r.path, { orderId: 7 }); assert.equal(typeof r.path.orderId, 'number');
});
test('two api scenarios, one with requests and one without: /3, the second has no request keys', () => {
  const p = plan(mk([REQD, { ...BOUND, id: 'ORD-1-ts-03', examples: ROWS }])), doc = docOf(p);
  assert.equal(doc.schema, 'designc.handover.scenarios/3');
  assert.equal(doc.api.length, 2);
  assert.ok(doc.api[0].examples.every(e => e.request));
  assert.ok(doc.api[1].examples.every(e => !('request' in e)));
  assert.ok(validate3(doc), JSON.stringify(validate3.errors));
});
test('freeze refusals', () => {
  const bad = (examples, contract = DRY) => plan(mk([{ ...BOUND, examples }], contract));
  const E = /handover refused: scenario ORD-1-ts-01: /;
  assert.throws(() => bad([{ ...ROWS[0], request: {} }, { ...ROWS[1], request: {} }], DRY.replace('{ name: dryRun, in: query,', '{ name: dryRun, in: query, required: true,')), /handover refused: scenario ORD-1-ts-01: examples\[0\]\.request\.query: required query parameter dryRun has no value/);
  assert.throws(() => bad([{ ...ROWS[0], request: { path: { id: 1 } } }, { ...ROWS[1], request: {} }]), /examples\[0\]\.request\.path\.id: tagOrders has no path parameter id/);
  assert.throws(() => bad([{ ...ROWS[0], request: { body: { match: 'a', tag: 'b' } } }, { ...ROWS[1], request: {} }]), /examples\[0\]\.request\.body: effect\.body already gives/);
  assert.throws(() => bad([{ ...ROWS[0], request: {} }, ROWS[1]]), /handover refused: scenario ORD-1-ts-01: examples\[1\]: has no request, but examples\[0\] does/);
  assert.throws(() => bad([{ ...ROWS[0], request: { query: { dryRun: false } } }, { ...ROWS[1], request: {} }], ORDERS), /handover refused: scenario ORD-1-ts-01: examples\[0\]\.request\.query\.dryRun: tagOrders has no query parameter dryRun \(query: \(none\)\)/);
  assert.throws(() => bad([{ ...ROWS[0], request: { query: { dryRun: '{match}' } } }, { ...ROWS[1], request: {} }]), /examples\[0\]\.request\.query\.dryRun: request values are literal/);
  assert.throws(() => bad([{ ...ROWS[0], request: { headers: 1 } }, { ...ROWS[1], request: {} }]), /handover refused: scenario ORD-1-ts-01: examples\[0\]\.request: a mapping with path, query and body only/);
  assert.ok(E);
});
test('the id moves with a request value; freezing twice is stable', () => {
  const a = plan(mk([REQD]));
  assert.equal(plan(mk([REQD])).id, a.id); assert.equal(at(plan(mk([REQD])), 'scenarios.json').text, at(a, 'scenarios.json').text);
  const b = plan(mk([{ ...BOUND, examples: [{ ...REQ[0], request: { query: { dryRun: true } } }, REQ[1]] }]));
  assert.notEqual(b.id, a.id);
});
test('the /3 schema rejects an extra key, an array query value and a request without query', () => {
  const good = docOf(plan(mk([REQD])));
  const mut = fn => { const d = JSON.parse(JSON.stringify(good)); fn(d.api[0].examples[0].request); return validate3(d); };
  assert.ok(!mut(r => { r.headers = {}; }));
  assert.ok(!mut(r => { r.query.dryRun = [1]; }));
  assert.ok(!mut(r => { delete r.query; }));
  assert.ok(mut(r => { delete r.body; }));
});
