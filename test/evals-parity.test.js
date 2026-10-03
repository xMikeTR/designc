// The Python gate (designc check) and the app's gate must agree on every eval state.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Core = require('../renderer/core.js');
const { nodeReport, pyReport, tmpRegistry } = require('./helpers/parity.js');

const skip = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';
const DAY = 86400000;

const agent = (id, name, autonomy, evalId, extra = '') =>
  `      ${id} = container "${name}" "" "MAF" "Agent" { properties { ${autonomy ? `"d.agent.autonomy" "${autonomy}"` : ''} ${evalId ? `"d.agent.eval" "${evalId}"` : ''} ${extra} } }`;
const DSL = `workspace { model { s = softwareSystem "S" {
${[
  agent('a1', 'Passing agent', 'approve-writes', 'e-pass'),
  agent('a2', 'Failing agent', 'autonomous', 'e-fail'),
  agent('a3', 'Other-version agent', 'approve-writes', 'e-hash'),
  agent('a4', 'Changed agent', 'approve-writes', 'e-fp'),
  agent('a5', 'Old agent', 'approve-writes', 'e-old'),
  agent('a6', 'Unrun agent', 'approve-writes', 'e-new'),
  agent('a7', 'Unnamed agent', 'autonomous', null),
  agent('a8', 'Suggesting agent', 'suggest', null),
  agent('a9', 'Mismatched agent', 'approve-writes', 'e-mismatch'),
  agent('b1', 'Missing-file agent', 'approve-writes', 'e-nofile'),
  agent('b2', 'Bad-file agent', 'approve-writes', 'e-bad'),
].join('\n')}
} } }
`;

const evalYaml = (id, agentName, extra = '') =>
  `id: ${id}\nagent: ${agentName}\ncommand: node dev/mock-eval.js\nresults: evals/results/${id}.json\nthresholds:\n  - task_success >= 0.85\n  - p95_latency_ms <= 1200\n${extra}`;

function build() {
  const files = { 'model/workspace.dsl': DSL };
  const defs = {
    'e-pass': ['Passing agent', ''], 'e-fail': ['Failing agent', ''], 'e-hash': ['Other-version agent', ''], 'e-fp': ['Changed agent', ''],
    'e-old': ['Old agent', 'maxAge: 1h\n'], 'e-new': ['Unrun agent', ''], 'e-mismatch': ['Somebody else', ''],
    'e-orphan': ['Not in the model', ''],
  };
  for (const [id, [who, extra]] of Object.entries(defs)) files[`evals/${id}.yaml`] = evalYaml(id, who, extra);
  files['evals/e-bad.yaml'] = evalYaml('e-bad', 'Bad-file agent').replace('task_success >= 0.85', 'task_success is great');
  files['evals/e-dup-a.yaml'] = evalYaml('e-dup', 'Passing agent');
  files['evals/e-dup-b.yaml'] = evalYaml('e-dup', 'Passing agent', '# second copy\n');
  const model = Core.parse(DSL);
  const fp = name => Core.fingerprint(model, [...model.elements.values()].find(e => e.name === name).id).hash;
  const hash = id => Core.evalHash({ _text: files[`evals/${id}.yaml`] });
  const ev = (id, name, o = {}) => JSON.stringify({
    kind: 'eval', by: 'ci', schema_version: 1, event_id: `ev-${id}-${o.ts || 0}`, eval: id, agent: name, outcome: 'pass', metrics: { task_success: 0.9, p95_latency_ms: 800 },
    cases: 40, source: 'local', fingerprint: fp(name), eval_hash: hash(id), ts: Date.now() - 60000, ...o,
  });
  files['ledger/checks.jsonl'] = [
    ev('e-pass', 'Passing agent'),
    ev('e-fail', 'Failing agent', { outcome: 'fail', reason: 'task_success 0.8 is not >= 0.85' }),
    ev('e-hash', 'Other-version agent', { eval_hash: '0000000000000000' }),
    ev('e-fp', 'Changed agent', { fingerprint: '1111111111111111' }),
    ev('e-old', 'Old agent', { ts: Date.now() - 3 * DAY }),
    ev('e-mismatch', 'Mismatched agent', { ts: Date.now() - 60000 }),
  ].join('\n') + '\n';
  return tmpRegistry(files);
}

test('the Python gate and the app gate agree on every eval state', { skip }, () => {
  const root = build();
  const js = nodeReport(root), py = pyReport(root);
  assert.deepEqual(py.gate, js.gate);
  const evalTexts = js.gate.clauses.filter(c => c.kind === 'eval' || c.text.startsWith('duplicate id e-')).map(c => c.text);
  assert.equal(evalTexts.length, 12, evalTexts.join('\n'));
  assert.ok(!evalTexts.some(t => t.startsWith('Passing agent') || t.startsWith('Suggesting agent')));
});

test('a passing registry with evals is ready in both', { skip }, () => {
  const model = 'workspace { model { s = softwareSystem "S" { a = container "A" "" "MAF" "Agent" { properties { "d.agent.autonomy" "approve-writes" "d.agent.eval" "e1" } } } } }';
  const text = evalYaml('e1', 'A');
  const m = Core.parse(model);
  const fp = Core.fingerprint(m, [...m.elements.values()].find(e => e.name === 'A').id).hash;
  const line = JSON.stringify({ kind: 'eval', by: 'ci', schema_version: 1, event_id: 'x1', eval: 'e1', agent: 'A', outcome: 'pass', metrics: { task_success: 0.9 }, cases: 3, source: 'pipeline', fingerprint: fp, eval_hash: Core.evalHash({ _text: text }), ts: Date.now() - 1000 }) + '\n';
  const root = tmpRegistry({ 'model/workspace.dsl': model, 'evals/e1.yaml': text, 'ledger/checks.jsonl': line });
  assert.deepEqual(pyReport(root).gate, nodeReport(root).gate);
  assert.deepEqual(nodeReport(root).gate.clauses.filter(c => c.kind === 'eval'), []);
});
