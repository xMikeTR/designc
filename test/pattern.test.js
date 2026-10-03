// Slice 18: d.agent.pattern and d.agent.patternWhy; AG011 asks for a reason when an agent uses a more complex pattern.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');
const V = require('../renderer/canvas/vocabulary.js');
const A = require('../renderer/canvas/agentic-rules.js');
Core.registerProperties(V.coreSpecs());
Core.registerRules(A.makeRules(Core));

const agent = (props, name = 'Triage agent') => `workspace { model { s = softwareSystem "S" {
  a = container "${name}" "" "MAF" "Agent" { properties { ${Object.entries(props).map(([k, v]) => `"${k}" "${v}"`).join(' ')} } }
} } }`;
const ag011 = props => Core.check(Core.parse(agent(props)), { chainHops: 4 }).filter(d => d.code === 'AG011' && !d.suppressed);

test('the pattern values validate: a bad value is DC000', () => {
  const ds = Core.check(Core.parse(agent({ 'd.agent.pattern': 'swarm' })), {}).filter(d => d.code === 'DC000');
  assert.equal(ds.length, 1);
  for (const p of ['single-call', 'prompt-chain', 'routing', 'parallel', 'orchestrator-workers', 'evaluator-optimizer', 'autonomous-loop'])
    assert.deepEqual(Core.check(Core.parse(agent({ 'd.agent.pattern': p })), {}).filter(d => d.code === 'DC000'), [], p);
});

test('the simple patterns need no reason', () => {
  for (const p of ['single-call', 'prompt-chain', 'routing', 'parallel']) assert.deepEqual(ag011({ 'd.agent.pattern': p }), [], p);
});

test('orchestrator-workers, evaluator-optimizer and autonomous-loop warn until a reason is written', () => {
  for (const p of ['orchestrator-workers', 'evaluator-optimizer', 'autonomous-loop']) {
    const ds = ag011({ 'd.agent.pattern': p });
    assert.equal(ds.length, 1, p);
    assert.equal(ds[0].sev, 'warning');
    assert.notEqual(ds[0].unknown, true);
    assert.match(ds[0].msg, new RegExp(`${p}.*d\\.agent\\.patternWhy`));
    assert.deepEqual(ag011({ 'd.agent.pattern': p, 'd.agent.patternWhy': 'Subtasks are not known in advance; a fixed chain failed on 3 of 10 sample tickets.' }), [], p);
  }
});

test('a blank reason does not count', () => {
  assert.equal(ag011({ 'd.agent.pattern': 'autonomous-loop', 'd.agent.patternWhy': '   ' }).length, 1);
});

test('an agent with autonomy but no pattern gets an unknown warning; no agent properties means no finding', () => {
  const ds = ag011({ 'd.agent.autonomy': 'suggest' });
  assert.equal(ds.length, 1);
  assert.equal(ds[0].unknown, true);
  assert.match(ds[0].msg, /d\.agent\.pattern/);
  assert.deepEqual(ag011({}), []);
});
