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
  assert.deepEqual(paths, [`handovers/${p.id}/behaviour/q.p`, `handovers/${p.id}/decisions/d1.yaml`, `handovers/${p.id}/handover.yaml`, `handovers/${p.id}/model/workspace.dsl`, `handovers/${p.id}/requirements/HRE-1.yaml`]);
  const doc = yaml.load(p.files.find(f => f.path.endsWith('/handover.yaml')).text);
  assert.equal(doc.id, p.id);
  assert.match(doc.revision, /^r-[0-9a-f]{8}$/);
  assert.equal(doc.by, 'mike'); assert.equal(doc.created, '2026-10-02T09:30:00.000Z');
  assert.deepEqual(doc.requirements, ['HRE-1']); assert.deepEqual(doc.decisions, ['d1']);
  assert.equal(doc.files.length, 4);
  assert.ok(doc.files.every(f => /^[0-9a-f]{16}$/.test(f.hash)));
  const copy = p.files.find(f => f.path.endsWith('model/workspace.dsl'));
  assert.equal(copy.text, 'workspace {}');
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

test('no agent role may write evals/', () => {
  for (const role of Object.keys(Policy.WRITE_PATHS)) {
    const v = Policy.writeVerdict(role, 'evals/EV-1.yaml', 'id: EV-1\n', t => require('js-yaml').load(t));
    assert.equal(v.ok, false, role);
  }
});
