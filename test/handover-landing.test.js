// S5 H/B: an approved landing travels in the handover as a derived landing.json and as "Where it lands" in BUILD.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const Core = require('../renderer/core.js');
const Landing = require('../renderer/landing.js');

const root = path.join(__dirname, '..');
const readDoc = n => JSON.parse(fs.readFileSync(path.join(root, 'docs', n), 'utf8'));
const schema = readDoc('handover-landing.schema.json');
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);

const model = { path: 'model/workspace.dsl', text: `workspace "S" { model { s = softwareSystem "Shop" {
  api = container "Api" { properties { "d.code" "src/Api/**" } }
} } views { container s "C" { include * autoLayout } } }` };
const REC = (over = {}) => ({
  requirement: 'RE-1', author: 'agent', status: 'approved',
  entry: { kind: 'screen', node: 'Shop.Ui' },
  path: [{ stage: 'ui', node: 'Shop.Ui' }, { stage: 'api', node: 'Shop.Api/GET /customers' }, { stage: 'handler', node: 'Shop.Api/CustomersController' }],
  changes: [{ node: 'Shop.Api/CustomersController', what: 'accept the discount code filter' }],
  principle: { prop: 'd.api', element: 'Shop.Api' },
  proposed: { entry: { kind: 'screen', node: 'Shop.Ui' }, path: [], changes: [], principle: null }, correction: { principle: { prop: 'd.api', element: 'Shop.Api' } },
  approved: { by: 'mike-secret-name', at: '2026-11-23T10:00:00Z', hash: 'x', effects: { callers: 2, readers: 1, consumers: 0, unknown: 0 } }, ...over,
});
const item = (over = {}) => { const record = REC(over.record || {}); return { requirement: record.requirement, record, hash: Landing.contentHash(record), corrected: Landing.corrected(record), effects: record.approved.effects, ...over.item }; };
const plan = extra => Core.handoverPlan({ date: '2026-11-23', now: '2026-11-23T10:00:00Z', by: 'tester-name', model, ...extra });
const file = (p, name) => p.files.find(f => f.path.endsWith('/' + name));

test('without landings: empty equals absent, byte for byte, and no landing key, file or section', () => {
  const a = plan({}), b = plan({ landings: [] });
  assert.equal(a.id, b.id);
  assert.deepEqual(a.files, b.files);
  assert.equal(file(a, 'landing.json'), undefined);
  assert.doesNotMatch(file(a, 'handover.yaml').text, /^landing:/m);
  assert.doesNotMatch(file(a, 'BUILD.md').text, /Where it lands/);
});

test('with one landing: landing.json is derived, listed with its hash, keyed after tests: and before scenario_tests:, and the id differs', () => {
  const none = plan({}), p = plan({ landings: [item()] });
  assert.notEqual(p.id, none.id);
  const doc = JSON.parse(file(p, 'landing.json').text);
  assert.ok(validate(doc), JSON.stringify(validate.errors));
  assert.deepEqual(doc, readDoc('handover-landing.example.json'));
  const head = file(p, 'handover.yaml').text;
  assert.match(head, /^landing: "landing.json"$/m);
  assert.ok(head.includes(`path: "landing.json", hash: ${Core._shared.hash16(file(p, 'landing.json').text)}`));
  const keys = head.split('\n').map(l => /^([a-z_]+):/.exec(l)).filter(Boolean).map(m => m[1]);
  assert.ok(keys.indexOf('landing') > keys.indexOf('tests') || !keys.includes('tests'));
  assert.ok(keys.indexOf('landing') < keys.indexOf('requirements'));
  assert.equal(file(p, 'landing.json').text, JSON.stringify(doc, null, 2) + '\n');
});

test('landings sort by requirement and the effects are null when the note has none', () => {
  const p = plan({ landings: [item({ record: { requirement: 'RE-2', approved: { hash: 'x' } }, item: { effects: null } }), item()] });
  const doc = JSON.parse(file(p, 'landing.json').text);
  assert.deepEqual(doc.landings.map(l => l.requirement), ['RE-1', 'RE-2']);
  assert.equal(doc.landings[1].effects, null);
  assert.ok(validate(doc), JSON.stringify(validate.errors));
});

test('a different approved hash is a different handover; the same inputs on another day only change the date prefix', () => {
  const a = plan({ landings: [item()] });
  const other = item({ record: { changes: [{ node: 'Shop.Api/CustomersController', what: 'another thing' }] } });
  assert.notEqual(plan({ landings: [other] }).id, a.id);
  const later = Core.handoverPlan({ date: '2026-12-01', now: '2026-12-01T09:00:00Z', by: 'someone-else', model, landings: [item()] });
  assert.equal(later.id.slice(9), a.id.slice(9));
  assert.equal(file(later, 'landing.json').text, file(a, 'landing.json').text);
});

test('landing.json and BUILD.md carry no approver, no time and no review text', () => {
  const p = plan({ landings: [item()] });
  for (const t of [file(p, 'landing.json').text, file(p, 'BUILD.md').text]) {
    assert.doesNotMatch(t, /mike-secret-name|2026-11-23T10|tester-name/);
  }
  const l = JSON.parse(file(p, 'landing.json').text).landings[0];
  assert.deepEqual(Object.keys(l).sort(), ['author', 'changes', 'corrected', 'effects', 'entry', 'hash', 'path', 'principle', 'requirement']);
  assert.equal(l.corrected, true);
  assert.equal(file(p, 'landing.json').text.includes('approved'), false);
});

test('BUILD.md: Where it lands sits after the what-to-build content and before Rules, with entry, path, changes, principle, effects and the fixed paragraph', () => {
  const t = file(plan({ landings: [item()] }), 'BUILD.md').text;
  assert.ok(t.indexOf('## What to build') < t.indexOf('## Where it lands') && t.indexOf('## Where it lands') < t.indexOf('## Rules'));
  const sec = t.slice(t.indexOf('## Where it lands'), t.indexOf('## Rules'));
  assert.match(sec, /`RE-1`/);
  assert.match(sec, /Entry: screen `Shop\.Ui`/);
  assert.match(sec, /^- ui: Shop\.Ui$/m);
  assert.match(sec, /^- api: Shop\.Api\/GET \/customers$/m);
  assert.match(sec, /^- handler: Shop\.Api\/CustomersController$/m);
  assert.match(sec, /^- Shop\.Api\/CustomersController: accept the discount code filter$/m);
  assert.match(sec, /Principle: `d\.api` on `Shop\.Api`/);
  assert.match(sec, /Effects: 2 callers, 1 readers, 0 consumers, 0 unknown/);
  assert.match(sec, /code-map nodes/);
  assert.match(sec, /never widen/);
  assert.match(sec, /stop and ask the designer/);
  assert.match(sec, /`landing\.json` holds it/);
});

test('BUILD.md: a decision principle, and none with its why', () => {
  const d = file(plan({ landings: [item({ record: { principle: { decision: 'ADR-4' } } })] }), 'BUILD.md').text;
  assert.match(d, /Principle: decision `ADR-4`/);
  const n = file(plan({ landings: [item({ record: { principle: { none: 'plumbing' } } })] }), 'BUILD.md').text;
  assert.match(n, /Principle: none: plumbing/);
});

test('the schema rejects a stray field and a bad hash', () => {
  const bad = f => { const d = readDoc('handover-landing.example.json'); f(d); return validate(d); };
  assert.ok(!bad(d => { d.landings[0].approved = {}; }));
  assert.ok(!bad(d => { d.landings[0].hash = 'nothex'; }));
  assert.ok(!bad(d => { d.landings = []; }));
});
