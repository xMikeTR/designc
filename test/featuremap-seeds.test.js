'use strict';
// The seed features in the fixtures, the example in docs/, and the schema: all read the way the app reads them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const Ajv2020 = require('ajv/dist/2020');
const FM = require('../renderer/featuremap.js');
const Core = require('../renderer/core.js');
const { ROOT } = require('./helpers/featuremap.js');

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const dir = d => fs.existsSync(path.join(ROOT, d)) ? fs.readdirSync(path.join(ROOT, d)).filter(f => /\.ya?ml$/.test(f)).sort().map(f => path.join(d, f)) : [];
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(JSON.parse(read('docs', 'feature.schema.json')));
const asJson = rec => JSON.parse(JSON.stringify(rec));

// What the app's loader builds, from a fixture folder on disk.
function ctxFor(reg) {
  const specs = {};
  for (const f of fs.readdirSync(path.join(ROOT, reg, 'ui/specs')).filter(x => x.endsWith('.json'))) { const o = JSON.parse(read(reg, 'ui/specs', f)); specs[o.screen] = o; }
  const model = Core.parse(read(reg, 'model/workspace.dsl'));
  const names = new Set();
  for (const e of model.elements.values()) names.add(e.name);
  const elements = new Set([...names].filter(n => Core.resolveElement(model, n)));
  const ids = d => dir(`${reg}/${d}`).map(f => String(yaml.load(read(f)).id || path.basename(f).replace(/\.ya?ml$/, '')));
  return { specs, elements: model.errors.length ? null : elements, requirements: ids('requirements'), acceptance: ids('acceptance'), testScenarios: ids('test-scenarios') };
}

for (const reg of ['fixtures/scenario-registry', 'fixtures/ui-project']) {
  test(`seed features in ${reg} read, validate against the schema and give no problems`, () => {
    const files = dir(`${reg}/features`);
    assert.ok(files.length >= 1, 'there is a seed');
    const features = files.map(f => { const r = FM.parseFile(f, read(f), yaml.load); assert.deepEqual(r.errors, [], f); assert.ok(validate(asJson(r.record)), `${f}: ${JSON.stringify(validate.errors)}`); return { path: f, record: r.record }; });
    assert.deepEqual(FM.problems(features, ctxFor(reg)), []);
  });
}

test('the three seeds exist, with two entry points and a declared param between them', () => {
  const rec = f => yaml.load(read(f));
  const browse = rec('fixtures/scenario-registry/features/orders-browse.yaml'), tag = rec('fixtures/scenario-registry/features/orders-tag.yaml'), bord = rec('fixtures/ui-project/features/bordereaux-filter.yaml');
  assert.equal(browse.id, 'orders-browse'); assert.equal(tag.id, 'orders-tag'); assert.equal(bord.id, 'bordereaux-filter');
  assert.ok(tag.entry_points.length >= 2 && tag.preconditions.data.tag);
  assert.ok(tag.journeys[0].proves.effect.api.method === 'GET', 'orders-tag crosses the commits transition, so it has an effect');
});

test('docs/feature.example.yaml validates against docs/feature.schema.json and gives no problems', () => {
  const r = FM.parseFile('features/bordereaux-export.yaml', read('docs', 'feature.example.yaml'), yaml.load);
  assert.deepEqual(r.errors, []);
  assert.ok(validate(asJson(r.record)), JSON.stringify(validate.errors));
  // The example is Appendix A's, so it names things no fixture has: check it against an in-memory registry that does.
  const spec = JSON.parse(read('fixtures/ui-project/ui/specs/bordereaux.json'));
  const ctx = { specs: { bordereaux: spec }, elements: new Set(['Ui.BordereauxPage', 'Api.BordereauxExport']), requirements: ['RE-1234'], acceptance: ['AC-12', 'AC-13'], testScenarios: ['TS-7'] };
  assert.deepEqual(FM.problems([{ path: 'features/bordereaux-export.yaml', record: r.record }], ctx), []);
});

test('the schema is closed where the contract is closed, and rejects what the checks would', () => {
  const ok = asJson(yaml.load(read('docs', 'feature.example.yaml')));
  const bad = fn => { const c = asJson(ok); fn(c); return !validate(c); };
  assert.ok(bad(c => { c.extra = 1; }), 'unknown top-level key');
  assert.ok(bad(c => { delete c.journeys; }));
  assert.ok(bad(c => { c.journeys = []; }));
  assert.ok(bad(c => { c.id = 'Bad_Id'; }));
  assert.ok(bad(c => { c.journeys[0].proves = {}; }), 'proves needs ui');
  assert.ok(bad(c => { c.journeys[0].proves.effect.api.method = 'POST'; }));
  assert.ok(bad(c => { c.journeys[0].steps.push({ click: { role: 'button', name: 'x' }, press: 'a' }); }), 'one action per step');
  assert.ok(bad(c => { c.journeys[0].steps.push({ wait: { role: 'status' } }); }), 'wait needs name or text');
  assert.ok(bad(c => { c.journeys[0].steps.push({ wait: { role: 'status', name: 'a', text: 'b' } }); }), 'text is not name');
  assert.ok(bad(c => { c.entry_points[0].via = 'entry'; }), 'via is not the word entry');
  assert.ok(bad(c => { c.preconditions.data.cedant = 'x'; }));
});
