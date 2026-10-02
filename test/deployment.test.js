const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');
const DslEdit = require('../renderer/canvas/dsl-edit.js');

const dsl = `workspace {
 model {
  sys = softwareSystem "Pricing" {
   api = container "Pricing API" "" "C#"
   db = container "Quotes DB" "" "SQL"
  }
  api -> db "writes" "TDS"
  live = deploymentEnvironment "Live" {
   cloud = deploymentNode "Azure" "the cloud" "Azure" {
    region = deploymentNode "UK South" {
     app = deploymentNode "App Service" "web tier" "Linux" "Hosting" 3 {
      apiInstance = containerInstance api
      infrastructureNode "Gateway" "front door" "Front Door"
     }
     sql = deploymentNode "Azure SQL" "" "SQL" {
      dbInstance = containerInstance db {
       properties {
        "d.replicas" "2"
       }
      }
     }
    }
   }
  }
  deploymentEnvironment "Staging" {
   deploymentNode "Box" {
    containerInstance api
   }
  }
 }
}`;
const m = Core.parse(dsl);

test('deployment environments parse without errors and stay out of the logical model', () => {
  assert.deepEqual(m.errors, []);
  assert.equal(m.elements.size, 3);
  assert.deepEqual(m.deployment.environments.map(e => e.name), ['Live', 'Staging']);
});

test('nodes nest, carry technology and instances, and instances resolve to elements', () => {
  const live = m.deployment.environments[0];
  const azure = live.nodes[0];
  assert.equal(azure.name, 'Azure'); assert.equal(azure.technology, 'Azure'); assert.equal(azure.kind, 'deploymentNode');
  const app = azure.children[0].children[0];
  assert.equal(app.name, 'App Service'); assert.equal(app.instances, '3');
  assert.deepEqual(app.children.map(c => [c.kind, c.name]), [['containerInstance', 'Pricing API'], ['infrastructureNode', 'Gateway']]);
  assert.equal(app.children[0].ref, [...m.elements.values()].find(e => e.name === 'Pricing API').id);
  const db = azure.children[0].children[1].children[0];
  assert.equal(db.props['d.replicas'], '2');
});

test('an instance of an unknown element is an error with a line', () => {
  const bad = Core.parse(dsl.replace('containerInstance db {', 'containerInstance nope {'));
  assert.ok(bad.errors.some(e => /unknown element "nope"/.test(e.msg) && e.line > 0));
});

test('deploymentView picks the configured environment, the only one, or asks', () => {
  assert.equal(Core.deploymentView(m, 'Staging').env.name, 'Staging');
  assert.deepEqual(Core.deploymentView(m, null).choices, ['Live', 'Staging']);
  assert.equal(Core.deploymentView(m, 'Nope').error.includes('Nope'), true);
  const one = Core.parse(dsl.replace(/ *deploymentEnvironment "Staging" \{[\s\S]*?\n  \}\n/, ''));
  assert.equal(Core.deploymentView(one, null).env.name, 'Live');
  assert.deepEqual(Core.deploymentView(Core.parse('workspace { model { a = softwareSystem "A" } }'), null).choices, []);
});

test('the canvas editor still locates elements in a document that has deployment blocks', () => {
  const loc = DslEdit.locate(dsl);
  assert.deepEqual(loc.elements.map(e => e.name), ['Pricing', 'Pricing API', 'Quotes DB']);
});
