// The fixture behind docs/handover-tests.example.json: a dotnet project-ref, a vitest import, a ui-page fail-to-pass, one unmapped element.
const Core = require('../../renderer/core.js');
const text = `workspace "S" { model { s = softwareSystem "Fares" {
  api = container "Fares API" { properties { "d.code" "src/Fares.Api/**" } }
  web = container "Fares Portal" { properties { "d.code" "src/Portal/**" } }
  eng = container "Surcharge Engine" { properties { "d.code" "src/Surcharge.Engine/**" } }
} } views { container s "C" { include * autoLayout } } }`;
const factsText = JSON.stringify({ extractedAt: '2026-11-17T09:00:00.000Z', tests: [
  { kind: 'dotnet', path: 'tests/Fares.Api.Tests/Fares.Api.Tests.csproj', project: 'Fares.Api.Tests', refs: ['src/Fares.Api/Fares.Api.csproj'] },
  { kind: 'vitest', path: 'tests/portal/format.test.ts', project: 'portal', imports: ['src/Portal/format.ts'] },
] }, null, 2) + '\n';
const specs = { files: [{ path: 'tests/acceptance/fares-fares-portal/AC-1.spec.ts' }, { path: 'tests/acceptance/fixture.ts' }] };
const doc = () => Core.handoverTests(Core.handoverElements(text), { text: factsText }, specs, [{ screen: 'bordereaux', component: 'Fares Portal' }]);
module.exports = { text, factsText, specs, doc };
