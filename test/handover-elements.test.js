const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const dsl = `workspace "Bookings" {
  model {
    u = person "Traveller"
    s = softwareSystem "Bookings" {
      api = container "Bookings API" "" "C#" {
        properties {
          d.code "./src/Api/**, src/Shared/"
          d.risk medium
        }
        calc = component "Fares" {
          properties {
            d.code "src/Api/Fares/**"
            d.risk high
          }
        }
      }
      db = container "Bookings DB"
    }
    u -> api "prices a booking"
    api -> db "reads"
    api -> db "writes"
  }
}`;

const behaviour = [
  { path: 'behaviour/b.p', text: 'machine B { start state S { entry { announce BookingSaved; announce BookingPriced; } } }' },
  { path: 'behaviour/a.p', text: 'machine A { start state S { entry { announce BookingRequested; announce BookingSaved; } } }' },
];

test('handoverElements: every element by hierarchical id, code and risk only where declared', () => {
  const h = Core.handoverElements(dsl, behaviour);
  assert.equal(h.schema, 'designc.handover.elements/1');
  assert.deepEqual(h.elements, [
    { id: 'Traveller', name: 'Traveller', kind: 'person' },
    { id: 'Bookings', name: 'Bookings', kind: 'softwareSystem' },
    { id: 'Bookings/Bookings API', name: 'Bookings API', kind: 'container', code: ['src/Api/**', 'src/Shared'], risk: 'medium' },
    { id: 'Bookings/Bookings API/Fares', name: 'Fares', kind: 'component', code: ['src/Api/Fares/**'], risk: 'high' },
    { id: 'Bookings/Bookings DB', name: 'Bookings DB', kind: 'container' },
  ]);
});

test('handoverElements: relationships by id, one per pair', () => {
  assert.deepEqual(Core.handoverElements(dsl, behaviour).relationships, [
    { from: 'Traveller', to: 'Bookings/Bookings API' },
    { from: 'Bookings/Bookings API', to: 'Bookings/Bookings DB' },
  ]);
});

test('handoverElements: events are the names announced in behaviour, by file path, each once', () => {
  assert.deepEqual(Core.handoverElements(dsl, behaviour).events, ['BookingRequested', 'BookingSaved', 'BookingPriced']);
  assert.deepEqual(Core.handoverElements(dsl, []).events, []);
});

test('handoverElements: a model that does not parse, or a code area that is not a path pattern, is refused', () => {
  assert.throws(() => Core.handoverElements('workspace { model { x = container } }', []), /handover/);
  assert.throws(() => Core.handoverElements(dsl.replace('src/Api/Fares/**', '/abs/**'), []), /Fares.*absolute path/);
});

test('docs/handover-elements.example.json is what handoverElements writes for this model, and names the schema', () => {
  const read = f => JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', f), 'utf8'));
  assert.deepEqual(read('handover-elements.example.json'), Core.handoverElements(dsl, behaviour));
  assert.equal(read('handover-elements.schema.json').properties.schema.const, Core.handoverElements(dsl, behaviour).schema);
});
