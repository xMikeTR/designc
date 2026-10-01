const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');
const V = require('../renderer/canvas/vocabulary.js');
const A = require('../renderer/canvas/agentic-rules.js');
const T = require('../renderer/canvas/templates.js');
const D = require('../renderer/canvas/dsl-edit.js');
Core.registerProperties(V.coreSpecs());
Core.registerRules(A.makeRules(Core));
const P = o => `{\n properties {\n${Object.entries(o).map(([k, v]) => `  "${k}" "${v}"`).join('\n')}\n }\n}`;
const lint = body => { const m = Core.parse(`workspace { model {\n${body}\n} }`); assert.deepEqual(m.errors, []); return Core.check(m).filter(d => !d.suppressed); };
const codes = (ds, sev) => ds.filter(d => !sev || d.sev === sev).map(d => d.code + (d.unknown ? '?' : '')).sort();

test('the new properties validate: no DC000 for valid values, DC000 for bad ones', () => {
  assert.deepEqual(codes(lint(`a = softwareSystem "A" ${P({ 'd.owner': 'Team', 'd.pii': 'yes', 'd.rto': '1h' })}`)), []);
  assert.ok(codes(lint(`a = softwareSystem "A" ${P({ 'd.pii': 'maybe' })}`)).includes('DC000'));
  assert.ok(codes(lint(`a = softwareSystem "A" ${P({ 'd.agent.autonomy': 'yolo' })}`)).includes('DC000'));
});

test('AG001 lethal trifecta: error with all three legs, unknown when legs are undeclared, clean with two', () => {
  const agent = legs => `s = softwareSystem "S" {\n a = container "A" "" "" "Agent" ${P({ 'd.agent.maxSteps': '5', 'd.agent.tracing': 'yes', 'd.agent.eval': 'x', ...legs })}\n}`;
  assert.ok(codes(lint(agent({ 'd.agent.untrustedInput': 'yes', 'd.agent.privateData': 'yes', 'd.agent.externalComms': 'yes' })), 'error').includes('AG001'));
  assert.ok(codes(lint(agent({ 'd.agent.untrustedInput': 'yes' }))).includes('AG001?'));
  assert.ok(!codes(lint(agent({ 'd.agent.untrustedInput': 'yes', 'd.agent.privateData': 'yes', 'd.agent.externalComms': 'no' }))).some(c => c.startsWith('AG001')));
});

test('AG001 infers private data and external comms from the graph', () => {
  const ds = lint(`x = softwareSystem "Mail" "" "External"\ns = softwareSystem "S" {\n a = container "A" "" "" "Agent" ${P({ 'd.agent.untrustedInput': 'yes', 'd.agent.maxSteps': '5', 'd.agent.tracing': 'yes' })}\n db = container "DB" "" "" "Database" ${P({ 'd.pii': 'yes' })}\n}\na -> db "reads" ${P({ 'd.tool.effect': 'read' })}\na -> x "sends" ${P({ 'd.tool.effect': 'write', 'd.approval': 'policy' })}`);
  assert.ok(codes(ds, 'error').includes('AG001'));
});

test('AG002 excessive agency', () => {
  const base = autonomy => `s = softwareSystem "S" {\n a = container "A" "" "" "Agent" ${P({ 'd.agent.autonomy': autonomy, 'd.agent.maxSteps': '5', 'd.agent.tracing': 'yes', 'd.agent.identity': 'service' })}\n t = container "Pay" "" "" "Tool"\n}\n`;
  assert.ok(codes(lint(base('approve-writes') + `a -> t "pays" ${P({ 'd.tool.effect': 'irreversible', 'd.approval': 'policy' })}`), 'error').includes('AG002'));
  assert.ok(!codes(lint(base('approve-writes') + `a -> t "pays" ${P({ 'd.tool.effect': 'irreversible', 'd.approval': 'human' })}`)).includes('AG002'));
  assert.ok(codes(lint(base('autonomous') + `a -> t "writes" ${P({ 'd.tool.effect': 'write' })}`), 'warning').includes('AG002'));
  assert.ok(codes(lint(base('autonomous') + `a -> t "calls"`)).includes('AG002?'));
});

test('AG003 caps: unknown when missing, error in an agent cycle', () => {
  assert.ok(codes(lint(`s = softwareSystem "S" {\n a = container "A" "" "" "Agent"\n}`)).includes('AG003?'));
  const ds = lint(`s = softwareSystem "S" {\n a = container "A" "" "" "Agent"\n b = container "B" "" "" "Agent"\n}\na -> b "asks" ${P({ 'd.authenticated': 'yes' })}\nb -> a "asks back" ${P({ 'd.authenticated': 'yes' })}`);
  assert.equal(ds.filter(d => d.code === 'AG003' && d.sev === 'error').length, 2);
});

test('AG004 to AG010', () => {
  const agent = (id, extra = {}) => `${id} = container "${id}" "" "" "Agent" ${P({ 'd.agent.maxSteps': '5', 'd.agent.tracing': 'yes', 'd.agent.eval': 'e', ...extra })}`;
  let ds = lint(`llm = softwareSystem "Model" "" "LLM,External"\ns = softwareSystem "S" {\n ${agent('a')}\n}\na -> llm "calls" ${P({ 'd.tool.effect': 'read' })}`);
  assert.ok(codes(ds).includes('AG004'));
  ds = lint(`s = softwareSystem "S" {\n ${agent('a', { 'd.agent.tracing': 'no' })}\n}`); assert.ok(codes(ds).includes('AG005'));
  ds = lint(`s = softwareSystem "S" {\n ${agent('a', { 'd.agent.codeExec': 'yes' })}\n}`); assert.ok(codes(ds, 'error').includes('AG006'));
  ds = lint(`s = softwareSystem "S" {\n ${agent('a', { 'd.agent.codeExec': 'yes', 'd.agent.sandbox': 'yes' })}\n}`); assert.ok(!codes(ds).includes('AG006'));
  ds = lint(`s = softwareSystem "S" {\n ${agent('a')}\n ${agent('b')}\n mem = container "Memory" "" "" "Vector Store"\n}\na -> mem "remembers" ${P({ 'd.tool.effect': 'write' })}\nb -> mem "recalls" ${P({ 'd.tool.effect': 'read' })}`);
  assert.ok(codes(ds).includes('AG007?'));
  ds = lint(`s = softwareSystem "S" {\n ${agent('a', { 'd.critical': 'yes', 'd.instances': '2' })}\n}`); assert.ok(codes(ds).includes('AG008'));
  ds = lint(`s = softwareSystem "S" {\n ${agent('a')}\n ${agent('b')}\n}\na -> b "delegates"`); assert.ok(codes(ds).includes('AG009?'));
  ds = lint(`s = softwareSystem "S" {\n ${agent('a', { 'd.agent.identity': 'shared' })}\n}`); assert.ok(codes(ds).includes('AG010'));
});

test('every template lints clean', () => {
  for (const t of T.TEMPLATES) {
    const m = Core.parse(D.insertSnippet(D.EMPTY, t, 'x').text);
    assert.deepEqual(m.errors, [], t.id);
    const live = Core.check(m).filter(d => !d.suppressed && d.sev !== 'note');
    assert.deepEqual(live.map(d => `${d.code} ${d.loc.label}: ${d.msg}`), [], t.id);
  }
});

test('core rules are unchanged by registration', () => {
  const fs = require('fs'), path = require('path');
  const m = Core.parse(fs.readFileSync(path.join(__dirname, 'pricing.dsl'), 'utf8'));
  const live = Core.check(m).filter(d => !d.suppressed);
  assert.deepEqual(live.filter(d => d.sev === 'error').map(d => d.code).sort(), ['DC002', 'DC004']);
  assert.deepEqual(live.filter(d => d.sev === 'warning').map(d => d.code).sort(), ['DC001', 'DC003', 'DC005', 'DC006']);
});
