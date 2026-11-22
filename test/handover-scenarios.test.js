// B3 slice 3: the frozen handover holds the generated scenario tests and scenarios.json (designc.handover.scenarios/1).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const yaml = require('js-yaml');
const Core = require('../renderer/core.js');
const Ui = require('../renderer/ui.js');
const { fixture, inputs, BOUND, MINTED } = require('./helpers/scenario-handover.js');

const plan = (f = fixture(), o = {}) => Core.handoverPlan(inputs(f, o));
const at = (p, rel) => p.files.find(x => x.path === `handovers/${p.id}/${rel}`);
const sc = (s, text = true) => ({ path: `test-scenarios/${s.id}.yaml`, text: yaml.dump(s, { lineWidth: -1 }) });
const TEST = 'ui-contract/tests/orders.scenarios.page.test.tsx';

test('the freeze holds the test (equal to the golden), scenarios.json with matching hashes, and handover.yaml names it', () => {
  const p = plan(), f = fixture();
  assert.equal(at(p, TEST).text, fs.readFileSync(path.join(__dirname, 'golden', 'orders.scenarios.page.test.tsx'), 'utf8'));
  const doc = JSON.parse(at(p, 'scenarios.json').text);
  assert.equal(doc.schema, 'designc.handover.scenarios/1');
  assert.deepEqual(doc.screens, [{ screen: 'orders', component: 'OrdersList', test: { path: TEST, sha256: Ui.sha256(at(p, TEST).text) },
    scenarios: [{ id: 'ORD-1-ts-01', path: 'test-scenarios/ORD-1-ts-01.yaml', sha256: Ui.sha256(f.testScenarios[0].text), operation: { id: 'tagOrders', method: 'POST', path: '/orders/tags' }, examples: [{ index: 1, title: 'prefix match' }, { index: 2, title: 'whole reference' }] }] }]);
  assert.match(at(p, 'handover.yaml').text, /^scenario_tests: "scenarios\.json"$/m);
  assert.match(at(p, 'BUILD.md').text, /ui-contract\/tests\/\*\.scenarios\.page\.test\.tsx/);
  assert.ok(at(p, 'handover.yaml').text.includes(`{ path: "${TEST}", hash:`), 'the test is listed and hashed in files:');
});
test('a minted scenario is listed in skipped with a reason, never dropped', () => {
  const doc = JSON.parse(at(plan(), 'scenarios.json').text);
  assert.deepEqual(doc.skipped.map(s => s.scenario), ['ORD-1-ts-02']);
  assert.match(doc.skipped[0].reason, /minted/);
});
test('a bound scenario whose render screen is not among the handover UI screens is skipped', () => {
  const g = fixture(); const spec = JSON.parse(g.ordersFile.text); spec.component = 'Other';
  g.ui = { ...g.ui, specs: [{ path: g.ordersFile.path, text: JSON.stringify(spec) }, g.tagFile] };
  const doc = JSON.parse(at(plan(g), 'scenarios.json').text);
  assert.equal(doc.screens.length, 0);
  assert.match(doc.skipped.find(s => s.scenario === 'ORD-1-ts-01').reason, /orders.*not among the handover's UI screens/);
});
test('a bound scenario without an operation or examples is skipped with its reason', () => {
  const f = fixture(); f.testScenarios = [sc({ ...BOUND, examples: [] }), sc({ ...BOUND, id: 'ORD-1-ts-03', effect: undefined, steps: BOUND.steps })];
  const doc = JSON.parse(at(plan(f), 'scenarios.json').text);
  assert.deepEqual(doc.skipped.map(s => s.scenario), ['ORD-1-ts-01', 'ORD-1-ts-03']);
  assert.match(doc.skipped[0].reason, /no examples/); assert.match(doc.skipped[1].reason, /no operation/);
});
test('refusals: render spec without a file, an operation that does not resolve, an unfilled placeholder', () => {
  const f = fixture(); const spec = JSON.parse(f.ordersFile.text); delete spec.file;
  f.ui = { ...f.ui, specs: [{ path: f.ordersFile.path, text: JSON.stringify(spec) }, f.tagFile] };
  assert.throws(() => plan(f), /handover refused: .*orders.* no `file`/);
  const g = fixture(); g.apiContracts = [];
  assert.throws(() => plan(g), /handover refused: .*ORD-1-ts-01.*operation tagOrders/);
  const h = fixture(); h.testScenarios = [sc({ ...BOUND, examples: [{ match: 'A' }] })];
  assert.throws(() => plan(h), /handover refused: .*ORD-1-ts-01.*\{tag\}/);
});
test('no bound scenarios: no key, no files', () => {
  const f = fixture(); f.testScenarios = [sc(MINTED)];
  const p = plan(f);
  assert.ok(at(p, 'scenarios.json'), 'a skip alone still gives the document');
  const g = fixture(); g.testScenarios = [];
  const q = plan(g);
  assert.ok(!q.files.some(x => /scenarios\.json|scenarios\.page\.test/.test(x.path)));
  assert.ok(!/^scenario_tests:/m.test(q.files[0].text));
  assert.ok(!/scenarios\.page\.test/.test(at(q, 'BUILD.md').text));
});
test('scenarios of a requirement that is not in the handover are not part of it', () => {
  const f = fixture(); f.testScenarios = [sc({ ...BOUND, requirement: 'OTHER-9' })];
  assert.ok(!plan(f).files.some(x => /scenarios\.json/.test(x.path)));
});
test('freezing twice gives the same id; a changed example gives another; the scenario text is in the id', () => {
  const a = plan().id;
  assert.equal(plan().id, a);
  const f = fixture(); f.testScenarios = [sc({ ...BOUND, examples: [{ title: 'x', match: 'Z', tag: 'Hold' }] }), sc(MINTED)];
  assert.notEqual(plan(f).id, a);
  const g = fixture(); g.testScenarios = [sc({ ...BOUND, title: 'Renamed' }), sc(MINTED)];
  assert.notEqual(plan(g).id, a, 'scenario file hash is in the id');
});
test('docs/handover-scenarios.schema.json validates scenarios.json and the pinned example, and rejects an extra field', () => {
  const Ajv2020 = require('ajv/dist/2020');
  const read = n => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', n), 'utf8'));
  const schema = read('handover-scenarios.schema.json'), example = read('handover-scenarios.example.json');
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
  const doc = JSON.parse(at(plan(), 'scenarios.json').text);
  assert.equal(schema.$id, doc.schema);
  assert.ok(validate(doc), JSON.stringify(validate.errors));
  assert.ok(validate(example), JSON.stringify(validate.errors));
  assert.deepEqual(doc, example, 'the example is what the planner writes for the fixture');
  const bad = JSON.parse(JSON.stringify(example)); bad.screens[0].scenarios[0].extra = 1;
  assert.ok(!validate(bad));
});
