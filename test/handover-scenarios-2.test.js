// C4 slice 3: designc.handover.scenarios/2 (example rows). With no rows everything is byte-identical to /1.
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
const ROWED = { ...BOUND, examples: ROWS };
const sc = s => ({ path: `test-scenarios/${s.id}.yaml`, text: yaml.dump(s, { lineWidth: -1 }) });
const PACK = { key: 'orders', text: 'id: orders\nversion: 1\naggregates:\n  Order: { id: OrderId, fields: { ref: string, tag: string } }\n' };
const rowFixture = (s = ROWED) => { const f = fixture(); f.testScenarios = [sc(s), sc(MINTED)]; return f; };
const plan = (f = rowFixture(), o = {}) => Core.handoverPlan(inputs(f, { domain: [PACK], ...o }));
const at = (p, rel) => p.files.find(x => x.path === `handovers/${p.id}/${rel}`);
const read = n => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', n), 'utf8'));
const TEST = 'ui-contract/tests/orders.scenarios.page.test.tsx';
const golden = fs.readFileSync(path.join(__dirname, 'golden', 'orders.scenarios.page.test.tsx'), 'utf8');

test('no rows: id and scenarios.json are what they were at 9867f4f (/1, example unchanged)', () => {
  const p = Core.handoverPlan(inputs(fixture()));
  assert.equal(p.id, '20261120-a5a67adf');
  assert.deepEqual(JSON.parse(at(p, 'scenarios.json').text), read('handover-scenarios.example.json'));
  const q = Core.handoverPlan(inputs(fixture(), { domain: [PACK] }));
  assert.equal(q.id.slice(0, 9), '20261120-'); assert.equal(JSON.parse(at(q, 'scenarios.json').text).schema, 'designc.handover.scenarios/1');
});
test('rows: /2 with api, qualified keys, entities; validates and equals the /2 example; UI test unchanged', () => {
  const p = plan(), doc = JSON.parse(at(p, 'scenarios.json').text), v1 = JSON.parse(at(Core.handoverPlan(inputs(fixture())), 'scenarios.json').text);
  assert.equal(doc.schema, 'designc.handover.scenarios/2');
  assert.deepEqual(doc.api[0].examples[1].given, {});
  assert.deepEqual(Object.keys(doc.api[0].examples[0].then), ['orders/Order']);
  assert.deepEqual(doc.entities, [{ id: 'orders/Order', pack: 'orders', name: 'Order', version: 1, fields: [{ name: 'ref', type: 'string' }, { name: 'tag', type: 'string' }] }]);
  assert.equal(at(p, TEST).text, golden);
  assert.deepEqual(doc.skipped, v1.skipped);
  const s1 = JSON.parse(JSON.stringify(doc.screens)), s0 = JSON.parse(JSON.stringify(v1.screens));
  for (const s of [s0, s1]) s[0].scenarios[0].sha256 = 'x';
  assert.deepEqual(s1, s0);
  const Ajv2020 = require('ajv/dist/2020');
  const schema = read('handover-scenarios-2.schema.json');
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
  assert.equal(schema.$id, 'designc.handover.scenarios/2');
  assert.ok(validate(doc), JSON.stringify(validate.errors));
  assert.deepEqual(doc, read('handover-scenarios-2.example.json'));
  const bad = JSON.parse(JSON.stringify(doc)); bad.api[0].extra = 1; assert.ok(!validate(bad));
  const bad2 = JSON.parse(JSON.stringify(doc)); bad2.api[0].examples[0].then['orders/Order'] = []; assert.ok(!validate(bad2));
  assert.match(at(p, 'handover.yaml').text, /^scenario_tests: "scenarios\.json"$/m);
});
test('a minted scenario with rows is not in api', () => {
  const f = fixture(); f.testScenarios = [sc({ ...ROWED, status: 'minted' })];
  const p = plan(f);
  assert.equal(JSON.parse(at(p, 'scenarios.json').text).schema, 'designc.handover.scenarios/1');
});
test('an Api-only freeze (no UI part) still carries api', () => {
  const f = rowFixture(); f.ui = null;
  const p = plan(f), doc = JSON.parse(at(p, 'scenarios.json').text);
  assert.equal(doc.schema, 'designc.handover.scenarios/2'); assert.deepEqual(doc.screens, []); assert.equal(doc.api.length, 1);
  assert.match(at(p, 'handover.yaml').text, /^scenario_tests: "scenarios\.json"$/m);
});
test('freeze refusals: no pack, unknown entity, hand-edited bad row, unresolved operation', () => {
  assert.throws(() => plan(rowFixture(), { domain: [] }), /handover refused: scenario ORD-1-ts-01: examples: .*none is pinned/);
  const bad = ex => rowFixture({ ...ROWED, examples: [{ ...ROWS[0], ...ex }, ROWS[1]] });
  assert.throws(() => plan(bad({ given: { Ordr: [{ id: 1 }] } })), /handover refused: scenario ORD-1-ts-01: examples\[0\]\.given\.Ordr/);
  assert.throws(() => plan(bad({ then: { Order: [] } })), /handover refused: scenario ORD-1-ts-01: examples\[0\]\.then\.Order: a non-empty list of rows/);
  const g = rowFixture(); g.apiContracts = [];
  assert.throws(() => plan(g), /handover refused: .*ORD-1-ts-01.*operation tagOrders/);
});
test('the id moves with a row and with the pack fields; freezing twice is stable', () => {
  const a = plan();
  assert.equal(plan().id, a.id); assert.equal(at(plan(), 'scenarios.json').text, at(a, 'scenarios.json').text);
  const row = rowFixture({ ...ROWED, examples: [{ ...ROWS[0], then: { Order: [{ id: 1, tag: 'Other' }] } }, ROWS[1]] });
  assert.notEqual(plan(row).id, a.id);
  const pk = { ...PACK, text: PACK.text.replace('tag: string', 'tag: string, extra: string') };
  assert.notEqual(plan(rowFixture(), { domain: [pk] }).id, a.id);
});
test('BUILD.md: the api rule comes after the dependencies rule only with api; earlier numbers unchanged', () => {
  const withRows = at(plan(), 'BUILD.md').text, without = at(Core.handoverPlan(inputs(fixture())), 'BUILD.md').text;
  assert.match(withRows, /`scenarios\.json` `api` lists example rows/);
  assert.ok(!/`api` lists example rows/.test(without));
  const n = t => (t.match(/^(\d+)\. /gm) || []).map(x => parseInt(x));
  assert.deepEqual(n(withRows).slice(0, n(without).length), n(without));
});
