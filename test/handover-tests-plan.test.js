const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const model = { path: 'model/workspace.dsl', text: `workspace "S" { model { s = softwareSystem "Shop" {
  api = container "Api" { properties { "d.code" "src/Api/**" } }
  bare = container "Bare" { properties { "d.code" "src/Bare/**" } }
} } views { container s "C" { include * autoLayout } } }` };
const facts = tests => ({ text: JSON.stringify({ extractedAt: '2026-11-17T00:00:00Z', tests }) + '\n' });
const mapped = [{ kind: 'dotnet', path: 'tests/Api.Tests/Api.Tests.csproj', refs: ['src/Api/Api.csproj'] }];
const plan = extra => Core.handoverPlan({ date: '2026-11-17', now: '2026-11-17T00:00:00Z', by: 't', model, ...extra });
const file = (p, name) => p.files.find(f => f.path.endsWith('/' + name));

test('tests.json is listed in handover.yaml and files:, with the unmapped element in BUILD.md', () => {
  const p = plan({ facts: facts(mapped) });
  assert.match(file(p, 'handover.yaml').text, /^tests: "tests.json"$/m);
  assert.match(file(p, 'handover.yaml').text, /path: "tests.json"/);
  const doc = JSON.parse(file(p, 'tests.json').text);
  assert.deepEqual(doc.unmapped, [{ element: 'Shop/Bare', reason: 'no existing test references its code' }]);
  assert.match(file(p, 'BUILD.md').text, /No existing test covers: Shop\/Bare; the tests you write are its only cover/);
  assert.deepEqual(p.testsUnmapped, doc.unmapped);
});

test('the id changes when the facts change, and not otherwise', () => {
  const a = plan({ facts: facts(mapped) }), b = plan({ facts: facts(mapped) }), c = plan({ facts: facts([]) }), none = plan({});
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, c.id);
  assert.notEqual(a.id, none.id);
});

test('without facts every coded element is unmapped, tests.json says facts null, and the id has no facts entry', () => {
  const p = plan({}), doc = JSON.parse(file(p, 'tests.json').text);
  assert.equal(doc.facts, null);
  assert.deepEqual(doc.unmapped.map(u => u.reason), ['no as-built facts: run Extract', 'no as-built facts: run Extract']);
  assert.equal(p.id, plan({ facts: null }).id);
});

test('a model with no code area writes no tests.json and no key', () => {
  const p = plan({ model: { path: model.path, text: 'workspace "S" { model { s = softwareSystem "Shop" { api = container "Api" } } views { container s "C" { include * autoLayout } } }' } });
  assert.equal(file(p, 'tests.json'), undefined);
  assert.doesNotMatch(file(p, 'handover.yaml').text, /^tests:/m);
});

test('tests.json is outside the id hash itself: same facts bytes, same id', () => {
  assert.equal(plan({ facts: facts(mapped) }).id, plan({ facts: facts(mapped) }).id);
});
