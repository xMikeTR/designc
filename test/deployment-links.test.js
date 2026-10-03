const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const dsl = `workspace {
 model {
  sys = softwareSystem "Pricing" {
   api = container "Pricing API"
   db = container "Quotes DB"
  }
  deploymentEnvironment "Live" {
   app = deploymentNode "App Service" {
    apiInstance = containerInstance api
    gw = infrastructureNode "Gateway"
    gw -> apiInstance "routes to" "HTTPS"
    -> sql "reaches" "TDS" { properties { "x" "y" } }
   }
   sql = deploymentNode "Azure SQL" {
    containerInstance db
   }
   app -> sql "talks to"
  }
 }
 views {
  deployment sys "Live" "live-view" {
   include *
   autoLayout
  }
  systemContext sys "ctx" { include * }
 }
}`;

test('relationships between deployment elements resolve to paths, with explicit and implicit sources', () => {
  const m = Core.parse(dsl);
  const env = m.deployment.environments[0];
  assert.deepEqual(env.rels.map(r => [r.src, r.dst, r.description, r.technology]), [
    ['App Service/Gateway', 'App Service/Pricing API', 'routes to', 'HTTPS'],
    ['App Service', 'Azure SQL', 'reaches', 'TDS'],
    ['App Service', 'Azure SQL', 'talks to', null],
  ]);
  assert.equal(m.rels.length, 0, 'deployment relationships never enter the logical model');
});

test('a deployment relationship naming an unknown identifier is an error with a line', () => {
  const m = Core.parse(dsl.replace('app -> sql "talks to"', 'app -> nowhere "x"'));
  assert.deepEqual(m.errors.map(e => e.msg), ['unknown deployment element "nowhere"']);
  assert.equal(m.errors[0].line, 17);
  assert.equal(m.deployment.environments[0].rels.length, 2);
});

test('deployment views are listed and must name a declared environment', () => {
  assert.deepEqual(Core.parse(dsl).deployment.views, [
    { scope: 'sys', environment: 'Live', key: 'live-view', line: 21, system: 'sys' },
  ]);
  const m = Core.parse(dsl.replace('systemContext sys "ctx" { include * }', 'deployment * Live2 {\n   include *\n  }'));
  assert.deepEqual(m.errors.map(e => e.msg), ['deployment view names unknown environment "Live2"']);
  assert.equal(m.errors[0].line, 25);
  assert.equal(m.deployment.views.length, 1);
});

test('a deployment view scope is * or a declared software system', () => {
  const swap = scope => Core.parse(dsl.replace('deployment sys "Live"', `deployment ${scope} "Live"`));
  assert.deepEqual(swap('*').errors, []);
  assert.equal(swap('*').deployment.views[0].system, null);
  assert.deepEqual(swap('nowhere').errors.map(e => e.msg), ['deployment view names unknown software system "nowhere"']);
  assert.equal(swap('nowhere').errors[0].line, 21);
  assert.equal(swap('nowhere').deployment.views.length, 0, 'an invalid view is not listed');
  assert.deepEqual(swap('api').errors.map(e => e.msg), ['deployment view scope must be a software system']);
  assert.deepEqual(swap('api').deployment.views, []);
});
