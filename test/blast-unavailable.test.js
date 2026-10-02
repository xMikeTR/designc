const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const dsl = (deploy) => `workspace {
 model {
  u = person "Underwriter"
  sys = softwareSystem "Pricing" {
   web = container "Web"
   api = container "Pricing API"
   db = container "Quotes DB"
   q = container "Queue"
   audit = container "Audit"
  }
  u -> web "x" "t" { properties { "d.interaction" "sync" } }
  web -> api "x" "t" { properties { "d.interaction" "sync" } }
  api -> db "x" "t" { properties { "d.interaction" "sync" } }
  audit -> q "x" "t" { properties { "d.interaction" "async" } }
  api -> q "x" "t" { properties { "d.interaction" "async" } }
  ${deploy}
 }
}`;
const live = `deploymentEnvironment "Live" {
   deploymentNode "Azure" {
    deploymentNode "Zone A" {
     containerInstance web
     containerInstance api
     containerInstance db
    }
    deploymentNode "Zone B" {
     containerInstance web
     containerInstance q
    }
   }
  }`;
const run = (node, o = {}, deploy = live) => { const m = Core.parse(dsl(deploy)); return Core.blastRadius(m, node, { mode: 'unavailable', environment: 'Live', ...o }); };
const names = l => l.map(x => x.name).sort();

test('an element is lost only when every instance sits inside the failed node', () => {
  const r = run('Azure/Zone A');
  assert.deepEqual(names(r.lost), ['Pricing API', 'Quotes DB']);
  assert.deepEqual(names(r.survivors), ['Web']);
});

test('dependents of a lost element go down (sync) or degraded (async), as for misbehaves', () => {
  const r = run('Azure/Zone A');
  assert.deepEqual(names(r.down), ['Underwriter', 'Web']); // Web has an instance in Zone B, but its sync calls to the lost API fail
  assert.ok(!names(r.down).includes('Pricing API'));
});

test('a node containing every instance loses the lot, and an async consumer is degraded', () => {
  const r = run('Azure/Zone B');
  assert.deepEqual(names(r.lost), ['Queue']);
  assert.deepEqual(names(r.degraded), ['Audit', 'Pricing API']);
});

test('failing a parent node fails everything beneath it', () => {
  assert.deepEqual(names(run('Azure').lost), ['Pricing API', 'Queue', 'Quotes DB', 'Web']);
});

test('unknown node path, unknown environment and no deployment all return an error', () => {
  assert.match(run('Azure/Zone C').error, /No deployment node "Azure\/Zone C"/);
  assert.match(run('Azure', { environment: 'Nope' }).error, /Nope/);
  assert.match(run('Azure', {}, '').error, /no deploymentEnvironment/);
});
