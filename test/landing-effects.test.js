// S4 E: Landing.effects(idx, model, rec). Pure. Callers through the component and the container, readers of a store, async
// consumers, one hop forward, and `unknown` at every gap: never a bare empty result.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Core = require('../renderer/core.js');
const Landing = require('../renderer/landing.js');
const { extract } = require('../extract.js');

const sync = '{ properties { "d.interaction" "sync" } }', asyn = '{ properties { "d.interaction" "async" } }';
const DSL = `workspace "T" { model {
 s = softwareSystem "S" {
  web = container "Web" "" "React"
  api = container "Api" "" ".NET" {
    orders = component "Orders"
    billing = component "Billing"
    lonely = component "Lonely"
  }
  jobs = container "Jobs" "" "F#"
  report = container "Report" "" "Py"
  audit = container "Audit" "" "Py"
  queue = container "Queue" "" "Kafka"
  sub = container "Sub" "" "Py"
  db = container "Db" "" "SQL" "Database"
  island = container "Island" "" "Go" {
    atoll = component "Atoll"
  }
 }
 web -> orders "calls" "HTTPS" ${sync}
 orders -> db "writes" "SQL" ${sync}
 jobs -> db "reads" "SQL" ${sync}
 report -> db "reads" "SQL" ${asyn}
 audit -> jobs "x" "HTTPS" ${sync}
 billing -> queue "publish" "AMQP" ${asyn}
 billing -> sub "x" "HTTPS"
 audit -> api "checks" "HTTPS" ${sync}
}}`;
const model = Core.parse(DSL);
const idx = Landing.buildIndex(model, {});
const rec = (...nodes) => ({ requirement: 'R-1', changes: nodes.map(n => ({ node: n, what: 'x' })) });
const ids = l => l.map(x => x.id);

test('callers through the component are via component; through the container, via container', () => {
  const r = Landing.effects(idx, model, rec('Api/Orders'));
  const web = r.callers.find(c => c.id === 'web'), audit = r.callers.find(c => c.id === 'audit');
  assert.equal(web.via, 'component');
  assert.equal(web.name, 'Web');
  assert.equal(audit.via, 'container', 'audit calls the Api container, not the component');
});

test('the fares shape: the API app shell has no caller of its own, the portal shows through the container', async () => {
  const r0 = await extract(path.join(__dirname, '..', 'demo', 'fares-e2e', 'codebase'));
  const m = Core.parse(r0.dsl), ix = Landing.buildIndex(m, r0.facts);
  const r = Landing.effects(ix, m, rec('Fares.Api/POST /bookings#handler'));
  const portal = r.callers.find(c => c.id === 'e_faresportal');
  assert.ok(portal, JSON.stringify(r));
  assert.equal(portal.via, 'container');
  assert.ok(r.callers.every(c => c.via === 'container'), 'nothing was found through the component');
});

test('a store: every other element with a rel to it is a reader', () => {
  const r = Landing.effects(idx, model, rec('Api/Orders'));
  assert.deepEqual(ids(r.readers), ['jobs', 'report']);
  const direct = Landing.effects(idx, model, rec('Db'));
  assert.deepEqual(ids(direct.readers), ['jobs', 'orders', 'report']);
});

test('one hop only: a reader\'s caller is not listed anywhere beyond the callers of the changed node', () => {
  const r = Landing.effects(idx, model, rec('Api/Orders'));
  assert.equal(r.readers.some(x => x.id === 'audit'), false, 'audit calls jobs, a reader of the store: two hops');
  assert.equal(r.consumers.some(x => x.id === 'audit'), false);
});

test('an async rel puts its destination in consumers; an undeclared one gives an unknown row', () => {
  const r = Landing.effects(idx, model, rec('Api/Billing'));
  assert.deepEqual(ids(r.consumers), ['queue']);
  assert.ok(r.unknown.some(u => u.node === 'Api/Billing' && u.why === 'interaction undeclared to Sub'), JSON.stringify(r.unknown));
  assert.equal(r.consumers.some(x => x.id === 'sub'), false);
});

test('a new or ambiguous node is an unknown row and nothing else', () => {
  const r = Landing.effects(idx, model, rec('Api/NoSuchThing'));
  assert.deepEqual(r.unknown, [{ node: 'Api/NoSuchThing', why: 'not on the code map' }]);
  assert.deepEqual([r.callers, r.readers, r.consumers], [[], [], []]);
  const r2 = Landing.effects(idx, model, rec('Brand.New/Thing'));
  assert.deepEqual(r2.unknown, [{ node: 'Brand.New/Thing', why: 'not on the code map' }]);
});

test('never empty at a gap: no callers, readers or consumers anywhere gives an unknown row', () => {
  const r = Landing.effects(idx, model, rec('Island/Atoll'));
  assert.deepEqual(r.unknown, [{ node: 'Island/Atoll', why: 'no callers found on the code map' }]);
  const none = Landing.effects(idx, model, { requirement: 'R-1', changes: [] });
  assert.deepEqual(none, { callers: [], readers: [], consumers: [], unknown: [] }, 'no change points, nothing to say');
});

test('the result is sorted and de-duplicated; the model is not touched', () => {
  const before = JSON.stringify(model.rels);
  const r = Landing.effects(idx, model, rec('Api/Orders', 'Api/Orders', 'Api/Lonely'));
  assert.deepEqual(r.callers.map(c => c.name), [...r.callers.map(c => c.name)].sort());
  assert.equal(new Set(ids(r.callers)).size, r.callers.length);
  assert.equal(JSON.stringify(model.rels), before);
});
