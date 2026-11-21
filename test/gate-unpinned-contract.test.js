// Gate clause unpinned_contract (R4a): coverage, not existence. Each cross-repo rel of a requirement must name a
// d.operation found in a pinned OpenAPI file (or, async, a d.message from a pinned pack). A rel is a requirement's only when BOTH ends are its elements or inside one (C-D11). With no repos declared nothing changes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');
const yamlLoad = require('js-yaml').load;

const dsl = (webProps = '"d.operation" "listOrders"', adminProps = '"d.operation" "listOrders"', extra = '') => `workspace { model { s = softwareSystem "S" {
  api = container "Api" { properties { "d.repo" "Api" "d.code" "src/**" "d.risk" "low" }
    ctl = component "Ctl" }
  ui = container "Web" { properties { "d.repo" "Ui" "d.code" "web/**" "d.risk" "low" }
    page = component "Page" }
  ui2 = container "Admin" { properties { "d.repo" "Ui" "d.code" "admin/**" "d.risk" "low" } }
  ui3 = container "Tools" { properties { "d.repo" "Ui" "d.code" "tools/**" "d.risk" "low" } }
}
  ui -> api "lists" { properties { ${webProps} } }
  ui2 -> api "lists" { properties { ${adminProps} } }
  ${extra}
} }`;
const REPOS = { Api: '../api', Ui: '../ui' };
const spec = ids => `openapi: 3.0.3\ninfo: {title: t, version: '1'}\npaths:\n${ids.map((id, i) => `  /p${i}:\n    get: {operationId: ${id}}\n`).join('')}`;
const opsOf = ids => Core.operations({ files: { 'contracts/openapi/a.yaml': spec(ids) }, yamlLoad });
const pack = events => ({ key: 'orders', path: 'domain/orders.yaml', load: yamlLoad, text: `id: orders\nevents:\n${events.map(e => `  ${e}: {a: string}`).join('\n')}\n` });
const REQ1 = { id: 'REQ-1', elements: ['Web', 'Api'] }, REQ2 = { id: 'REQ-2', elements: ['Admin', 'Api'] };
const gate = (text, requirements, extra = {}) =>
  Core.gate({ model: Core.parse(text), diags: [], decisions: [], requirements, ledger: [], repos: REPOS, operations: opsOf(['listOrders']), ...extra });
const kinds = g => g.clauses.filter(c => c.kind === 'unpinned_contract');

test('no repos declared: never raised', () => {
  assert.deepEqual(kinds(gate(dsl(), [REQ1], { repos: null, operations: null })), []);
});

test('both rels name listOrders and it exists: no clause', () => {
  assert.deepEqual(kinds(gate(dsl(), [REQ1, REQ2])), []);
});

test('removing listOrders from the file raises a clause for each rel that names it', () => {
  const cs = kinds(gate(dsl(), [REQ1, REQ2], { operations: opsOf(['other']) }));
  assert.equal(cs.length, 2);
  assert.deepEqual(cs.map(c => c.requirement).sort(), ['REQ-1', 'REQ-2']);
  assert.match(cs[0].text, /names d\.operation "listOrders", which is not in a pinned OpenAPI file/);
  assert.deepEqual(cs.find(c => c.requirement === 'REQ-1').about, ['Web', 'Api']);
});

test('renaming the operation in the file does the same', () => {
  assert.equal(kinds(gate(dsl(), [REQ1, REQ2], { operations: opsOf(['listAllOrders']) })).length, 2);
});

test('an unrelated contract does not cover a requirement whose rel is untyped', () => {
  const cs = kinds(gate(dsl('"d.operation" "listOrders"', '"d.interaction" "sync"'), [REQ1, REQ2]));
  assert.equal(cs.length, 1);
  assert.equal(cs[0].requirement, 'REQ-2');
  assert.match(cs[0].text, /Admin → Api crosses Ui → Api and names no d\.operation/);
});

test('a duplicated operation is not covered', () => {
  const operations = Core.operations({ files: { 'contracts/openapi/a.yaml': spec(['listOrders']), 'contracts/openapi/b.yaml': spec(['listOrders']) }, yamlLoad });
  const cs = kinds(gate(dsl(), [REQ1], { operations }));
  assert.equal(cs.length, 1);
  assert.match(cs[0].text, /is defined more than once \(in contracts\/openapi\/a\.yaml, contracts\/openapi\/b\.yaml\)/);
});

test('async rel: covered by a resolving d.message, not by an unknown one', () => {
  const domains = { listed: [], packs: [pack(['OrderPlaced'])] };
  const ok = dsl('"d.interaction" "async" "d.message" "OrderPlaced"', '"d.operation" "listOrders"');
  assert.deepEqual(kinds(gate(ok, [REQ1, REQ2], { domains })), []);
  const bad = dsl('"d.interaction" "async" "d.message" "Nope"', '"d.operation" "listOrders"');
  const cs = kinds(gate(bad, [REQ1], { domains }));
  assert.equal(cs.length, 1);
  assert.match(cs[0].text, /names no d\.message from a pinned pack/);
  // an async rel is not covered by d.operation alone
  assert.equal(kinds(gate(dsl('"d.interaction" "async" "d.operation" "listOrders"'), [REQ1], { domains })).length, 1);
});

test('a requirement spanning two repos with no crossing rel gets the "no relationship crosses" clause', () => {
  const t = `workspace { model { s = softwareSystem "S" {
    api = container "Api" { properties { "d.repo" "Api" "d.code" "src/**" "d.risk" "low" } }
    ui = container "Web" { properties { "d.repo" "Ui" "d.code" "web/**" "d.risk" "low" } }
  } } }`;
  const cs = kinds(gate(t, [{ id: 'REQ-1', elements: ['Api', 'Web'] }]));
  assert.equal(cs.length, 1);
  assert.match(cs[0].text, /REQ-1 spans Api, Ui but no relationship crosses between them: model the call and name its d\.operation/);
  assert.deepEqual(cs[0].about, ['Api', 'Web']);
});

test('a rel from a component inside the requirement element counts', () => {
  const t = dsl('"d.operation" "listOrders"', '"d.operation" "listOrders"', 'page -> api "deep"');
  const cs = kinds(gate(t, [REQ1]));
  assert.equal(cs.length, 1);
  assert.deepEqual(cs[0].about, ['Page', 'Api']);
});

test('hub: Admin -> Api untyped is not REQ-1\'s, it is REQ-2\'s', () => {
  const t = dsl('"d.operation" "listOrders"', '"d.interaction" "sync"');
  const cs = kinds(gate(t, [REQ1, REQ2]));
  assert.equal(cs.length, 1);
  assert.equal(cs[0].requirement, 'REQ-2');
  assert.deepEqual(kinds(gate(t, [REQ1])), []);
});

test('a rel with only one end in the requirement is not the requirement\'s', () => {
  const t = dsl('"d.interaction" "sync"');
  assert.deepEqual(kinds(gate(t, [{ id: 'REQ-1', elements: ['Web'] }])), []);
  assert.deepEqual(kinds(gate(t, [{ id: 'REQ-1', elements: ['Api'] }])), []);
});

test('a requirement inside one repo is not raised', () => {
  assert.deepEqual(kinds(gate(dsl('', ''), [{ id: 'REQ-3', elements: ['Tools'] }])), []);
  const noRels = `workspace { model { s = softwareSystem "S" {
    a = container "A" { properties { "d.repo" "Ui" "d.code" "a/**" "d.risk" "low" } }
    b = container "B" { properties { "d.repo" "Ui" "d.code" "b/**" "d.risk" "low" } }
  } } }`;
  assert.deepEqual(kinds(gate(noRels, [{ id: 'REQ-3', elements: ['A', 'B'] }])), []);
});

test('scoped gate keeps the clause for an item that touches one of its elements, drops it otherwise', () => {
  const text = dsl('"d.interaction" "sync"');
  const model = Core.parse(text);
  const g = gate(text, [REQ1]);
  assert.equal(kinds(g).length, 1);
  assert.equal(Core.scopedGate(g, { model, elements: ['Web'], requirement: 'REQ-1', decisions: [] }).clauses.filter(c => c.kind === 'unpinned_contract').length, 1);
  assert.equal(Core.scopedGate(g, { model, elements: ['Tools'], requirement: 'REQ-1', decisions: [] }).clauses.filter(c => c.kind === 'unpinned_contract').length, 0);
});

test('the clause kind is a known gate kind in the records schema (JS)', () => {
  assert.ok(require('../renderer/records.js').GATE_KINDS.includes('unpinned_contract'));
});
