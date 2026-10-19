const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../renderer/contracts.js');

const doc = { agents: [{ id: 'S/A', name: 'A' }, { id: 'S/B', name: 'B' }, { id: 'S/C', name: 'C' }] };

test('settings: absent is null; a command is needed', () => {
  assert.equal(C.settings(undefined), null);
  assert.match(C.settings({}).error, /needs a command/);
  assert.deepEqual(C.settings({ command: 'x {agents}' }), { label: 'Compile contracts', command: 'x {agents}' });
});

test('command: fills agents, out and registry quoted; refuses unknown placeholders and newlines', () => {
  assert.equal(C.command('c {agents} {out}', { agents: "a b/it's.json", out: 'o' }), "c 'a b/it'\\''s.json' 'o'");
  assert.match(C.command('c {handover}', {}).error, /does not fill/);
  assert.match(C.command('a\nb', {}).error, /one line/);
});

test('readResult: one row per agent, a missing one says so, an invented id is a problem, a non-compiled row needs a reason', () => {
  const r = C.readResult(JSON.stringify({ schema: 'designc.contracts.result/1', agents: [
    { id: 'S/A', status: 'compiled', files: ['contracts/out/a.yaml'] },
    { id: 'S/B', status: 'needs_input', reasons: ['no goal type'] },
    { id: 'S/X', status: 'compiled' },
    { id: 'S/C', status: 'failed' }] }), doc);
  assert.deepEqual(r.agents.map(a => [a.id, a.status]), [['S/A', 'compiled'], ['S/B', 'needs_input'], ['S/C', 'missing']]);
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0], /S\/X/);
  assert.match(r.problems[1], /failed needs a reason/);
});

test('readResult: not JSON, or the wrong schema, is an error', () => {
  assert.match(C.readResult('nope', doc).error, /not JSON/);
  assert.match(C.readResult('{"schema":"x","agents":[]}', doc).error, /must be/);
});

const Core = require('../renderer/core.js');
const hash = Core._shared.hash16;
const adoc = { agents: [{ id: 'S/A', name: 'A', autonomy: 'approve-writes' }, { id: 'S/S', name: 'S', autonomy: 'suggest' }] };
const atext = JSON.stringify(adoc, null, 2) + '\n';
const res = (over = {}) => JSON.stringify({ schema: 'designc.contracts.result/2', agents_hash: hash(atext), compiler: { name: 'x', version: '1' },
  agents: [{ id: 'S/A', status: 'compiled', policy: 'contracts/out/a.yaml', files: ['contracts/out/a.yaml', 'contracts/out/a.json'] }, { id: 'S/S', status: 'needs_input', reasons: ['no goal'] }], ...over });
const files = { 'contracts/out/a.yaml': 'name: a\n', 'contracts/out/a.json': '{}\n' };
const run = (resultText, extra = {}) => C.forFreeze({ resultText, agentsDoc: adoc, agentsText: atext, hash, read: p => files[p] ?? null, ...extra });

test('forFreeze: copies compiled files, lets a suggest agent go uncontracted', () => {
  const r = run(res());
  assert.deepEqual(r.contracts.agents, { 'S/A': 'contracts/a.yaml' });
  assert.deepEqual(r.contracts.uncontracted, ['S/S']);
  assert.deepEqual(r.contracts.files.map(f => f.path), ['contracts/a.yaml', 'contracts/a.json']);
  assert.equal(r.contracts.result.path, 'contracts/result.json');
});

test('forFreeze: refuses a missing result, an old schema, a stale design, a non-suggest agent that needs input, a missing or escaping file', () => {
  assert.match(run(null).error, /Compile contracts first/);
  assert.match(run(res({ schema: 'designc.contracts.result/1' })).error, /older contracts command/);
  assert.match(run(res({ agents_hash: 'nope' })).error, /changed since/);
  assert.match(run(JSON.stringify({ schema: C.SCHEMA, agents_hash: hash(atext), agents: [{ id: 'S/A', status: 'needs_input', reasons: ['no goal'] }] })).error, /A is needs input: no goal/);
  assert.match(run(res(), { read: () => null }).error, /missing/);
  assert.match(run(res({ agents: [{ id: 'S/A', status: 'compiled', policy: 'contracts/out/../x.yaml' }] })).error, /not a compiled file/);
  assert.match(run(res({ agents: [{ id: 'S/A', status: 'compiled' }] })).error, /names no policy/);
});

test('forFreeze: no agents is a skip', () => {
  assert.deepEqual(C.forFreeze({ agentsDoc: { agents: [] } }), { skip: true });
});

test('gaps: every non-suggest agent without a compiled contract for this design is named', () => {
  const g = (resultText) => C.gaps({ resultText, agentsDoc: adoc, agentsText: atext, hash });
  assert.deepEqual(g(res()), []);
  assert.match(g(null)[0].text, /A has no compiled contract: not compiled yet/);
  assert.match(g(res({ agents_hash: 'x' }))[0].text, /design changed/);
  assert.match(g(res({ agents: [{ id: 'S/A', status: 'failed', reasons: ['x'] }] }))[0].text, /failed/);
  assert.deepEqual(C.gaps({ resultText: null, agentsDoc: { agents: [{ id: 'S/S', name: 'S', autonomy: 'suggest' }] }, agentsText: '', hash }), []);
});

test('the gate carries contract gaps as clauses about the agent', () => {
  const m = Core.parse('workspace {\n model {\n s = softwareSystem "S"\n }\n}\n');
  const gate = Core.gate({ model: m, diags: [], decisions: [], requirements: [], ledger: [], contractGaps: [{ name: 'A', text: 'A has no compiled contract: x' }] });
  assert.equal(gate.ready, false);
  assert.deepEqual(gate.clauses.find(c => c.kind === 'contracts').about, ['A']);
});
