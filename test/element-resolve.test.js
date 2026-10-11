// Every element reference a pipeline writes (task.element, needs_decision.element, asbuilt_edge from/to) is an
// elements.json id (System/Container/Component), resolved id first, then a unique name or d.aka.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const M = Core.parse(`workspace { model {
  q = softwareSystem "Quotes" {
    api = container "Quotes API" { properties { "d.aka" "pricing-api" } }
    db = container "Quotes DB"
  }
  b = softwareSystem "Billing" {
    api2 = container "Quotes API"
  }
} }`);
const row = (from, to) => ({ kind: 'asbuilt_edge', from, to });

test('resolveElement takes the hierarchical id first', () => {
  assert.equal(Core.resolveElement(M, 'Quotes/Quotes API').id, 'api');
  assert.equal(Core.resolveElement(M, 'Billing/Quotes API').id, 'api2');
});

test('resolveElement falls back to a unique name or d.aka, and refuses an ambiguous name', () => {
  assert.equal(Core.resolveElement(M, 'Quotes DB').id, 'db');
  assert.equal(Core.resolveElement(M, 'pricing-api').id, 'api');
  assert.equal(Core.resolveElement(M, 'Quotes API'), null, 'two elements share this name');
  assert.equal(Core.resolveElement(M, 'Nope'), null);
  assert.equal(Core.resolveElement(M, null), null);
});

test('drift reads asbuilt_edge ends given as elements.json ids', () => {
  const r = Core.drift(M, [row('Quotes/Quotes API', 'Quotes/Quotes DB')]);
  assert.deepEqual(r.unknownEls, []);
  assert.deepEqual(r.undeclared, [{ from: 'Quotes API', to: 'Quotes DB' }]);
});

test('drift still reads names for older rows and for pipelines that only know names', () => {
  const r = Core.drift(M, [row('pricing-api', 'Quotes DB')]);
  assert.deepEqual(r.unknownEls, []);
  assert.deepEqual(r.undeclared, [{ from: 'Quotes API', to: 'Quotes DB' }]);
});

test('every id Core.handoverElements writes resolves back to its element', () => {
  const text = `workspace { model {
    u = person "Underwriter"
    q = softwareSystem "Quotes" { api = container "Quotes API" { pr = component "Pricing" } }
  } }`;
  const m = Core.parse(text);
  for (const e of Core.handoverElements(text).elements) {
    const r = Core.resolveElement(m, e.id);
    assert.ok(r, `${e.id} resolves`);
    assert.equal(r.name, e.name);
  }
});
