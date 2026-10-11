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
  assert.deepEqual(paths, [`handovers/${p.id}/behaviour/q.p`, `handovers/${p.id}/decisions/d1.yaml`, `handovers/${p.id}/elements.json`, `handovers/${p.id}/handover.yaml`, `handovers/${p.id}/model/workspace.dsl`, `handovers/${p.id}/requirements/HRE-1.yaml`]);
  const doc = yaml.load(p.files.find(f => f.path.endsWith('/handover.yaml')).text);
  assert.equal(doc.id, p.id);
  assert.match(doc.revision, /^r-[0-9a-f]{8}$/);
  assert.equal(doc.by, 'mike'); assert.equal(doc.created, '2026-10-02T09:30:00.000Z');
  assert.deepEqual(doc.requirements, ['HRE-1']); assert.deepEqual(doc.decisions, ['d1']);
  assert.equal(doc.files.length, 5);
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
