// Moving one box must not move the others: the first move pins every box where it is drawn.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');
const L = require('../renderer/canvas/layout.js');

const model = () => Core.parse(`workspace { model {
  u = person "User"
  s = softwareSystem "S" { a = container "Agent" \n b = container "Sandbox" }
  u -> a "Uses"
  a -> b "Writes"
} }`);
const byName = (m, pos) => Object.fromEntries([...pos].map(([id, p]) => [m.elements.get(id).name, p]));

test('pin saves the drawn position of every box that has none, keeping saved ones', () => {
  const m = model(), layout = { ...L.empty(), positions: { b: { x: 5, y: 6 } } };
  const pinned = L.pin(m, layout, L.resolve(m, layout));
  assert.deepEqual(pinned.b, { x: 5, y: 6 });
  assert.deepEqual(Object.keys(pinned).sort(), ['a', 'b', 'u']);
});

test('after pinning, dragging Sandbox below Agent leaves Agent where it was', () => {
  const m = model(), layout = L.empty();
  const before = byName(m, L.resolve(m, layout));
  layout.positions = L.pin(m, layout, L.resolve(m, layout));
  layout.positions.b = { x: before.Agent.x, y: before.Agent.y + 200 };
  const after = byName(m, L.resolve(m, layout));
  assert.deepEqual(after.Agent, before.Agent);
  assert.ok(after.Sandbox.y > after.Agent.y);
});
