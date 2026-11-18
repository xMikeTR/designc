const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../renderer/core.js');

const root = path.join(__dirname, '..');
const dsl = (api, ui) => `workspace "S" { model { s = softwareSystem "Shop" {
  api = container "Api" { properties { "d.code" "${api}" } }
  web = container "Web" { properties { "d.code" "${ui}" } }
  bare = container "Bare" { properties { "d.code" "src/Bare/**" } }
  none = container "None" }
} views { container s "C" { include * autoLayout } } }`;
const elementsDoc = (text = dsl('src/Api/**', 'web/src/**')) => Core.handoverElements(text);
const factsText = tests => JSON.stringify({ extractedAt: '2026-11-17T00:00:00Z', tests }) + '\n';
const T = [
  { kind: 'dotnet', path: 'tests/Api.Tests/Api.Tests.csproj', project: 'Api.Tests', refs: ['src/Api/Api.csproj'] },
  { kind: 'vitest', path: 'web/src/b.test.ts', project: 'web', imports: [] },
  { kind: 'vitest', path: 'web/tests/a.test.ts', project: 'web', imports: ['web/src/a.ts'] },
  { kind: 'jest', path: 'misc/c.test.js', imports: ['web/src/a.ts'] },
  { kind: 'node', path: 'web/src/n.test.js', imports: [] },
];
const rowOf = (d, name) => d.elements.find(e => e.element === 'Shop/' + name);

test('the three via rules, commands and sorting', () => {
  const d = Core.handoverTests(elementsDoc(), { text: factsText(T) }, { files: [] }, []);
  assert.equal(d.schema, 'designc.handover.tests/1');
  assert.deepEqual(rowOf(d, 'Api').pass_to_pass, [{ kind: 'dotnet', path: 'tests/Api.Tests/Api.Tests.csproj', command: 'dotnet test tests/Api.Tests/Api.Tests.csproj', via: 'project-ref' }]);
  assert.deepEqual(rowOf(d, 'Web').pass_to_pass, [
    { kind: 'jest', path: 'misc/c.test.js', command: 'npx jest misc/c.test.js', via: 'import' },
    { kind: 'vitest', path: 'web/src/b.test.ts', command: 'npx vitest run web/src/b.test.ts', via: 'co-located' },
    { kind: 'node', path: 'web/src/n.test.js', command: null, via: 'co-located' },
    { kind: 'vitest', path: 'web/tests/a.test.ts', command: 'npx vitest run web/tests/a.test.ts', via: 'import' },
  ].sort((a, b) => (a.path < b.path ? -1 : 1)));
});

test('only elements with code appear; one without a mapped test is unmapped with its reason', () => {
  const d = Core.handoverTests(elementsDoc(), { text: factsText(T) }, { files: [] }, []);
  assert.deepEqual(d.elements.map(e => e.element), ['Shop/Api', 'Shop/Web', 'Shop/Bare']);
  assert.deepEqual(d.unmapped, [{ element: 'Shop/Bare', reason: 'no existing test references its code' }]);
  assert.equal(d.facts.path, 'asbuilt/facts.json');
  assert.equal(d.facts.extracted_at, '2026-11-17T00:00:00Z');
  assert.match(d.facts.sha256, /^[0-9a-f]{64}$/);
});

test('no facts: facts is null and every coded element is unmapped with the Extract reason', () => {
  const d = Core.handoverTests(elementsDoc(), null, { files: [] }, []);
  assert.equal(d.facts, null);
  assert.deepEqual(d.unmapped.map(u => u.reason), Array(3).fill('no as-built facts: run Extract'));
});

test('no element with code gives no document', () => {
  assert.equal(Core.handoverTests({ elements: [{ id: 'S/X', name: 'X', kind: 'container' }] }, null, { files: [] }, []), null);
});

test('fail_to_pass: the element\'s generated acceptance specs and a page test for the screen it is the component of', () => {
  const specs = { files: [{ path: 'tests/acceptance/fixture.ts' }, { path: 'tests/acceptance/shop-web/AC-2.spec.ts' }, { path: 'tests/acceptance/shop-web/AC-1.spec.ts' }, { path: 'tests/acceptance/shop-api/AC-9.spec.ts' }] };
  const d = Core.handoverTests(elementsDoc(), { text: factsText([]) }, specs, [{ screen: 'bordereaux', component: 'Web' }]);
  assert.deepEqual(rowOf(d, 'Web').fail_to_pass, [
    { kind: 'acceptance', path: 'tests/acceptance/shop-web/AC-1.spec.ts', command: 'npx playwright test tests/acceptance/shop-web/AC-1.spec.ts' },
    { kind: 'acceptance', path: 'tests/acceptance/shop-web/AC-2.spec.ts', command: 'npx playwright test tests/acceptance/shop-web/AC-2.spec.ts' },
    { kind: 'ui-page', path: 'ui-contract/tests/bordereaux.page.test.tsx', command: 'npx vitest run --project ui-page ui-contract/tests/bordereaux.page.test.tsx' },
  ].sort((a, b) => (a.path < b.path ? -1 : 1)));
  assert.equal(rowOf(d, 'Api').fail_to_pass.length, 1);
  assert.equal(rowOf(d, 'Bare').fail_to_pass.length, 0);
});

test('split repos: a test maps only inside its own repo, after the repo prefix is stripped', () => {
  const text = fs.readFileSync(path.join(root, 'fixtures/split-registry/model/workspace.dsl'), 'utf8');
  const tests = [
    { kind: 'dotnet', repo: 'Api', path: 'Api/tests/Shop.Api.Tests/Shop.Api.Tests.csproj', refs: ['Api/src/Shop.Api/Shop.Api.csproj'] },
    { kind: 'vitest', repo: 'Ui', path: 'Ui/src/app.test.ts', imports: [] },
    { kind: 'vitest', repo: 'Api', path: 'Api/src/Shop.Api/x.test.ts', imports: [] },
  ];
  const d = Core.handoverTests(Core.handoverElements(text), { text: factsText(tests) }, { files: [] }, []);
  const api = d.elements.find(e => e.element.endsWith('Shop.Api')), ui = d.elements.find(e => e.element.endsWith('/ui'));
  assert.equal(api.repo, 'Api');
  assert.deepEqual(api.pass_to_pass.map(t => t.path), ['Api/src/Shop.Api/x.test.ts', 'Api/tests/Shop.Api.Tests/Shop.Api.Tests.csproj']);
  assert.deepEqual(ui.pass_to_pass.map(t => t.path), ['Ui/src/app.test.ts']);
  assert.deepEqual(d.unmapped, []);
});

test('an element outside a work item\'s scope is left out', () => {
  const doc = Core.handoverElements(dsl('src/Api/**', 'web/src/**'), [], ['Api']);
  const d = Core.handoverTests(doc, { text: factsText(T) }, { files: [] }, []);
  assert.deepEqual(d.elements.map(e => e.element), ['Shop/Api']);
});
