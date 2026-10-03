// Scoped deployment views: which view or environment is shown, what a scope keeps, and who is affected by system.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const dsl = `workspace {
 model {
  sysP = softwareSystem "Pricing" {
   api = container "Pricing API"
   db = container "Quotes DB"
  }
  sysC = softwareSystem "Claims" {
   capi = container "Claims API"
   cdb = container "Claims DB"
  }
  sysB = softwareSystem "Billing" {
   bapi = container "Billing API"
  }
  capi -> api "prices" { properties { "d.interaction" "sync" } }
  bapi -> api "quotes" { properties { "d.interaction" "async" } }
  api -> db "reads" { properties { "d.interaction" "sync" } }
  deploymentEnvironment "Live" {
   app = deploymentNode "App Service" {
    apiI = containerInstance api
    capiI = containerInstance capi
    bapiI = containerInstance bapi
    gw = infrastructureNode "Gateway"
    gw -> apiI "routes to"
   }
   sql = deploymentNode "Azure SQL" {
    containerInstance db
   }
   csql = deploymentNode "Claims SQL" {
    containerInstance cdb
   }
   waf = infrastructureNode "WAF"
   lb = infrastructureNode "Load balancer"
   lb -> apiI "balances"
   app -> sql "talks to"
   waf -> csql "guards"
  }
  deploymentEnvironment "Staging" {
   deploymentNode "Box" { containerInstance api }
  }
 }
 views {
  deployment sysP Live "pricing-live" { include * }
  deployment * Live "all-live" { include * }
  deployment * Staging "staging" { include * }
 }
}`;
const m = Core.parse(dsl);

test('the model parses cleanly', () => assert.deepEqual(m.errors, []));

test('picker choices list every declared view, then "All of" each environment', () => {
  const c = Core.deploymentChoices(m);
  assert.deepEqual(c.map(x => x.label), ['pricing-live · Pricing · Live', 'all-live · * · Live', 'staging · * · Staging', 'All of Live', 'All of Staging']);
  assert.deepEqual(c.map(x => x.id), ['view:pricing-live', 'view:all-live', 'view:staging', 'env:Live', 'env:Staging']);
  assert.deepEqual(Core.deploymentChoices(Core.parse('workspace { model { a = softwareSystem "A" } }')), []);
});

test('deploymentView reads a view key first, then an environment name, and a view wins a collision', () => {
  const byKey = Core.deploymentView(m, 'pricing-live');
  assert.equal(byKey.env.name, 'Live');
  assert.equal(byKey.view.key, 'pricing-live');
  const byEnv = Core.deploymentView(m, 'Staging');
  assert.equal(byEnv.env.name, 'Staging');
  assert.equal(byEnv.view, null, 'an environment name means the whole environment');
  const clash = Core.parse(dsl.replace('deployment * Staging "staging"', 'deployment * Staging "Live"'));
  assert.equal(Core.deploymentView(clash, 'Live').env.name, 'Staging', 'the view called Live wins');
  assert.match(Core.deploymentView(m, 'Nope').error, /Nope/);
  assert.deepEqual(Core.deploymentView(m, null).choices, ['Live', 'Staging']);
});

const names = nodes => nodes.map(n => n.node.name);
const scope = key => { const v = Core.deploymentView(m, key); return Core.deploymentScope(m, v.env, v.view); };

test('a system-scoped view keeps nodes with its instances, and the infrastructure tied to them', () => {
  const s = scope('pricing-live');
  assert.equal(s.scoped, true);
  assert.equal(s.system, 'Pricing');
  assert.deepEqual(names(s.nodes), ['App Service', 'Azure SQL', 'Load balancer']);
  const app = s.nodes[0];
  assert.deepEqual(app.insts.map(i => i.name), ['Pricing API']);
  assert.deepEqual(names(app.children), ['Gateway'], 'infrastructure inside a shown node');
  assert.deepEqual(app.shared, [{ system: 'Billing', count: 1 }, { system: 'Claims', count: 1 }]);
  assert.equal(s.hidden, 2, 'Claims SQL and WAF are not shown');
  assert.deepEqual(s.rels.map(r => `${r.src}>${r.dst}`), ['App Service/Gateway>App Service/Pricing API', 'Load balancer>App Service/Pricing API', 'App Service>Azure SQL']);
});

test('a * view, an environment pick and an unscoped view show everything', () => {
  for (const key of ['all-live', 'Live']) {
    const s = scope(key);
    assert.equal(s.scoped, false, key);
    assert.deepEqual(names(s.nodes), ['App Service', 'Azure SQL', 'Claims SQL', 'WAF', 'Load balancer']);
    assert.deepEqual(s.nodes[0].insts.map(i => i.name), ['Pricing API', 'Claims API', 'Billing API']);
    assert.deepEqual(s.nodes[0].shared, []);
    assert.equal(s.hidden, 0);
    assert.equal(s.rels.length, 4);
  }
});

test('bySystem groups elements by their software system, sorted by name', () => {
  const ids = ['capi', 'api', 'db', 'bapi', 'sysP'].map(id => ({ id, name: m.elements.get(id).name }));
  assert.deepEqual(Core.bySystem(m, ids).map(g => [g.system, g.items.map(i => i.name)]), [
    ['Billing', ['Billing API']], ['Claims', ['Claims API']], ['Pricing', ['Pricing API', 'Quotes DB', 'Pricing']],
  ]);
  const withPerson = Core.parse('workspace { model { u = person "U"\n s = softwareSystem "S" { c = container "C" } } }');
  assert.deepEqual(Core.bySystem(withPerson, [{ id: 'u', name: 'U' }, { id: 'c', name: 'C' }]).map(g => g.system), ['S', null], 'no system comes last');
});

test('unavailable impact on a shared node splits into this view and other systems', () => {
  const r = Core.blastRadius(m, 'App Service', { mode: 'unavailable', environment: 'Live' });
  const lost = Core.bySystem(m, r.lost);
  assert.deepEqual(lost.map(g => g.system), ['Billing', 'Claims', 'Pricing'], 'the whole node is lost for three systems');
  const view = Core.deploymentView(m, 'pricing-live').view;
  assert.deepEqual(Core.splitBySystem(m, r.lost, view.system).map(x => [x.here, x.groups.map(g => g.system)]), [[true, ['Pricing']], [false, ['Billing', 'Claims']]]);
  assert.deepEqual(Core.splitBySystem(m, r.lost, null).map(x => x.here), [true], 'an unscoped view puts everything in one group');
});
