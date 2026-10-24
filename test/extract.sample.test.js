const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { extract } = require('../extract.js');
const Core = require('../renderer/core.js');

const SAMPLE = path.join(__dirname, '..', 'sample-codebase');

const BASELINE_STATS = { projects: 7, deployables: 5, tests: 1, elements: 8, edges: 9, unresolved: 0 };
const BASELINE_ELEMENTS = [
  { kind: 'container', name: 'CatModel.Adapter', tech: 'ASP.NET Core' },
  { kind: 'container', name: 'Pricing.Api', tech: 'ASP.NET Core' },
  { kind: 'container', name: 'Pricing.Portal', tech: 'ASP.NET Core' },
  { kind: 'container', name: 'Rating.Engine', tech: 'ASP.NET Core (F#)' },
  { kind: 'container', name: 'Referral.Worker', tech: '.NET Worker' },
  { kind: 'store', name: 'QuotesDb', tech: 'SQL Server' },
  { kind: 'store', name: 'LegacyRatesCache', tech: 'Redis' },
  { kind: 'external', name: 'api.catmodel-vendor.com', tech: 'External HTTP API' },
];
const BASELINE_EDGES = [
  { from: 'Pricing.Api', to: 'QuotesDb', kind: 'data', label: 'Reads and writes', tech: 'EF Core' },
  { from: 'Referral.Worker', to: 'QuotesDb', kind: 'data', label: 'Reads and writes', tech: 'EF Core' },
  { from: 'Rating.Engine', to: 'LegacyRatesCache', kind: 'data', label: 'Uses', tech: 'Redis' },
  { from: 'CatModel.Adapter', to: 'api.catmodel-vendor.com', kind: 'sync', label: 'Calls via Vendor', tech: 'HTTPS' },
  { from: 'Pricing.Api', to: 'Rating.Engine', kind: 'sync', label: 'Calls via RatingClient', tech: 'HTTP' },
  { from: 'Pricing.Portal', to: 'Pricing.Api', kind: 'sync', label: 'Calls via PricingApi', tech: 'HTTP' },
  { from: 'Rating.Engine', to: 'CatModel.Adapter', kind: 'sync', label: 'Calls via CatModel', tech: 'HTTP' },
  { from: 'Referral.Worker', to: 'Rating.Engine', kind: 'sync', label: 'Calls via RatingClient', tech: 'HTTP' },
  { from: 'Pricing.Api', to: 'Referral.Worker', kind: 'async', label: 'Sends via "referrals"', tech: 'Azure Service Bus' },
];

test('sample-codebase extraction is unchanged by the scanner refactor', async () => {
  const r = await extract(SAMPLE);
  assert.equal('error' in r, false, r.error);
  assert.deepEqual(r.stats, BASELINE_STATS);
  assert.equal(r.facts.unresolved.length, 0);

  for (const want of BASELINE_ELEMENTS) {
    const got = r.facts.elements.find(e => e.name === want.name);
    assert.ok(got, `missing element ${want.name}`);
    assert.equal(got.kind, want.kind, `${want.name} kind`);
    assert.equal(got.tech, want.tech, `${want.name} tech`);
  }
  assert.equal(r.facts.elements.length, BASELINE_ELEMENTS.length);

  for (const want of BASELINE_EDGES) {
    const got = r.facts.edges.find(e => e.from === want.from && e.to === want.to && e.kind === want.kind);
    assert.ok(got, `missing edge ${want.from} -> ${want.to}`);
    assert.equal(got.label, want.label, `${want.from}->${want.to} label`);
    assert.equal(got.tech, want.tech, `${want.from}->${want.to} tech`);
  }
  assert.equal(r.facts.edges.length, BASELINE_EDGES.length);
});

test('sample-codebase DSL parses cleanly in the design compiler', async () => {
  const r = await extract(SAMPLE);
  const dsl = r.dsl.replace(/^\/\/.*\n/, '');
  const parsed = Core.atLevel(Core.parse(dsl), 'container');
  assert.deepEqual(parsed.errors, []);
  const containerNames = [...parsed.elements.values()].map(e => e.name);
  for (const want of BASELINE_ELEMENTS) assert.ok(containerNames.includes(want.name), `DSL missing ${want.name}`);
  assert.equal(parsed.rels.length, BASELINE_EDGES.length);
});

test('empty folder reports no projects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-empty-'));
  const r = await extract(dir);
  assert.deepEqual(r, { error: 'No .NET projects (.csproj, .fsproj) or package.json files found in this folder.' });
});

// Seen on PokemonTournament: "codebase" pointed at the F# engine library alone gave an empty map and no reason.
test('a folder with projects but nothing that runs says why and what to change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-lib-'));
  fs.mkdirSync(path.join(dir, 'Engine'));
  fs.writeFileSync(path.join(dir, 'Engine', 'Engine.fsproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Library</OutputType></PropertyGroup></Project>');
  fs.writeFileSync(path.join(dir, 'Engine', 'Lib.fs'), 'module Lib\nlet x = 1\n');
  const r = await extract(dir);
  assert.deepEqual(r, { error: 'Found 1 project but nothing that runs: Engine (library). The code map draws what runs and shows libraries inside the app that references them, so set "codebase" in designc.json to a folder that also holds that app, often the repository root.' });
});

test('a test project that mentions a catalogue trigger adds no edge and does not crash extraction', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-testproj-'));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  w('Web/Web.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>');
  w('Web/Program.cs', 'builder.Services.AddAuthentication().AddJwtBearer();');
  w('Web.Tests/Web.Tests.csproj', '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="xunit" Version="2.0.0" /></ItemGroup></Project>');
  w('Web.Tests/AuthTests.cs', '// checks that AddJwtBearer is wired\nclass AuthTests {}');
  const r = await extract(dir);
  assert.equal('error' in r, false, r.error);
  assert.equal(/Web\.Tests/.test(r.dsl), false);
  assert.ok(r.facts.edges.some(e => e.from === 'Web' && /Authenticates/.test(e.label)), 'real project keeps its Entra ID edge');
});

test('a queue with no counterpart in the repo is an edge to Azure Service Bus; Snowflake.Data alone gives a Snowflake edge', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-sb-'));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  w('Jobs/Jobs.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><PackageReference Include="Snowflake.Data" Version="4.0.0" /></ItemGroup></Project>');
  w('Jobs/Out.cs', 'public class Out { [ServiceBusOutput("outbound-q", Connection = "SB")] public string Send() => ""; [ServiceBusTrigger("inbound-q")] public void Recv() {} }');
  const r = await extract(dir);
  assert.equal('error' in r, false, r.error);
  const has = (from, to, label) => r.facts.edges.some(e => e.from === from && e.to === to && e.label === label);
  assert.ok(has('Jobs', 'AzureServiceBus', 'Sends to "outbound-q"') || r.facts.edges.some(e => /Sends to "outbound-q"/.test(e.label)));
  assert.ok(r.facts.edges.some(e => /Receives from "inbound-q"/.test(e.label)));
  assert.ok(r.facts.edges.some(e => e.kind === 'data' && /Snowflake/i.test(String(e.to))));
  assert.equal(r.facts.unresolved.some(u => /no consumer|no publisher/.test(u.what)), false);
});

test('generated files are not scanned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-gen-'));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  w('Web/Web.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>');
  w('ui/package.json', JSON.stringify({ name: 'ui', dependencies: { react: '18.0.0' }, devDependencies: { vite: '5.0.0' } }));
  w('ui/src/App.tsx', 'export const App = () => null;');
  w('ui/public/mockServiceWorker.js', "fetch('/api/should-not-appear');");
  const r = await extract(dir);
  assert.equal('error' in r, false, r.error);
  assert.equal(JSON.stringify(r.facts).includes('should-not-appear'), false);
});

test('type names that differ only in case are two types, and a reference to either links', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-case-'));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  w('Web/Web.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>');
  w('Web/A/EpPoint.cs', 'public class EpPoint { }');
  w('Web/B/EPPoint.cs', 'public class EPPoint { }');
  w('Web/C/User.cs', 'public class User { public EpPoint a; public void M() { var x = new EPPoint(); } }');
  const r = await extract(dir);
  const names = r.facts.code.types.map(t => t.name).sort();
  assert.deepEqual(names.filter(n => /pPoint/i.test(n)), ['EPPoint', 'EpPoint']);
  assert.equal(r.facts.code.typeEdges.length, 2);
  assert.equal(r.facts.unresolved.some(u => /declared 2 times/.test(u.what)), false);
});
