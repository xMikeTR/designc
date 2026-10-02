const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const dsl = body => Core.parse(`workspace "W" {\n model {\n${body}\n }\n}`);
const base = `
 sys = softwareSystem "Pricing" {
  api = container "Pricing API" "" ".NET 8" {
   properties { "d.instances" "3" }
  }
  db = container "Quotes DB" "" "SQL" { tags "Database" }
 }
 api -> db "reads" "EF" { properties { "d.interaction" "sync" } }
`;
const kinds = d => d.elements.map(e => `${e.change}:${e.name}`).sort();

test('identical models have no changes, and description, tags, order and whitespace do not count', () => {
  const a = dsl(base);
  const b = dsl(`
 sys = softwareSystem "Pricing" "now with a description" {
  db = container "Quotes DB" "other words" "SQL" { tags "Database", "Extra" }
  api = container "Pricing API" "" ".NET 8" {
   properties { "d.instances" "3" }
  }
 }

 api -> db "reads, differently worded" "EF" { properties { "d.interaction" "sync" } }
`);
  const d = Core.diffModels(a, b);
  assert.deepEqual(d.elements, []); assert.deepEqual(d.rels, []);
  assert.deepEqual(d.summary, { added: 0, removed: 0, changed: 0, relsAdded: 0, relsRemoved: 0, relsChanged: 0 });
});

test('added and removed elements and rels', () => {
  const a = dsl(base);
  const b = dsl(base.replace(' db = container "Quotes DB" "" "SQL" { tags "Database" }', ' q = container "Queue" "" "Service Bus"').replace('api -> db "reads" "EF" { properties { "d.interaction" "sync" } }', 'api -> q "sends" "AMQP"'));
  const d = Core.diffModels(a, b);
  assert.deepEqual(kinds(d), ['added:Queue', 'removed:Quotes DB']);
  assert.equal(d.rels.length, 2);
  assert.deepEqual(d.rels.map(r => r.change).sort(), ['added', 'removed']);
  assert.equal(d.summary.added, 1); assert.equal(d.summary.relsRemoved, 1);
});

test('same identifier with a new name is a rename; technology and d.* changes are listed as fields', () => {
  const b = dsl(base.replace('"Pricing API" "" ".NET 8"', '"Rating API" "" ".NET 9"').replace('"d.instances" "3"', '"d.instances" "5" "d.critical" "yes"'));
  const d = Core.diffModels(dsl(base), b);
  assert.equal(d.elements.length, 1);
  const e = d.elements[0];
  assert.equal(e.change, 'changed'); assert.equal(e.name, 'Rating API'); assert.equal(e.renamedFrom, 'Pricing API');
  assert.deepEqual(e.fields.map(f => f.field).sort(), ['d.critical', 'd.instances', 'name', 'technology']);
  assert.deepEqual(e.fields.find(f => f.field === 'd.instances'), { field: 'd.instances', from: '3', to: '5' });
  assert.equal(e.fields.find(f => f.field === 'd.critical').from, null);
});

test('a changed identifier with the same name under the same parent is the same element', () => {
  const d = Core.diffModels(dsl(base), dsl(base.replace('api = container', 'pricingApi = container').replace('api -> db', 'pricingApi -> db')));
  assert.deepEqual(d.elements, []); assert.deepEqual(d.rels, []);
});

test('moving an element to another parent is a change in parent', () => {
  const a = dsl(` s1 = softwareSystem "A" {\n  c = container "C"\n }\n s2 = softwareSystem "B"`);
  const b = dsl(` s1 = softwareSystem "A"\n s2 = softwareSystem "B" {\n  c = container "C"\n }`);
  const d = Core.diffModels(a, b);
  assert.equal(d.elements.length, 1);
  assert.deepEqual(d.elements[0].fields, [{ field: 'parent', from: 'A', to: 'B' }]);
});

test('rels are keyed on their ends and ordinal: a parallel rel added shows as one added, a changed technology as changed', () => {
  const two = base + ' api -> db "also" "Dapper"\n';
  const d = Core.diffModels(dsl(base), dsl(two));
  assert.deepEqual(d.rels.map(r => r.change), ['added']);
  const e = Core.diffModels(dsl(base), dsl(base.replace('"EF"', '"Dapper"')));
  assert.equal(e.rels.length, 1); assert.equal(e.rels[0].change, 'changed');
  assert.deepEqual(e.rels[0].fields, [{ field: 'technology', from: 'EF', to: 'Dapper' }]);
  assert.equal(e.rels[0].label, 'Pricing API → Quotes DB');
});
