const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const rel = (a, b, kind) => `${a} -> ${b} "x" "t"${kind ? ` {\n properties {\n "d.interaction" "${kind}"\n }\n }` : ''}`;
const model = rels => Core.parse(`workspace {
 model {
  u = person "Traveller"
  sys = softwareSystem "Fares" {
   web = container "Web"
   api = container "Fares API"
   db = container "Bookings DB"
   q = container "Queue"
   worker = container "Worker"
   audit = container "Audit"
  }
  ${rels.join('\n  ')}
 }
}`);
const id = (m, name) => [...m.elements.values()].find(e => e.name === name).id;
const names = list => list.map(x => x.name).sort();
const run = (rels, origin, o = {}) => { const m = model(rels); return Core.blastRadius(m, id(m, origin), { mode: 'misbehaves', ...o }); };

test('sync callers go down, transitively', () => {
  const r = run([rel('u', 'web', 'sync'), rel('web', 'api', 'sync'), rel('api', 'db', 'sync')], 'Bookings DB');
  assert.deepEqual(names(r.down), ['Fares API', 'Traveller', 'Web']);
  assert.deepEqual([r.degraded, r.unknown], [[], []]);
});

test('an async caller is degraded and the damage stops there', () => {
  const r = run([rel('worker', 'db', 'async'), rel('u', 'worker', 'sync')], 'Bookings DB');
  assert.deepEqual(names(r.degraded), ['Worker']);
  assert.deepEqual(r.down, []);
});

test('an undeclared interaction is unknown, never guessed, and stops there', () => {
  const r = run([rel('api', 'db'), rel('web', 'api', 'sync')], 'Bookings DB');
  assert.deepEqual(names(r.unknown), ['Fares API']);
  assert.deepEqual(r.down, []);
});

test('sync beats degraded beats unknown when an element is reached several ways', () => {
  const r = run([rel('api', 'db', 'sync'), rel('api', 'q'), rel('web', 'api', 'async'), rel('web', 'db')], 'Bookings DB');
  assert.deepEqual(names(r.down), ['Fares API']);
  assert.deepEqual(names(r.degraded), ['Web']);
  assert.deepEqual(names(r.unknown), []);
});

test('paths give the shortest route from the origin to each affected element', () => {
  const r = run([rel('u', 'web', 'sync'), rel('web', 'api', 'sync'), rel('api', 'db', 'sync')], 'Bookings DB');
  const p = r.paths.find(x => x.to === 'Traveller');
  assert.deepEqual(p.via, ['Bookings DB', 'Fares API', 'Web', 'Traveller']);
  assert.equal(p.kind, 'down');
});

test('cycles terminate and the origin is never its own victim', () => {
  const r = run([rel('api', 'db', 'sync'), rel('db', 'api', 'sync')], 'Bookings DB');
  assert.deepEqual(names(r.down), ['Fares API']);
});

test('elements nothing depends on have an empty radius; other modes are refused', () => {
  const r = run([rel('api', 'db', 'sync')], 'Audit');
  assert.deepEqual([r.down, r.degraded, r.unknown, r.paths], [[], [], [], []]);
  const m = model([]);
  assert.match(Core.blastRadius(m, id(m, 'Audit'), { mode: 'nonsense' }).error, /mode/);
});
