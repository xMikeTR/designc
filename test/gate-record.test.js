const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Core = require('../renderer/core.js');
const Ledger = require('../renderer/ledger.js');

const text = fs.readFileSync(path.join(__dirname, '..', 'sample-registry', 'model', 'workspace.dsl'), 'utf8');
function record(src, opts = {}) {
  const model = Core.parse(src);
  const diags = opts.diags || Core.check(model, { chainHops: 4 });
  const gate = Core.gate({ model, diags, decisions: [], requirements: [], ledger: [] });
  return Core.gateRecord({ modelText: src, diags, gate, source: 'local', git: opts.git || null });
}

test('modelRevision is the revision a handover records for the same model', () => {
  const plan = Core.handoverPlan({ date: '2026-10-03', now: 'x', by: 'u', model: { path: 'model/workspace.dsl', text } });
  assert.match(Core.modelRevision(text), /^r-[0-9a-f]{8}$/);
  assert.equal(plan.files[0].text.match(/^revision: (r-\w+)$/m)[1], Core.modelRevision(text));
});

test('a gate record is a valid ledger event with compact findings and no lines or messages', () => {
  const ev = record(text);
  assert.deepEqual(Ledger.validate({ ...ev, by: 'u' }), []);
  assert.equal(ev.kind, 'gate');
  assert.equal(ev.revision, Core.modelRevision(text));
  assert.equal(ev.ready, false);
  assert.match(ev.verdict, /^[0-9a-f]{16}$/);
  assert.ok(!('commit' in ev) && !('dirty' in ev), 'no git fields without git state');
  const dc2 = ev.findings.find(f => f.code === 'DC002');
  assert.deepEqual(dc2, { code: 'DC002', sev: 'error', on: 'Quotes DB', loc: 'element', unknown: false, suppressed: false });
  assert.ok(ev.findings.some(f => f.suppressed === true), 'the suppressed DC005 is kept, flagged');
  assert.ok(ev.clauses.every(c => Object.keys(c).sort().join() === 'kind,text'));
  assert.ok(!/"line"|"msg"|"hint"|"related"/.test(JSON.stringify(ev)));
});

test('git state adds commit and dirty', () => {
  const ev = record(text, { git: { commit: 'c'.repeat(40), dirty: true } });
  assert.equal(ev.commit, 'c'.repeat(40));
  assert.equal(ev.dirty, true);
  assert.equal(record(text, { git: { commit: null, dirty: false } }).commit, null);
});

test('the verdict ignores formatting and diagnostic order, and follows what the gate says', () => {
  const a = record(text);
  const reformatted = '// a comment\n\n' + text.replace(/\n/g, '\n\n');
  const b = record(reformatted);
  assert.notEqual(b.revision, a.revision, 'the model text changed');
  assert.equal(b.verdict, a.verdict, 'the verdict did not');
  const model = Core.parse(text);
  const shuffled = Core.check(model, { chainHops: 4 }).reverse();
  assert.deepEqual(record(text, { diags: shuffled }), a, 'diagnostic order does not change the record');
  const fixed = record(text.replace('"d.concurrency" "none"', '"d.concurrency" "optimistic"'));
  assert.ok(text.includes('"d.concurrency" "none"'), 'fixture still declares the DC002 cause');
  assert.notEqual(fixed.verdict, a.verdict);
});

test('verdictHash is canonical: key order inside the input does not matter', () => {
  const v = { ready: false, clauses: [{ kind: 'k', text: 't' }], findings: [] };
  assert.equal(Core.verdictHash(v), Core.verdictHash({ findings: [], clauses: [{ text: 't', kind: 'k' }], ready: false }));
});

test('gateUnchanged compares with the last gate event from the same source only', () => {
  const g = (o) => ({ kind: 'gate', source: 'local', revision: 'r-1', commit: 'c1', verdict: 'v1', _ts: 1, ...o });
  const now = g({});
  assert.equal(Ledger.gateUnchanged([], now), false, 'nothing recorded yet');
  assert.equal(Ledger.gateUnchanged([g({ _ts: 1 })], now), true);
  assert.equal(Ledger.gateUnchanged([g({ _ts: 1 }), g({ _ts: 2, verdict: 'v0' })], now), false, 'the latest one counts');
  assert.equal(Ledger.gateUnchanged([g({ verdict: 'v0', _ts: 1 }), g({ _ts: 2 })], now), true);
  assert.equal(Ledger.gateUnchanged([g({ source: 'pipeline' })], now), false, 'another source does not count');
  assert.equal(Ledger.gateUnchanged([g({ _ts: 1 }), g({ source: 'pipeline', verdict: 'x', _ts: 2 })], now), true);
  assert.equal(Ledger.gateUnchanged([g({ commit: 'c0' })], now), false, 'a new commit always records');
  assert.equal(Ledger.gateUnchanged([g({ revision: 'r-0' })], now), false);
  const noGit = { ...now }; delete noGit.commit;
  assert.equal(Ledger.gateUnchanged([g({ commit: null })], noGit), true, 'absent and null commit are the same');
  assert.equal(Ledger.gateUnchanged([{ kind: 'check', source: 'local', _ts: 9 }, g({})], now), true);
});

test('dirtyInputs: only files the gate reads count, ledger changes never do', () => {
  const Core = require('../renderer/core.js');
  const f = (path, index = ' ', worktree = 'M') => ({ path, index, worktree });
  const cfg = { model: 'model/workspace.dsl' };
  assert.deepEqual(Core.dirtyInputs([f('ledger/checks.jsonl'), f('handovers/x/handover.yaml'), f('asbuilt/facts.json'), f('notes.md')], cfg), []);
  assert.deepEqual(Core.dirtyInputs([f('decisions/D-1.yaml'), f('ledger/a.jsonl')], cfg), ['decisions/D-1.yaml']);
  assert.deepEqual(Core.dirtyInputs([f('model/workspace.dsl', '?', '?'), f('requirements/R-1.yml', 'A', ' '), f('scenarios/s.yaml', 'R', ' '), f('designc.json')], cfg),
    ['model/workspace.dsl', 'requirements/R-1.yml', 'scenarios/s.yaml', 'designc.json']);
  assert.deepEqual(Core.dirtyInputs([f('design/other.dsl')], { model: 'design/other.dsl' }), ['design/other.dsl'], 'a configured model path counts');
  assert.deepEqual(Core.dirtyInputs([f('model/workspace.dsl')], {}), ['model/workspace.dsl'], 'default model path');
  assert.deepEqual(Core.dirtyInputs([f('decisions-notes.md')], cfg), [], 'a folder name is not a prefix match');
  assert.deepEqual(Core.GATE_INPUTS, ['decisions', 'requirements', 'scenarios', 'acceptance', 'design-tokens', 'evals', 'behaviour', 'vocabulary', 'domain', 'designc.json']);
});

test('evals: definitions are gate inputs, results files are not', () => {
  const Core = require('../renderer/core.js');
  assert.deepEqual(Core.dirtyInputs([{ path: 'evals/e1.yaml' }, { path: 'evals/results/e1.json' }, { path: 'evals/data.csv' }], {}), ['evals/e1.yaml']);
});

test('behaviour and vocabulary are gate inputs, because a handover copies them', () => {
  const Core = require('../renderer/core.js');
  assert.deepEqual(Core.dirtyInputs([{ path: 'behaviour/m.p' }, { path: 'vocabulary/v.yaml' }], {}), ['behaviour/m.p', 'vocabulary/v.yaml']);
});
