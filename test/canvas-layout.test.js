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

// Opening a system or container (double-click) shows its children, plus whatever they connect to outside, faded.
const deep = () => Core.parse(`workspace { model {
  u = person "Dev"
  h = softwareSystem "Harness" {
    agent = container "Agent"
    policy = container "Policy engine"
    sandbox = container "Sandbox" {
      mcp = component "MCP server"
      godot = component "Headless Godot"
    }
  }
  claude = softwareSystem "Claude" { tags "External" }
  u -> agent "Asks"
  agent -> claude "Prompts"
  agent -> policy "Requests tool calls"
  policy -> mcp "Forwards"
  agent -> sandbox "Uses"
  mcp -> godot "Runs"
} }`);
const names = (m, xs) => [...xs].map(x => (typeof x === 'string' ? m.elements.get(x) : x).name).sort();

test('scoped with no scope is the whole model', () => {
  const m = deep(), v = L.scoped(m, null);
  assert.equal(v.scope, null);
  assert.equal(v.elements, m.elements);
  assert.equal(v.rels.length, m.rels.length);
  assert.ok(v.rels.every((r, i) => r.orig === m.rels[i]));
});

test('opening a container shows its components and the outside ends of their rels, faded', () => {
  const m = deep(), v = L.scoped(m, 'sandbox');
  assert.deepEqual(names(m, L.leavesOf(v)), ['Headless Godot', 'MCP server', 'Policy engine']);
  assert.deepEqual(names(m, v.outside), ['Policy engine']);
  assert.deepEqual(v.rels.map(r => r.description).sort(), ['Forwards', 'Runs']);
  assert.equal(L.boundaries(v, L.resolve(v, L.empty()))[0].el.name, 'Sandbox');
});

test('opening a system folds its containers and lifts component rels onto them', () => {
  const m = deep(), v = L.scoped(m, 'h');
  assert.deepEqual(names(m, L.leavesOf(v)), ['Agent', 'Claude', 'Dev', 'Policy engine', 'Sandbox']);
  assert.deepEqual(names(m, v.outside), ['Claude', 'Dev']);
  const fwd = v.rels.filter(r => r.src === 'policy' && r.dst === 'sandbox');
  assert.equal(fwd.length, 1);
  assert.equal(fwd[0].orig.dst, 'mcp');
  assert.equal(v.rels.filter(r => r.src === r.dst).length, 0, 'mcp -> godot folds into Sandbox and drops');
  assert.equal(v.rels.filter(r => r.src === 'agent' && r.dst === 'sandbox').length, 1, 'explicit and lifted rels to the same pair draw once');
});

test('an empty container opens as an empty view', () => {
  const m = Core.parse('workspace { model { s = softwareSystem "S" { c = container "Sandbox" } } }'), v = L.scoped(m, 'c');
  assert.equal(L.leavesOf(v).length, 0);
});

test('extra outside elements show faded even with no rel yet (a person dropped while a container is open)', () => {
  const m = deep(), v = L.scoped(m, 'sandbox', { show: ['u', 'mcp', 'gone'] });
  assert.deepEqual(names(m, v.outside), ['Dev', 'Policy engine']);
  assert.equal(v.elements.get('u').parent, null);
});
