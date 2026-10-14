const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const MODEL = `workspace "G" {
  model {
    user = person "Game dev"
    harness = softwareSystem "Godot agent harness" {
      agent = container "Agent" "Plans" "Claude Code" {
        tags "Agent"
        properties {
          "d.zone" "local"
        }
      }
      project = container "Godot project" "The game" "Godot 4"
      mcp = container "MCP server" "" "" "Tool" {
        tool = component "GetTools"
      }
    }
    agent -> mcp "Calls"
  }
}
`;

const props = (text, name) => [...Core.parse(text).elements.values()].find(e => e.name === name).props;

test('suggestCodeAreas: one folder per container under its system, medium risk', () => {
  const r = Core.suggestCodeAreas(MODEL);
  assert.deepEqual(r.areas, [
    { name: 'Agent', pattern: 'godot-agent-harness/agent/**', risk: 'medium' },
    { name: 'Godot project', pattern: 'godot-agent-harness/godot-project/**', risk: 'medium' },
    { name: 'MCP server', pattern: 'godot-agent-harness/mcp-server/**', risk: 'medium' },
  ]);
  assert.equal(props(r.text, 'Agent')['d.code'], 'godot-agent-harness/agent/**');
  assert.equal(props(r.text, 'Agent')['d.risk'], 'medium');
  assert.equal(props(r.text, 'Agent')['d.zone'], 'local', 'existing properties are kept');
  assert.equal(props(r.text, 'Godot project')['d.code'], 'godot-agent-harness/godot-project/**', 'a container with no block gets one');
  assert.equal(props(r.text, 'GetTools')['d.code'], undefined, 'components share their container\'s area');
  assert.equal(props(r.text, 'Game dev')['d.code'], undefined);
});

test('suggestCodeAreas: the result parses and raises no code-area finding', () => {
  const r = Core.suggestCodeAreas(MODEL), m = Core.parse(r.text);
  assert.deepEqual(m.errors, []);
  assert.deepEqual(Core.check(m).filter(d => ['DC000', 'DC009'].includes(d.code)), []);
});

test('suggestCodeAreas: every original line is kept, except a container line that gains a block', () => {
  const out = Core.suggestCodeAreas(MODEL).text.split('\n');
  let i = 0;
  for (const line of MODEL.split('\n')) {
    const want = line.includes('container "Godot project"') ? line + ' {' : line;
    while (i < out.length && out[i] !== want) i++;
    assert.ok(i < out.length, `kept: ${line}`);
  }
});

test('suggestCodeAreas: two containers with the same folder name get -2', () => {
  const r = Core.suggestCodeAreas('workspace {\n model {\n  s = softwareSystem "S" {\n   a = container "API"\n   b = container "Api"\n  }\n }\n}\n');
  assert.deepEqual(r.areas.map(a => a.pattern), ['s/api/**', 's/api-2/**']);
});

test('suggestCodeAreas: a layout it cannot edit cleanly is refused, never half written', () => {
  const r = Core.suggestCodeAreas('workspace { model { s = softwareSystem "S" { a = container "API" \n b = container "Api" } } }');
  assert.match(r.error, /by hand/);
  assert.equal(r.text, undefined);
});

test('suggestCodeAreas: only for a model where no element says where its code is', () => {
  const r = Core.suggestCodeAreas(MODEL.replace('"d.zone" "local"', '"d.zone" "local"\n          "d.code" "agent/**"\n          "d.risk" "low"'));
  assert.match(r.error, /already/);
});

test('suggestCodeAreas: refuses a model that does not parse or has no container', () => {
  assert.match(Core.suggestCodeAreas('workspace { model { s = softwareSystem "S" {').error, /parse/);
  assert.match(Core.suggestCodeAreas('workspace { model { s = softwareSystem "S" } }').error, /container/);
});
