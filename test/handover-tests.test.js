// D6 slice 4: the published contract, and the Done-when round trip on a temporary copy of the sample registry.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const Core = require('../renderer/core.js');
const { extract } = require('../extract.js');
const fx = require('./helpers/handover-tests.js');

const root = path.join(__dirname, '..');
const readDoc = n => JSON.parse(fs.readFileSync(path.join(root, 'docs', n), 'utf8'));
const schema = readDoc('handover-tests.schema.json');
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);

test('docs/handover-tests.schema.json: $id matches, the example validates and is what handoverTests writes', () => {
  const example = readDoc('handover-tests.example.json'), doc = fx.doc();
  assert.equal(schema.$id, doc.schema);
  assert.ok(validate(example), JSON.stringify(validate.errors));
  assert.deepEqual(doc, example);
  assert.ok(example.elements.some(e => e.pass_to_pass.some(t => t.via === 'project-ref')));
  assert.ok(example.elements.some(e => e.pass_to_pass.some(t => t.via === 'import')));
  assert.ok(example.elements.some(e => e.fail_to_pass.some(t => t.kind === 'ui-page')));
  assert.equal(example.unmapped.length, 1);
});

test('the schema rejects a stray field, a bad hash and an unknown reason', () => {
  const bad = (f) => { const d = JSON.parse(JSON.stringify(readDoc('handover-tests.example.json'))); f(d); return validate(d); };
  assert.ok(!bad(d => { d.elements[0].extra = 1; }));
  assert.ok(!bad(d => { d.facts.sha256 = 'nothex'; }));
  assert.ok(!bad(d => { d.unmapped[0].reason = 'because'; }));
  assert.ok(!bad(d => { d.elements[0].pass_to_pass[0].via = 'guess'; }));
});

test('Done when: a temporary copy of the sample registry with d.code and extracted facts freezes a valid tests.json; Fares API maps, Surcharge Engine is unmapped', async () => {
  const sampleReg = path.join(root, 'sample-registry');
  const before = fs.readFileSync(path.join(sampleReg, 'model', 'workspace.dsl'), 'utf8');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-d6-'));
  try {
    fs.cpSync(sampleReg, tmp, { recursive: true });
    const dslPath = path.join(tmp, 'model', 'workspace.dsl');
    let dsl = fs.readFileSync(dslPath, 'utf8');
    dsl = dsl.replace('api = container "Fares API" "" ".NET 8" {\n        properties {', 'api = container "Fares API" "" ".NET 8" {\n        properties {\n          "d.code" "src/Fares.Api/**"')
      .replace('surcharge = container "Surcharge Engine" "" "F#" {\n        properties {', 'surcharge = container "Surcharge Engine" "" "F#" {\n        properties {\n          "d.code" "src/Surcharge.Engine/**"');
    assert.match(dsl, /d\.code" "src\/Fares\.Api/);
    assert.match(dsl, /d\.code" "src\/Surcharge\.Engine/);
    fs.writeFileSync(dslPath, dsl);
    const r = await extract(path.join(root, 'sample-codebase'));
    assert.equal('error' in r, false, r.error);
    fs.mkdirSync(path.join(tmp, 'asbuilt'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'asbuilt', 'facts.json'), JSON.stringify(r.facts, null, 2) + '\n');

    const read = f => fs.readFileSync(path.join(tmp, f), 'utf8');
    const plan = Core.handoverPlan({ date: '2026-11-17', now: '2026-11-17T00:00:00Z', by: 't', model: { path: 'model/workspace.dsl', text: read('model/workspace.dsl') }, facts: { text: read('asbuilt/facts.json') } });
    for (const f of plan.files) { fs.mkdirSync(path.dirname(path.join(tmp, f.path)), { recursive: true }); fs.writeFileSync(path.join(tmp, f.path), f.text); }
    const doc = JSON.parse(read(`handovers/${plan.id}/tests.json`));
    assert.ok(validate(doc), JSON.stringify(validate.errors));
    const api = doc.elements.find(e => e.element.endsWith('/Fares API'));
    assert.deepEqual(api.pass_to_pass.map(t => [t.path, t.via, t.command]), [['tests/Fares.Api.Tests/Fares.Api.Tests.csproj', 'project-ref', 'dotnet test tests/Fares.Api.Tests/Fares.Api.Tests.csproj']]);
    assert.deepEqual(doc.unmapped, [{ element: doc.elements.find(e => e.element.endsWith('/Surcharge Engine')).element, reason: 'no existing test references its code' }]);
    assert.match(read(`handovers/${plan.id}/handover.yaml`), /^tests: "tests.json"$/m);
    assert.match(read(`handovers/${plan.id}/BUILD.md`), /No existing test covers: .*Surcharge Engine/);
    // The checked-in registry is untouched.
    assert.equal(fs.readFileSync(path.join(sampleReg, 'model', 'workspace.dsl'), 'utf8'), before);
    assert.ok(!fs.existsSync(path.join(sampleReg, 'asbuilt')));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
