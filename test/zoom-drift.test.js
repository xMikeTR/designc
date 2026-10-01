const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { extract } = require('../extract.js');
const Core = require('../renderer/core.js');

const FULLSTACK = path.join(__dirname, '..', 'fixtures', 'fullstack');
const byName = (m, n, kind) => [...m.elements.values()].find(e => e.name === n && (!kind || e.kind === kind));
const statusOf = (m, d, from, to) => {
  const r = m.rels.find(x => m.elements.get(x.src).name === from && m.elements.get(x.dst).name === to);
  return r && d.relStatus.get(r.id);
};

// A hand-written as-built model: the extractor does not emit component to component edges inside a
// container yet, and these tests are about the comparison, not the extractor.
const BUILT = `workspace "x (as built)" {
  model {
    sys = softwareSystem "Shop" {
      e_api = container "Shop.Api" "" "ASP.NET Core" {
        c_app = component "App shell" "" ""
        c_cust = component "CustomersController" "" ""
        c_ord = component "OrderEndpoints" "" ""
        c_infra = component "Shop.Infrastructure" "" ""
      }
      e_fn = container "Shop.Functions" "" "Azure Functions" {
        f_app = component "App shell" "" ""
        f_ord = component "OrderFunctions" "" ""
      }
      e_ui = container "ui" "" "React SPA" {
        u_api = component "api" "" ""
      }
    }
    c_cust -> c_infra "Uses" "" { properties { "d.interaction" "sync" } }
    c_ord -> c_infra "Uses" "" { properties { "d.interaction" "sync" } }
    c_app -> c_infra "Uses" "" { properties { "d.interaction" "sync" } }
    f_ord -> f_app "Uses" "" { properties { "d.interaction" "sync" } }
    u_api -> c_cust "Calls" "HTTP" { properties { "d.interaction" "sync" } }
  }
}`;
const design = body => `workspace "d" { model { sys = softwareSystem "Shop" {
  api = container "Shop.Api" { ${body.api || ''} }
  fn = container "Shop.Functions"
  ui = container "ui"
}
${body.rels || ''}
} }`;

test('containers whose design has no components are neutral and adoptable', async () => {
  const built = Core.parse((await extract(FULLSTACK)).dsl);
  const d = Core.driftComponents(Core.parse(design({ rels: 'ui -> api "Calls"' })), built);
  assert.equal(d.scored.size, 0);
  const comps = [...built.elements.values()].filter(e => e.kind === 'component');
  assert.ok(comps.length);
  for (const c of comps) assert.ok(d.neutral.has(c.id), `${c.name} neutral`);
  assert.ok(![...d.relStatus.values()].includes('undeclared'));
  // only containers with a design match are adoptable (design has Shop.Api, Shop.Functions, ui)
  const adoptNames = d.adoptable.map(a => built.elements.get(a.built).name).sort();
  assert.deepEqual(adoptNames, ['Shop.Api', 'Shop.Functions', 'ui']);
  for (const a of d.adoptable) assert.equal(Core.parse(design({})).elements.get(a.design).kind, 'container');
});

test('components match by name or d.aka inside the matched container', () => {
  const m = Core.parse(BUILT);
  const dm = Core.parse(design({
    api: `cust = component "CustomersController"
      ord = component "Orders" { properties { "d.aka" "OrderEndpoints" } }
      infra = component "Shop.Infrastructure"
      legacy = component "Legacy"`,
    rels: 'cust -> infra "Uses"',
  }));
  const d = Core.driftComponents(dm, m);
  assert.deepEqual([...d.scored].map(id => m.elements.get(id).name), ['Shop.Api']);
  assert.equal(d.toDesign.get(byName(m, 'OrderEndpoints').id).name, 'Orders');
  assert.deepEqual(d.unknownEls, ['App shell']);
  assert.deepEqual(d.missingEls, ['Legacy']);
  const st = (f, t) => m.rels.filter(r => m.elements.get(r.src).name === f && m.elements.get(r.dst).name === t).map(r => d.relStatus.get(r.id));
  assert.deepEqual(st('CustomersController', 'Shop.Infrastructure'), ['matched']);
  assert.deepEqual(st('OrderEndpoints', 'Shop.Infrastructure'), ['undeclared']);
  assert.deepEqual(st('App shell', 'Shop.Infrastructure'), ['unmapped']);
  // Shop.Functions has no designed components: its components are neutral, its intra rel too
  assert.ok(d.neutral.has(byName(m, 'OrderFunctions').id));
  assert.deepEqual(st('OrderFunctions', 'App shell'), ['neutral']);
});

test('cross-container component rels also match the lifted design rel', () => {
  const m = Core.parse(BUILT);
  const run = dsl => Core.driftComponents(Core.parse(dsl), m);
  const rel = d => d.relStatus.get(m.rels.find(r => m.elements.get(r.src).name === 'api').id);
  // container-level rel only; Shop.Api scored or not
  assert.equal(rel(run(design({ rels: 'ui -> api "Calls"' }))), 'matched');
  assert.equal(rel(run(design({ api: 'cust = component "CustomersController"', rels: 'ui -> api "Calls"' }))), 'matched');
  // component-level rel
  assert.equal(rel(run(design({ api: 'cust = component "CustomersController"', rels: 'ui -> cust "Calls"' }))), 'matched');
  // neither
  assert.equal(rel(run(design({ api: 'cust = component "CustomersController"' }))), 'undeclared');
  // unrealised: a designed component rel with both ends built but no built rel
  const d = run(design({ api: 'cust = component "CustomersController"\n infra = component "Shop.Infrastructure"', rels: 'infra -> cust "Uses"' }));
  assert.deepEqual(d.unrealised.map(u => [u.from, u.to]), [['Shop.Infrastructure', 'CustomersController']]);
});
