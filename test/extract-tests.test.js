const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { extract } = require('../extract.js');

const SAMPLE = path.join(__dirname, '..', 'sample-codebase');
const JS = path.join(__dirname, '..', 'fixtures', 'js-tests');

test('C# facts: projects carry refs, and each test project is a facts.tests entry', async () => {
  const r = await extract(SAMPLE);
  assert.equal('error' in r, false, r.error);
  assert.deepEqual(r.facts.tests, [{ kind: 'dotnet', path: 'tests/Fares.Api.Tests/Fares.Api.Tests.csproj', project: 'Fares.Api.Tests', refs: ['src/Fares.Api/Fares.Api.csproj'] }]);
  const t = r.facts.projects.find(p => p.name === 'Fares.Api.Tests');
  assert.deepEqual(t.refs, ['src/Fares.Api/Fares.Api.csproj']);
  assert.equal(r.stats.tests, 1);
});

test('JS facts: a co-located and an importing test file, runner from package.json, units still exclude tests', async () => {
  const r = await extract(JS);
  assert.equal('error' in r, false, r.error);
  assert.deepEqual(r.facts.tests, [
    { kind: 'vitest', path: 'src/y.test.ts', project: 'tests-app', imports: ['src/y.ts'] },
    { kind: 'vitest', path: 'tests/x.test.ts', project: 'tests-app', imports: ['src/x.ts'] },
  ]);
  assert.equal(r.stats.tests, 0);
});
