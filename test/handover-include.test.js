// C6 slice 3: revision, dirty inputs and freeze for a model with !include.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Core = require('../renderer/core.js');
const Headless = require('../headless/index.js');

const ROOT = path.join(__dirname, '..');
const rd = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SINGLE = rd('sample-registry/model/workspace.dsl');
const FIX = 'fixtures/include-model/';
const NAMES = ['fares.dsl', 'fares/workers.dsl', 'relationships.dsl'];
const files = (over = {}) => ({ ...Object.fromEntries(NAMES.map(n => [`model/${n}`, rd(FIX + n)])), 'model/unused.dsl': 'x = person "X"\n', ...over });
const planOf = (text, f) => Core.handoverPlan({ date: '2026-11-17', now: '2026-11-17T00:00:00Z', by: 't', model: { path: 'model/workspace.dsl', text, ...(f ? { files: f } : {}) } });
const splitPlan = f => planOf(rd(FIX + 'workspace.dsl'), f || files());
const byName = (p, n) => p.files.find(x => x.path.endsWith('/' + n));

test('no includes: the handover id and revisions are what they were at 44a7fe2', () => {
  assert.equal(planOf(SINGLE).id, '20261117-0537e90c');
  assert.equal(Core.modelRevision(SINGLE), 'r-b16dc4f2');
  assert.equal(Core.modelRevision(rd('fixtures/split-registry/model/workspace.dsl')), 'r-b083c590');
  assert.equal(Core.modelRevision(SINGLE, []), Core.modelRevision(SINGLE));
  assert.equal(planOf(SINGLE, { 'model/unused.dsl': 'x' }).id, '20261117-0537e90c');
});

test('the split freeze copies exactly the included files at their paths, hashed, with model: the root', () => {
  const p = splitPlan();
  const mine = p.files.filter(f => /\/model\//.test(f.path)).map(f => f.path.replace(/^handovers\/[^/]+\//, '')).sort();
  assert.deepEqual(mine, ['model/fares.dsl', 'model/fares/workers.dsl', 'model/relationships.dsl', 'model/workspace.dsl']);
  const y = byName(p, 'handover.yaml').text;
  assert.match(y, /^model: "model\/workspace.dsl"$/m);
  for (const n of ['model/fares.dsl', 'model/fares/workers.dsl', 'model/relationships.dsl']) assert.match(y, new RegExp(`path: "${n.replace(/[./]/g, c => '\\' + c)}", hash: [0-9a-f]{16}`));
  assert.doesNotMatch(y, /unused\.dsl/);
});

test('elements, dependencies and agents are byte-equal to the single-file freeze; a rerun is identical', () => {
  const a = planOf(SINGLE), b = splitPlan();
  for (const n of ['elements.json', 'agents.json', 'dependencies.json']) assert.equal(byName(b, n) && byName(b, n).text, byName(a, n) && byName(a, n).text, n);
  assert.deepEqual(splitPlan().files.map(f => [f.path, f.text]), b.files.map(f => [f.path, f.text]));
});

test('the id and revision change with an included file only', () => {
  const base = splitPlan();
  const changed = splitPlan(files({ 'model/fares/workers.dsl': rd(FIX + 'fares/workers.dsl') + '\n// edited\n' }));
  assert.notEqual(changed.id, base.id);
  assert.notEqual(byName(changed, 'handover.yaml').text.match(/^revision: (.+)$/m)[1], byName(base, 'handover.yaml').text.match(/^revision: (.+)$/m)[1]);
  assert.equal(splitPlan(files({ 'model/unused.dsl': 'y = person "Y"\n' })).id, base.id);
  const m = Core.parse(rd(FIX + 'workspace.dsl'), { path: 'model/workspace.dsl', resolve: p => files()[p] ?? null });
  assert.notEqual(Core.modelRevision(rd(FIX + 'workspace.dsl'), m.sources.slice(1)), Core.modelRevision(rd(FIX + 'workspace.dsl')));
});

test('dirtyInputs flags a .dsl file in the model folder', () => {
  const d = Core.dirtyInputs([{ path: 'model/fares.dsl' }, { path: 'notes.md' }, { path: 'handovers/h/model/a.dsl' }], { model: 'model/workspace.dsl' });
  assert.deepEqual(d, ['model/fares.dsl']);
});

test('Headless.open reads a split freeze back, and the refusal names the included file', () => {
  const p = splitPlan();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-hv-'));
  for (const f of p.files) { fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true }); fs.writeFileSync(path.join(dir, f.path), f.text); }
  const o = Headless.open(dir, { handover: p.id });
  assert.ok(!o.error, o.error);
  assert.deepEqual(o.model.errors, []);
  assert.equal(o.model.elements.size, Core.parse(SINGLE).elements.size);
  assert.equal(o.revision, byName(p, 'handover.yaml').text.match(/^revision: (.+)$/m)[1]);
  assert.throws(() => splitPlan(files({ 'model/fares/workers.dsl': 'bogus "x"\n' })), /does not parse \(model\/fares\/workers\.dsl line 1: unknown keyword "bogus"\)/);
  assert.throws(() => planOf('bogus "x"\n'), /does not parse \(line 1: unknown keyword "bogus"\)/);
});
