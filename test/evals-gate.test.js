// The eval gate: an agent that acts with approval or alone needs a passing eval, run under the current eval file
// and the current agent fingerprint. An agent that only suggests gets a warning in the report, never a clause.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');
const V = require('../renderer/canvas/vocabulary.js');
Core.registerProperties(V.coreSpecs());

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 3, 12);

function dsl({ autonomy = 'approve-writes', evalId = 'task-evals', extra = '' } = {}) {
  const props = [autonomy && `"d.agent.autonomy" "${autonomy}"`, evalId && `"d.agent.eval" "${evalId}"`, extra].filter(Boolean).join(' ');
  return `workspace { model { s = softwareSystem "S" { a = container "Task agent" "" "MAF" "Agent" { properties { ${props} } } } } }`;
}
const parse = opts => Core.parse(dsl(opts));
const text = 'id: task-evals\nagent: Task agent\n';
const def = (o = {}) => ({ id: 'task-evals', agent: 'Task agent', command: 'node dev/mock-eval.js', results: 'evals/results/task-evals.json', thresholds: ['task_success >= 0.85'], _text: text, ...o });
function result(model, d, o = {}) {
  const a = [...model.elements.values()].find(e => e.name === 'Task agent');
  return { kind: 'eval', eval: d.id, agent: 'Task agent', outcome: 'pass', metrics: { task_success: 0.9 }, cases: 40, source: 'local', fingerprint: Core.fingerprint(model, a.id).hash, eval_hash: Core.evalHash(d), _ts: NOW - DAY, ...o };
}
const gate = (model, evals, ledger) => Core.gate({ model, diags: [], decisions: [], requirements: [], ledger, evals, now: NOW });
const evalClauses = g => g.clauses.filter(c => c.kind === 'eval').map(c => c.text);
const rowOf = (model, evals, ledger) => Core.evalReport({ model, evals, ledger, now: NOW }).find(r => r.agent === 'Task agent');

test('a passing result under the current eval file and agent clears the gate', () => {
  const m = parse(), d = def();
  const g = gate(m, [d], [result(m, d)]);
  assert.deepEqual(evalClauses(g), []);
  const row = rowOf(m, [d], [result(m, d)]);
  assert.equal(row.status, 'passing');
  assert.equal(row.blocking, false);
  assert.deepEqual(row.thresholds.map(t => [t.metric, t.actual, t.ok]), [['task_success', 0.9, true]]);
});

test('an agent that approves writes is blocked with no eval named, no file or no result', () => {
  const m0 = parse({ evalId: null });
  assert.deepEqual(evalClauses(gate(m0, [], [])), ['Task agent (approve-writes) needs a passing eval: d.agent.eval names no eval']);
  const m = parse();
  assert.deepEqual(evalClauses(gate(m, [], [])), ['Task agent (approve-writes) needs a passing eval: eval task-evals is not in evals/']);
  assert.deepEqual(evalClauses(gate(m, [def()], [])), ['Task agent (approve-writes) needs a passing eval: eval task-evals has no result recorded yet']);
  assert.equal(rowOf(m, [def()], []).status, 'unchecked');
});

test('an autonomous agent is held to the same standard', () => {
  const m = parse({ autonomy: 'autonomous' });
  assert.deepEqual(evalClauses(gate(m, [def()], [])), ['Task agent (autonomous) needs a passing eval: eval task-evals has no result recorded yet']);
});

test('an agent that only suggests never blocks, and an undeclared autonomy is not judged', () => {
  const m = parse({ autonomy: 'suggest' });
  assert.deepEqual(evalClauses(gate(m, [], [])), []);
  const row = rowOf(m, [], []);
  assert.equal(row.status, 'missing');
  assert.equal(row.blocking, false);
  assert.equal(rowOf(parse({ autonomy: null }), [], []), undefined);
});

test('a failing result blocks and carries the reason', () => {
  const m = parse(), d = def();
  const l = [result(m, d, { outcome: 'fail', reason: 'task_success 0.8 is not >= 0.85' })];
  assert.deepEqual(evalClauses(gate(m, [d], l)), ['Task agent (approve-writes) needs a passing eval: eval task-evals failed: task_success 0.8 is not >= 0.85']);
  assert.equal(rowOf(m, [d], l).status, 'failing');
});

test('only the latest result counts', () => {
  const m = parse(), d = def();
  const l = [result(m, d, { outcome: 'fail', reason: 'x', _ts: NOW - 2 * DAY }), result(m, d, { _ts: NOW - DAY })];
  assert.deepEqual(evalClauses(gate(m, [d], l)), []);
  const l2 = [result(m, d, { _ts: NOW - 2 * DAY }), result(m, d, { outcome: 'fail', reason: 'x', _ts: NOW - DAY })];
  assert.equal(evalClauses(gate(m, [d], l2)).length, 1);
});

test('a result run under another version of the eval file is stale', () => {
  const m = parse(), d = def();
  const l = [result(m, d, { eval_hash: '0000000000000000' })];
  assert.deepEqual(evalClauses(gate(m, [d], l)), ['Task agent (approve-writes) needs a passing eval: eval task-evals: the last result was run under a different version of the eval file']);
  assert.equal(rowOf(m, [d], l).status, 'stale');
});

test('a result run before the agent changed is stale', () => {
  const m = parse(), d = def();
  const l = [result(m, d)];
  const changed = Core.parse(dsl({ extra: '"d.agent.maxSteps" "9"' }));
  assert.deepEqual(evalClauses(gate(changed, [d], l)), ['Task agent (approve-writes) needs a passing eval: eval task-evals: the agent changed since the last result']);
});

test('a description change does not make a result stale (fingerprint ignores it)', () => {
  const m = parse(), d = def();
  const l = [result(m, d)];
  const redescribed = Core.parse(dsl().replace('"Task agent" "" "MAF"', '"Task agent" "now described" "MAF"'));
  assert.deepEqual(evalClauses(gate(redescribed, [d], l)), []);
});

test('maxAge makes an old result stale; without maxAge age does not matter', () => {
  const m = parse();
  const old = d => [result(m, d, { _ts: NOW - 10 * DAY })];
  assert.deepEqual(evalClauses(gate(m, [def()], old(def()))), []);
  const d7 = def({ maxAge: '7d' });
  assert.deepEqual(evalClauses(gate(m, [d7], old(d7))), ['Task agent (approve-writes) needs a passing eval: eval task-evals: the last result is older than 7d']);
  assert.deepEqual(evalClauses(gate(m, [d7], [result(m, d7, { _ts: NOW - 6 * DAY })])), []);
  const h = def({ maxAge: '12h' });
  assert.equal(evalClauses(gate(m, [h], [result(m, h, { _ts: NOW - 13 * 3600000 })])).length, 1);
});

test('a pipeline result counts like a local one', () => {
  const m = parse(), d = def();
  assert.deepEqual(evalClauses(gate(m, [d], [result(m, d, { source: 'pipeline' })])), []);
});

test('an eval that names another agent is reported against the agent that points at it', () => {
  const m = parse(), d = def({ agent: 'Other agent' });
  const texts = evalClauses(gate(m, [d], [result(m, d)]));
  assert.ok(texts.includes('eval task-evals: agent "Other agent" is not in the model'));
  assert.ok(texts.includes('Task agent (approve-writes) needs a passing eval: eval task-evals is for "Other agent", not Task agent'));
});

test('a malformed eval file blocks whatever the agent is, once', () => {
  const m = parse({ autonomy: 'suggest' });
  const bad = (o, expect) => assert.deepEqual(evalClauses(gate(m, [def(o)], [])), [`eval task-evals is invalid: ${expect}`]);
  bad({ command: undefined }, 'needs command');
  bad({ agent: undefined, results: undefined }, 'needs agent, results');
  bad({ thresholds: [] }, 'needs thresholds');
  bad({ thresholds: ['nonsense'] }, '"nonsense" is not "<metric> <op> <number>", e.g. task_success >= 0.85');
  bad({ maxAge: 'soon' }, 'maxAge "soon" is not like 30m, 12h or 7d');
  bad({ results: '/etc/passwd' }, 'results must be a path inside the registry');
  bad({ results: '../out.json' }, 'results must be a path inside the registry');
  const m2 = parse();
  assert.deepEqual(evalClauses(gate(m2, [def({ thresholds: [] })], [])), ['eval task-evals is invalid: needs thresholds']);
});

test('a repeated eval id is a duplicate', () => {
  const m = parse(), d = def();
  const g = gate(m, [d, d], [result(m, d)]);
  assert.ok(g.clauses.some(c => c.kind === 'duplicate' && c.text === 'duplicate id task-evals'));
});

test('an approve-writes agent blocks even when the caller passes no evals at all', () => {
  const g = Core.gate({ model: parse(), diags: [], decisions: [], requirements: [], ledger: [] });
  assert.deepEqual(g.clauses.filter(c => c.kind === 'eval').length, 1, 'an approve-writes agent with no evals still needs one');
});

test('a numeric eval id in YAML still matches the result recorded for it as a string', () => {
  const m = parse({ evalId: '12' }), d = def({ id: 12, _text: 'id: 12\nagent: Task agent\n' });
  const ev = result(m, d, { eval: '12' });
  assert.equal(rowOf(m, [d], [ev]).status, 'passing');
});
