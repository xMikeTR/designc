const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');
const yaml = require('js-yaml');
const Policy = require('../renderer/policy.js');

const inputs = (o = {}) => ({
  date: '2026-10-02', now: '2026-10-02T09:30:00.000Z', by: 'mike',
  model: { path: 'model/workspace.dsl', text: 'workspace {}' },
  requirements: [{ path: 'requirements/HRE-1.yaml', text: 'id: HRE-1\nversion: 3\n' }],
  decisions: [{ path: 'decisions/d1.yaml', text: 'id: d1\nstatus: bound\n' }],
  behaviour: [{ path: 'behaviour/q.p', text: 'machine M {}' }],
  vocabulary: [],
  ...o,
});

test('handoverPlan: id is yyyymmdd-hash8 and the same inputs give the same id', () => {
  const a = Core.handoverPlan(inputs()), b = Core.handoverPlan(inputs());
  assert.match(a.id, /^20261002-[0-9a-f]{8}$/);
  assert.equal(a.id, b.id);
  assert.notEqual(Core.handoverPlan(inputs({ model: { path: 'model/workspace.dsl', text: 'workspace { }' } })).id, a.id);
  assert.notEqual(Core.handoverPlan(inputs({ date: '2026-10-03' })).id.slice(9), '', 'date does not change the hash part');
  assert.equal(Core.handoverPlan(inputs({ date: '2026-10-03' })).id.slice(9), a.id.slice(9));
});

test('handoverPlan: files land under handovers/<id>/ with a handover.yaml that lists them with hashes', () => {
  const p = Core.handoverPlan(inputs());
  const paths = p.files.map(f => f.path).sort();
  assert.deepEqual(paths, [`handovers/${p.id}/BUILD.md`, `handovers/${p.id}/behaviour/q.p`, `handovers/${p.id}/decisions/d1.yaml`, `handovers/${p.id}/elements.json`, `handovers/${p.id}/handover.yaml`, `handovers/${p.id}/model/workspace.dsl`, `handovers/${p.id}/requirements/HRE-1.yaml`]);
  const doc = yaml.load(p.files.find(f => f.path.endsWith('/handover.yaml')).text);
  assert.equal(doc.id, p.id);
  assert.match(doc.revision, /^r-[0-9a-f]{8}$/);
  assert.equal(doc.by, 'mike'); assert.equal(doc.created, '2026-10-02T09:30:00.000Z');
  assert.deepEqual(doc.requirements, ['HRE-1']); assert.deepEqual(doc.decisions, ['d1']);
  assert.equal(doc.files.length, 6);
  assert.ok(doc.files.every(f => /^[0-9a-f]{16}$/.test(f.hash)));
  const copy = p.files.find(f => f.path.endsWith('model/workspace.dsl'));
  assert.equal(copy.text, 'workspace {}');
});

test('handoverPlan: elements.json is the resolved model, named in handover.yaml and hashed with the other files', () => {
  const model = { path: 'model/workspace.dsl', text: 'workspace { model { s = softwareSystem "S" { properties { d.code "src/**"\n d.risk low } } } }' };
  const behaviour = [{ path: 'behaviour/q.p', text: 'machine M { start state S { entry { announce Saved; } } }' }];
  const p = Core.handoverPlan(inputs({ model, behaviour }));
  const doc = yaml.load(p.files.find(f => f.path.endsWith('/handover.yaml')).text);
  assert.equal(doc.elements, 'elements.json');
  const file = p.files.find(f => f.path === `handovers/${p.id}/elements.json`);
  assert.deepEqual(JSON.parse(file.text), Core.handoverElements(model.text, behaviour));
  assert.ok(doc.files.some(f => f.path === 'elements.json' && /^[0-9a-f]{16}$/.test(f.hash)));
  assert.throws(() => Core.handoverPlan(inputs({ model: { path: 'model/workspace.dsl', text: 'workspace { model { x = container } }' } })), /handover refused/);
});

const briefModel = { path: 'model/workspace.dsl', text: `workspace { model {
  s = softwareSystem "Pricing" {
    db = container "Quotes DB" { properties {
      d.code "src/Data/**, db/migrations/**"
      d.risk high } }
    ui = container "Portal" { properties {
      d.code "web/**"
      d.risk low } }
    worker = container "Worker"
  } } }` };
const brief = p => p.files.find(f => f.path.endsWith('/BUILD.md'));

test('handoverPlan: BUILD.md tells any coding agent what to build, where it may write and what done means', () => {
  const p = Core.handoverPlan(inputs({ model: briefModel,
    scenarios: [{ path: 'scenarios/S-1.yaml', text: 'id: S-1\n' }],
    evals: [{ path: 'evals/E-1.yaml', text: 'id: E-1\n' }],
    specs: { files: [{ path: 'tests/acceptance/portal/AC-1.spec.ts', text: '// spec' }], loop: null } }));
  const doc = yaml.load(p.files.find(f => f.path.endsWith('/handover.yaml')).text);
  assert.equal(doc.build, 'BUILD.md');
  assert.ok(doc.files.some(f => f.path === 'BUILD.md' && /^[0-9a-f]{16}$/.test(f.hash)));
  const t = brief(p).text;
  assert.match(t, new RegExp(`^# Build brief: ${p.id}$`, 'm'));
  assert.match(t, /Pricing\/Quotes DB.*risk high/); assert.match(t, /`src\/Data\/\*\*`/); assert.match(t, /`db\/migrations\/\*\*`/);
  assert.match(t, /Pricing\/Portal.*risk low/);
  assert.match(t, /may write/, 'with no focus every code area is open, not a build target');
  assert.doesNotMatch(t, /Pricing\/Worker/, 'an element with no code area is not a build target');
  assert.match(t, /tests\/acceptance\/\*\*/);                 // reserved
  assert.match(t, /HRE-1/); assert.match(t, /`decisions\/d1\.yaml`/);
  assert.match(t, /`scenarios\/S-1\.yaml`/); assert.match(t, /`evals\/E-1\.yaml`/);
  assert.match(t, /`tests\/acceptance\/portal\/AC-1\.spec\.ts`/);
  assert.match(t, /main/);                                         // done is judged on main, not claimed
  assert.doesNotMatch(t, /System 2|factory-s2/i, 'the brief names no pipeline');
});

test('handoverPlan: BUILD.md is derived, so it is not in the id, and the same inputs give the same text', () => {
  const a = Core.handoverPlan(inputs({ model: briefModel })), b = Core.handoverPlan(inputs({ model: briefModel, now: '2026-10-02T10:00:00.000Z', by: 'someone' }));
  assert.equal(a.id, b.id);
  assert.equal(brief(a).text, brief(b).text, 'no time or person in the brief');
});

test('handoverPlan: with a focus, BUILD.md separates what to build from context it may touch', () => {
  const p = Core.handoverPlan(inputs({ model: briefModel, focus: ['Quotes DB', 'Worker', 'Nowhere'] }));
  const t = brief(p).text;
  const [build, rest] = t.split('### Context');
  assert.match(build, /### Build these/);
  assert.match(build, /Pricing\/Quotes DB.*risk high/);
  assert.match(build, /Pricing\/Worker.*no code area/, 'a focus element without d.code is named, not dropped');
  assert.doesNotMatch(build, /Pricing\/Portal/);
  assert.match(rest, /Pricing\/Portal/);
  assert.doesNotMatch(t, /Nowhere/, 'a name the model does not have is left out');
  assert.equal(Core.handoverPlan(inputs({ model: briefModel, focus: ['Quotes DB'] })).id, Core.handoverPlan(inputs({ model: briefModel })).id, 'focus is derived, not in the id');
});

test("handoverPlan: an item handover's BUILD.md builds only the in-scope elements and names the work item", () => {
  const p = Core.handoverPlan(inputs({ model: briefModel, item: { id: 'W-7', requirement: 'HRE-1', elements: ['Quotes DB'] } }));
  const t = brief(p).text;
  assert.match(t, /W-7/);
  assert.match(t, /Pricing\/Quotes DB/);
  assert.doesNotMatch(t, /Pricing\/Portal/);
});

test('handoverPlan: BUILD.md says so when no element declares a code area', () => {
  const t = brief(Core.handoverPlan(inputs())).text;
  assert.match(t, /No element declares a code area/);
});

test('handoverPlan: vocabulary is copied when present', () => {
  const p = Core.handoverPlan(inputs({ vocabulary: [{ path: 'vocabulary/terms.yaml', text: 'terms: []' }] }));
  assert.ok(p.files.some(f => f.path === `handovers/${p.id}/vocabulary/terms.yaml`));
});

test('policy: an agent may not write under handovers/', () => {
  for (const role of ['architect', 'grill', 'analyst', 'tutor'])
    assert.equal(Policy.writeVerdict(role, 'handovers/20261002-abcd1234/handover.yaml', 'id: x', yaml.load).ok, false, role);
});

test('handoverPlan: evals are copied and their hashes recorded by eval id', () => {
  const text = 'id: EV-1\nagent: A\n';
  const p = Core.handoverPlan(inputs({ evals: [{ path: 'evals/EV-1.yaml', text }] }));
  assert.ok(p.files.some(f => f.path === `handovers/${p.id}/evals/EV-1.yaml`));
  const doc = yaml.load(p.files.find(f => f.path.endsWith('/handover.yaml')).text);
  assert.deepEqual(doc.evals, { 'EV-1': Core.evalHash({ _text: text }) });
  assert.notEqual(Core.handoverPlan(inputs({ evals: [{ path: 'evals/EV-1.yaml', text: text + 'x: 1\n' }] })).id.slice(9), p.id.slice(9));
  assert.deepEqual(yaml.load(Core.handoverPlan(inputs()).files[0].text).evals, {});
});

test('handoverPlan: scenarios are copied and listed by id, so the build receives what done means', () => {
  const text = 'id: QAS-1\ntitle: Repo never written\nattribute: integrity\nfitness:\n  - "TODO policy test"\n';
  const p = Core.handoverPlan(inputs({ scenarios: [{ path: 'scenarios/QAS-1.yaml', text }] }));
  const copy = p.files.find(f => f.path === `handovers/${p.id}/scenarios/QAS-1.yaml`);
  assert.equal(copy && copy.text, text);
  const doc = yaml.load(p.files[0].text);
  assert.deepEqual(doc.scenarios, ['QAS-1']);
  assert.ok(doc.files.some(f => f.path === 'scenarios/QAS-1.yaml'));
  assert.notEqual(Core.handoverPlan(inputs({ scenarios: [{ path: 'scenarios/QAS-1.yaml', text: text + 'x: 1\n' }] })).id.slice(9), p.id.slice(9));
  assert.deepEqual(yaml.load(Core.handoverPlan(inputs()).files[0].text).scenarios, []);
});

test('no agent role may write evals/', () => {
  for (const role of Object.keys(Policy.WRITE_PATHS)) {
    const v = Policy.writeVerdict(role, 'evals/EV-1.yaml', 'id: EV-1\n', t => require('js-yaml').load(t));
    assert.equal(v.ok, false, role);
  }
});

test('frozenAs: a handover never changes once frozen, so the same id or unchanged content is already frozen', () => {
  const hs = [{ id: '20261001-aaaaaaaa' }, { id: '20261002-bbbbbbbb' }];
  // The same id: its folder exists and freezing again would rewrite it.
  assert.equal(Core.frozenAs('20261001-aaaaaaaa', hs), '20261001-aaaaaaaa');
  // Same content on a later day as the newest handover: nothing changed since it.
  assert.equal(Core.frozenAs('20261011-bbbbbbbb', hs), '20261002-bbbbbbbb');
  // Content back to an older handover after a newer one: a real new freeze.
  assert.equal(Core.frozenAs('20261011-aaaaaaaa', hs), null);
  assert.equal(Core.frozenAs('20261011-cccccccc', hs), null);
  assert.equal(Core.frozenAs('20261011-cccccccc', []), null);
});
