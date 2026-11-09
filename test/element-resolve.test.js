// Every element reference a pipeline writes (task.element, needs_decision.element, asbuilt_edge from/to) is an
// elements.json id (System/Container/Component), resolved id first, then a unique name or d.aka.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const M = Core.parse(`workspace { model {
  q = softwareSystem "Bookings" {
    api = container "Bookings API" { properties { "d.aka" "fares-api" } }
    db = container "Bookings DB"
  }
  b = softwareSystem "Billing" {
    api2 = container "Bookings API"
  }
} }`);
const row = (from, to) => ({ kind: 'asbuilt_edge', from, to });

test('resolveElement takes the hierarchical id first', () => {
  assert.equal(Core.resolveElement(M, 'Bookings/Bookings API').id, 'api');
  assert.equal(Core.resolveElement(M, 'Billing/Bookings API').id, 'api2');
});

test('resolveElement falls back to a unique name or d.aka, and refuses an ambiguous name', () => {
  assert.equal(Core.resolveElement(M, 'Bookings DB').id, 'db');
  assert.equal(Core.resolveElement(M, 'fares-api').id, 'api');
  assert.equal(Core.resolveElement(M, 'Bookings API'), null, 'two elements share this name');
  assert.equal(Core.resolveElement(M, 'Nope'), null);
  assert.equal(Core.resolveElement(M, null), null);
});

test('drift reads asbuilt_edge ends given as elements.json ids', () => {
  const r = Core.drift(M, [row('Bookings/Bookings API', 'Bookings/Bookings DB')]);
  assert.deepEqual(r.unknownEls, []);
  assert.deepEqual(r.undeclared, [{ from: 'Bookings API', to: 'Bookings DB' }]);
});

test('drift still reads names for older rows and for pipelines that only know names', () => {
  const r = Core.drift(M, [row('fares-api', 'Bookings DB')]);
  assert.deepEqual(r.unknownEls, []);
  assert.deepEqual(r.undeclared, [{ from: 'Bookings API', to: 'Bookings DB' }]);
});

test('every id Core.handoverElements writes resolves back to its element', () => {
  const text = `workspace { model {
    u = person "Traveller"
    q = softwareSystem "Bookings" { api = container "Bookings API" { pr = component "Fares" } }
  } }`;
  const m = Core.parse(text);
  for (const e of Core.handoverElements(text).elements) {
    const r = Core.resolveElement(m, e.id);
    assert.ok(r, `${e.id} resolves`);
    assert.equal(r.name, e.name);
  }
});
