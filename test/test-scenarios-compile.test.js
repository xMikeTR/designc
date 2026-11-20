// B3 slice 1: TestScenarios.compile, the pure step from a bound structured scenario to its request test cases.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const TS = require('../renderer/test-scenarios.js');

const orders = { screen: 'orders', component: 'OrdersList', file: 'src/pages/OrdersList.tsx',
  slots: { 'header.actions': [{ id: 'tag', component: 'Button', locator: { role: 'button', name: 'Tag orders' } }] },
  states: { loading: { initial: true, pending: ['orders'] }, ready: {}, 'tag-popover': {} } };
const popover = { screen: 'orders-tag', component: 'OrdersTagPopover', host: { screen: 'orders', state: 'tag-popover', anchor: 'tag' },
  slots: { fields: [{ id: 'match', component: 'TextField', locator: { role: 'textbox', name: 'Match' } }], actions: [{ id: 'apply', component: 'Button', locator: { role: 'button', name: 'Apply' } }] } };
const specs = [{ path: 'ui/specs/orders.json', text: JSON.stringify(orders) }, { path: 'ui/specs/orders-tag.json', text: JSON.stringify(popover) }];
const ops = { tagOrders: { method: 'POST', path: '/orders/tags' }, tagOne: { method: 'PUT', path: '/orders/{id}/tag', server: '/v1' } };
const operations = id => ops[id] || null;
const scen = (o = {}) => ({ id: 'ORD-1-ts-01', requirement: 'ORD-1', title: 't', screen: 'orders-tag', status: 'bound',
  steps: [{ fill: { role: 'textbox', name: 'Match' }, value: '{match}' }, { click: { role: 'button', name: 'Apply' } }],
  effect: { operation: 'tagOrders', body: { match: '{match}', n: '{n}', label: 'tag {match}!', list: ['{n}', 'x'] } },
  examples: [{ title: 'prefix', match: 'A', n: 3 }, { match: 'B', n: 4 }], ...o });
const compile = (s = scen(), over = {}) => TS.compile({ scenario: s, specs, operations, path: 'test-scenarios/ORD-1-ts-01.yaml', ...over });

test('compile: a hosted scenario renders the host and starts with a click on the anchor', () => {
  const c = compile();
  assert.equal(c.screen, 'orders'); assert.equal(c.component, 'OrdersList'); assert.equal(c.file, 'src/pages/OrdersList.tsx');
  assert.deepEqual(c.cases[0].steps[0], { verb: 'click', role: 'button', name: 'Tag orders' });
  assert.deepEqual(c.cases[0].steps.slice(1), [{ verb: 'fill', role: 'textbox', name: 'Match', value: 'A' }, { verb: 'click', role: 'button', name: 'Apply' }]);
});
test('compile: a scenario on a plain screen is not prepended', () => {
  const c = compile(scen({ screen: 'orders', steps: [{ click: { role: 'button', name: 'Tag orders' } }] }));
  assert.deepEqual(c.cases[0].steps, [{ verb: 'click', role: 'button', name: 'Tag orders' }]);
});
test('compile: whole-string placeholders keep the example type, embedded ones are text, recursion into objects and arrays', () => {
  const c = compile();
  assert.deepEqual(c.cases.map(x => x.title), ['ORD-1-ts-01 example 1', 'ORD-1-ts-01 example 2']);
  assert.deepEqual(c.cases[0].request, { method: 'POST', path: '/orders/tags', body: { match: 'A', n: 3, label: 'tag A!', list: [3, 'x'] } });
  assert.equal(c.cases[1].request.body.n, 4);
});
test('compile: no body gives null; {id} becomes :id and the servers prefix is applied', () => {
  const c = compile(scen({ effect: { operation: 'tagOne' }, steps: [{ click: { role: 'button', name: 'Apply' } }], examples: [{ a: 1 }] }));
  assert.deepEqual(c.cases[0].request, { method: 'PUT', path: '/v1/orders/:id/tag', body: null });
});
test('compile: the start state is the initial one unless it holds data back', () => {
  assert.equal(compile().state, 'ready');
  assert.equal(TS.startState({ states: { a: { initial: true }, b: {} } }), 'a');
  assert.equal(TS.startState({ states: { a: { failed: ['x'] }, b: {} } }), 'b');
});
test('compile refusals: no file, unknown screen, unresolved operation, unfilled placeholder', () => {
  const noFile = [{ path: 'ui/specs/orders.json', text: JSON.stringify({ ...orders, file: undefined }) }, specs[1]];
  assert.throws(() => compile(scen(), { specs: noFile }), /handover refused: .*orders.* no `file`/);
  assert.throws(() => compile(scen({ screen: 'nope' })), /handover refused: .*ORD-1-ts-01.*no ui spec for nope/);
  assert.throws(() => compile(scen({ effect: { operation: 'gone' } })), /handover refused: .*ORD-1-ts-01.*operation gone/);
  assert.throws(() => compile(scen({ examples: [{ match: 'A' }] })), /handover refused: .*ORD-1-ts-01.*examples\[0\].*\{n\}/);
});

// ---- B3 slice 2: the test text
const fs = require('fs'), path = require('path');
const { fixture, BOUND } = require('./helpers/scenario-handover.js');
const yaml = require('js-yaml');
const compileFixture = (over = {}) => {
  const f = fixture();
  return TS.compile({ scenario: { ...BOUND, ...over }, specs: f.ui.specs, operations: id => (id === 'tagOrders' ? { method: 'POST', path: '/orders/tags' } : null), path: 'test-scenarios/ORD-1-ts-01.yaml' });
};
const GOLDEN = path.join(__dirname, 'golden', 'orders.scenarios.page.test.tsx');
test('testFile: the fixture scenario matches the checked-in golden file (UPDATE_GOLDEN=1 rewrites it)', () => {
  const text = TS.testFile('orders', [compileFixture()]);
  if (process.env.UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, text);
  assert.equal(text, fs.readFileSync(GOLDEN, 'utf8'));
});
test('testFile: same input gives identical bytes, scenarios are sorted by id, and no body is expected as null', () => {
  const a = compileFixture(), b = compileFixture({ id: 'ORD-1-ts-00', effect: { operation: 'tagOrders' } });
  assert.equal(TS.testFile('orders', [a, b]), TS.testFile('orders', [b, a]));
  const t = TS.testFile('orders', [a, b]);
  assert.ok(t.indexOf('ORD-1-ts-00 example 1') < t.indexOf('ORD-1-ts-01 example 1'));
  assert.match(t, /\.toEqual\(null\)/);
  assert.match(t, /^\/\/ GENERATED by designc from test-scenarios\/ORD-1-ts-01\.yaml, test-scenarios\/ORD-1-ts-01\.yaml\. Do not edit\.\n/);
});
