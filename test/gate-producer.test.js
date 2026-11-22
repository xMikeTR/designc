// Gate producer check (R4b): a rel's d.message must be an event its source publishes (d.owns aggregate in the same pack) or a P model announces.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');
const yamlLoad = require('js-yaml').load;

const PACK = { key: 'orders', path: 'domain/orders.yaml', load: yamlLoad, text: `id: orders
aggregates:
  Order: {id: OrderId, publishes: [OrderPlaced]}
  Cart: {id: CartId}
events:
  OrderPlaced: {orderId: string}
` };
const dsl = (ownerProps, rel = '"d.interaction" "async" "d.message" "OrderPlaced"') => `workspace { model { s = softwareSystem "S" {
  shop = container "Shop" { properties { ${ownerProps} }
    cmp = component "Checkout" }
  mail = container "Mail"
}
  shop -> mail "sends" { properties { ${rel} } }
} }`;
const gate = (text, extra = {}) => Core.gate({ model: Core.parse(text), diags: [], decisions: [], requirements: [], ledger: [], domains: { listed: ['orders'], packs: [PACK], behaviour: [] }, ...extra });
const prod = g => g.clauses.filter(c => c.kind === 'domain' && /names d\.message/.test(c.text));

test('the source owns the aggregate that publishes the event: no clause', () => {
  assert.deepEqual(prod(gate(dsl('"d.owns" "Order"'))), []);
});
test('the source owns an aggregate that does not publish it: clause names the rel and event', () => {
  const cs = prod(gate(dsl('"d.owns" "Cart"')));
  assert.equal(cs.length, 1);
  assert.match(cs[0].text, /Shop → Mail names d\.message orders\/OrderPlaced, but Shop owns no aggregate that publishes it/);
  assert.deepEqual(cs[0].about, ['Shop', 'Mail']);
  assert.ok(cs[0].rel);
});
test('owned by a descendant component of the source: ok', () => {
  const t = dsl('"d.risk" "low"').replace('cmp = component "Checkout"', 'cmp = component "Checkout" { properties { "d.owns" "Order" } }');
  assert.deepEqual(prod(gate(t)), []);
});
test('owned by an ancestor of the source: ok', () => {
  const t = `workspace { model { s = softwareSystem "S" { properties { "d.owns" "Order" }
    shop = container "Shop"
    mail = container "Mail" }
    shop -> mail "x" { properties { "d.interaction" "async" "d.message" "OrderPlaced" } } } }`;
  assert.deepEqual(prod(gate(t)), []);
});
test('not owned, but a P model announces eOrderPlaced: ok', () => {
  const g = gate(dsl('"d.risk" "low"'), { domains: { listed: ['orders'], packs: [PACK], behaviour: [{ path: 'behaviour/a.p', text: 'machine M { state S { entry { announce eOrderPlaced; } } }' }] } });
  assert.deepEqual(prod(g), []);
  assert.equal(prod(gate(dsl('"d.risk" "low"'))).length, 1);
});
test('a d.message that does not resolve: no producer clause (DC011 and coverage own it)', () => {
  assert.deepEqual(prod(gate(dsl('"d.risk" "low"', '"d.interaction" "async" "d.message" "Nope"'))), []);
});
test('no domains: none', () => {
  assert.deepEqual(prod(gate(dsl('"d.risk" "low"'), { domains: null })), []);
});
test('scopedGate keeps the clause by about, drops it otherwise', () => {
  const text = dsl('"d.owns" "Cart"');
  const g = gate(text), model = Core.parse(text);
  const n = els => Core.scopedGate(g, { model, elements: els, requirement: null, decisions: [] }).clauses.filter(c => /names d\.message/.test(c.text)).length;
  assert.equal(n(['Mail']), 1);
  assert.equal(n(['Elsewhere']), 0);
});
