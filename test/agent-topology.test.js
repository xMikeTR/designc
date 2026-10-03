// Slice 21: Core.agentTopology extracts the agents, what they call and who approves, for the topology view.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');
const V = require('../renderer/canvas/vocabulary.js');
Core.registerProperties(V.coreSpecs());

const m = Core.parse(`workspace { model {
  u = person "Operator"
  sys = softwareSystem "Platform" {
    orch = container "Orchestrator" "" "MAF" "Agent" { properties { "d.agent.autonomy" "approve-writes" "d.agent.pattern" "orchestrator-workers" } }
    worker = container "Worker" "" "MAF" "Agent" { properties { "d.agent.autonomy" "suggest" } }
    tools = container "Tool server" "" "MCP" "Tool"
    pay = container "Payments API" "" "HTTP"
    db = container "Unrelated DB" "" "SQL"
    web = container "Web" "" "SPA"
  }
  u -> orch "Asks"
  orch -> worker "Delegates" { properties { "d.protocol" "a2a" } }
  worker -> tools "Reads" { properties { "d.tool.effect" "read" "d.approval" "none" } }
  worker -> pay "Pays" { properties { "d.tool.effect" "irreversible" "d.approval" "none" } }
  orch -> pay "Refunds" { properties { "d.tool.effect" "irreversible" "d.approval" "human" } }
  web -> db "Reads"
} }`);
const names = t => t.nodes.map(n => n.name).sort();

test('the topology holds the agents and what they touch, nothing else', () => {
  const t = Core.agentTopology(m);
  assert.deepEqual(names(t), ['Operator', 'Orchestrator', 'Payments API', 'Tool server', 'Worker']);
  assert.equal(t.edges.length, 5);
});

test('agent nodes carry pattern and autonomy; others carry neither', () => {
  const t = Core.agentTopology(m), by = n => t.nodes.find(x => x.name === n);
  assert.deepEqual([by('Orchestrator').agent, by('Orchestrator').pattern, by('Orchestrator').autonomy], [true, 'orchestrator-workers', 'approve-writes']);
  assert.deepEqual([by('Worker').agent, by('Worker').pattern, by('Worker').autonomy], [true, null, 'suggest']);
  assert.equal(by('Payments API').agent, false);
});

test('edges carry effect, approval and protocol; an irreversible call with no human approval is unguarded', () => {
  const t = Core.agentTopology(m), by = d => t.edges.find(e => e.description === d);
  assert.deepEqual([by('Delegates').protocol, by('Delegates').effect], ['a2a', null]);
  assert.deepEqual([by('Reads').effect, by('Reads').approval, by('Reads').unguarded], ['read', 'none', false]);
  assert.equal(by('Pays').unguarded, true);
  assert.equal(by('Refunds').unguarded, false);
});

test('a model with no agents has an empty topology', () => {
  const t = Core.agentTopology(Core.parse('workspace { model { a = softwareSystem "A" } }'));
  assert.deepEqual(t, { nodes: [], edges: [], agents: 0, unguarded: 0 });
});

test('counts: agents and unguarded edges', () => {
  const t = Core.agentTopology(m);
  assert.equal(t.agents, 2);
  assert.equal(t.unguarded, 1);
});

test('an element that declares d.agent.autonomy is an agent even without the Agent tag', () => {
  const t = Core.agentTopology(Core.parse('workspace { model { s = softwareSystem "S" { a = container "A" "" "" { properties { "d.agent.autonomy" "suggest" } } } } }'));
  assert.deepEqual([t.agents, t.nodes.map(n => n.name)], [1, ['A']]);
});
