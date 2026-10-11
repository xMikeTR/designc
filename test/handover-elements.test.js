const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const dsl = `workspace "Quotes" {
  model {
    u = person "Underwriter"
    s = softwareSystem "Quotes" {
      api = container "Quotes API" "" "C#" {
        properties {
          d.code "./src/Api/**, src/Shared/"
          d.risk medium
        }
        calc = component "Pricing" {
          properties {
            d.code "src/Api/Pricing/**"
            d.risk high
          }
        }
      }
      db = container "Quotes DB"
    }
    u -> api "prices a quote"
    api -> db "reads"
    api -> db "writes"
  }
}`;

const behaviour = [
  { path: 'behaviour/b.p', text: 'machine B { start state S { entry { announce QuoteSaved; announce QuotePriced; } } }' },
  { path: 'behaviour/a.p', text: 'machine A { start state S { entry { announce QuoteRequested; announce QuoteSaved; } } }' },
];

test('handoverElements: every element by hierarchical id, code and risk only where declared', () => {
  const h = Core.handoverElements(dsl, behaviour);
  assert.equal(h.schema, 'designc.handover.elements/1');
  assert.deepEqual(h.elements, [
    { id: 'Underwriter', name: 'Underwriter', kind: 'person' },
    { id: 'Quotes', name: 'Quotes', kind: 'softwareSystem' },
    { id: 'Quotes/Quotes API', name: 'Quotes API', kind: 'container', code: ['src/Api/**', 'src/Shared'], risk: 'medium' },
    { id: 'Quotes/Quotes API/Pricing', name: 'Pricing', kind: 'component', code: ['src/Api/Pricing/**'], risk: 'high' },
    { id: 'Quotes/Quotes DB', name: 'Quotes DB', kind: 'container' },
  ]);
});

test('handoverElements: relationships by id, one per pair', () => {
  assert.deepEqual(Core.handoverElements(dsl, behaviour).relationships, [
    { from: 'Underwriter', to: 'Quotes/Quotes API' },
    { from: 'Quotes/Quotes API', to: 'Quotes/Quotes DB' },
  ]);
});

test('handoverElements: events are the names announced in behaviour, by file path, each once', () => {
  assert.deepEqual(Core.handoverElements(dsl, behaviour).events, ['QuoteRequested', 'QuoteSaved', 'QuotePriced']);
  assert.deepEqual(Core.handoverElements(dsl, []).events, []);
});

test('handoverElements: a model that does not parse, or a code area that is not a path pattern, is refused', () => {
  assert.throws(() => Core.handoverElements('workspace { model { x = container } }', []), /handover/);
  assert.throws(() => Core.handoverElements(dsl.replace('src/Api/Pricing/**', '/abs/**'), []), /Pricing.*absolute path/);
});

test('docs/handover-elements.example.json is what handoverElements writes for this model, and names the schema', () => {
  const read = f => JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', f), 'utf8'));
  assert.deepEqual(read('handover-elements.example.json'), Core.handoverElements(dsl, behaviour));
  assert.equal(read('handover-elements.schema.json').properties.schema.const, Core.handoverElements(dsl, behaviour).schema);
});
