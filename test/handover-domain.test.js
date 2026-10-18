const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../renderer/core.js');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const model = { path: 'model/workspace.dsl', text: read('fixtures/domain-project/model/workspace.dsl') };
const behaviour = [{ path: 'behaviour/quotes.p', text: read('fixtures/domain-project/behaviour/quotes.p') }];
const pack = { key: 'pricing', text: read('fixtures/domain-registry/domain/pricing.yaml') };
const plan = (extra = {}) => Core.handoverPlan({ date: '2026-10-18', now: '2026-10-18T00:00:00Z', by: 't', model, behaviour, domain: [pack], ...extra });
const file = (p, name) => p.files.find(f => f.path.endsWith('/' + name));

test('domain.json matches the pinned example and the schema constants', () => {
  const p = plan(), doc = JSON.parse(file(p, 'domain.json').text);
  assert.deepEqual(doc, JSON.parse(read('docs/handover-domain.example.json')));
  assert.equal(JSON.parse(read('docs/handover-domain.schema.json')).$id, doc.schema);
});

test('the pack copy is verbatim, in the id hash, and listed in handover.yaml with domain.json', () => {
  const p = plan(), other = plan({ domain: [{ ...pack, text: pack.text + '\n# edited\n' }] });
  assert.equal(file(p, 'domain/pricing.yaml').text, pack.text);
  assert.notEqual(p.id, other.id);
  const y = file(p, 'handover.yaml').text;
  assert.match(y, /^domain: "domain.json"$/m);
  assert.match(y, /path: "domain\/pricing.yaml"/);
  assert.match(y, /path: "domain.json"/);
});

test('domain.json is outside the id hash; BUILD.md points at it', () => {
  assert.equal(plan().id, plan().id);
  assert.match(file(plan(), 'BUILD.md').text, /`domain.json` says which element owns which aggregate/);
});

test('with no packs, or no touched owner, nothing domain-shaped is written', () => {
  for (const p of [plan({ domain: [] }), plan({ item: { id: 'W-1', requirement: 'R', elements: ['Nobody'] } })]) {
    assert.equal(file(p, 'domain.json'), undefined);
    assert.doesNotMatch(file(p, 'handover.yaml').text, /^domain:/m);
    assert.doesNotMatch(file(p, 'BUILD.md').text, /domain\.json/);
  }
});

test('elements.json is unchanged by packs', () => {
  assert.equal(file(plan(), 'elements.json').text, file(plan({ domain: [] }), 'elements.json').text);
});
