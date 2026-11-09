'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Core = require('../renderer/core.js');

// A chain as the extractor writes it: every call tagged sync, nothing else declared.
const BUILT = `workspace {
  model {
    s = softwareSystem "S" {
      a = container "A"
      b = container "B"
      c = container "C"
      d = container "D"
      a -> b "calls" { properties { "d.interaction" "sync" } }
      b -> c "calls" { properties { "d.interaction" "sync" } }
      c -> d "calls" { properties { "d.interaction" "sync" } }
    }
  }
}
`;
const dc003 = m => Core.check(m, { chainHops: 3 }).find(d => d.code === 'DC003');

test('a finding on exactly what the code map found is from extraction', () => {
  const design = Core.parse(BUILT), built = Core.parse(BUILT);
  const f = dc003(design);
  assert.ok(f, 'the chain raises DC003');
  assert.equal(Core.fromExtraction(f, design, built), true);
});

test('a property a person declared makes it theirs', () => {
  const built = Core.parse(BUILT);
  const withAvailability = Core.parse(BUILT.replace('c = container "C"', 'c = container "C" { properties { "d.availability" "99.9" } }'));
  assert.equal(Core.fromExtraction(dc003(withAvailability), withAvailability, built), false);
  const withTimeout = Core.parse(BUILT.replace('b -> c "calls" { properties { "d.interaction" "sync" } }', 'b -> c "calls" { properties { "d.interaction" "sync" "d.timeout" "2s" } }'));
  assert.equal(Core.fromExtraction(dc003(withTimeout), withTimeout, built), false);
});

test('code areas and aliases do not count as design choices', () => {
  const built = Core.parse(BUILT);
  const design = Core.parse(BUILT.replace('b = container "B"', 'b = container "B" { properties { "d.code" "b/**" "d.risk" "medium" "d.aka" "Bee" } }'));
  assert.equal(Core.fromExtraction(dc003(design), design, built), true);
});

test('no code map means no label', () => {
  const design = Core.parse(BUILT);
  assert.equal(Core.fromExtraction(dc003(design), design, null), false);
});

test('an element the code map did not find is the design\'s', () => {
  const design = Core.parse(BUILT), built = Core.parse(BUILT.replace(/\s+d = container "D"/, '').replace(/\s+c -> d[^\n]*/, ''));
  assert.equal(Core.fromExtraction(dc003(design), design, built), false);
});
