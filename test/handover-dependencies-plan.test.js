const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv/dist/2020');
const Core = require('../renderer/core.js');

const text = fs.readFileSync(path.join(__dirname, '../fixtures/split-registry/model/workspace.dsl'), 'utf8');
const plan = t => Core.handoverPlan({ date: '2026-11-17', now: '2026-11-17T00:00:00Z', by: 't', model: { path: 'model/workspace.dsl', text: t } });
const file = (p, name) => p.files.find(f => f.path.endsWith('/' + name));
const validate = new Ajv({ strict: false, allErrors: true }).compile(JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/handover-dependencies.schema.json'), 'utf8')));

test('the split-registry handover carries a valid dependencies.json, listed in handover.yaml, and the id is unchanged', () => {
  const p = plan(text), doc = JSON.parse(file(p, 'dependencies.json').text);
  assert.equal(validate(doc), true);
  assert.deepEqual(doc.elements.map(e => [e.element, e.repo, e.allows]), [['Shop/Shop.Api', 'Api', []], ['Shop/ui', 'Ui', ['Shop/Shop.Api']]]);
  const y = file(p, 'handover.yaml').text;
  assert.match(y, /^elements: "elements.json"\ndependencies: "dependencies.json"$/m);
  assert.match(y, /path: "dependencies.json"/);
  assert.equal(p.id, '20261117-105ee4e2');
});

test('removing the rel empties the allow list', () => {
  const doc = JSON.parse(file(plan(text.replace('ui -> api "Calls"', '')), 'dependencies.json').text);
  assert.deepEqual(doc.elements.find(e => e.element === 'Shop/ui').allows, []);
});

test('a model with no code area writes no file and no key; BUILD.md has the rule only with the file', () => {
  const p = plan('workspace "S" { model { s = softwareSystem "Shop" { api = container "Api" } } views { container s "C" { include * autoLayout } } }');
  assert.equal(file(p, 'dependencies.json'), undefined);
  assert.doesNotMatch(file(p, 'handover.yaml').text, /^dependencies:/m);
  assert.doesNotMatch(file(p, 'BUILD.md').text, /dependencies\.json/);
  const b = file(plan(text), 'BUILD.md').text;
  assert.match(b, /^5\. `dependencies.json` lists, per element, the other elements its code may depend on/m);
  assert.match(b, /^4\. Honour every decision below/m);
});
