const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { extract } = require('../extract.js');
const { withRepo } = require('./helpers/with-repo');

const FULLSTACK = path.join(__dirname, '..', 'fixtures', 'fullstack');
const namesOf = (facts, owner) => facts.components.filter(c => c.owner === owner).map(c => c.name).sort();

test('controllers, endpoint classes, function classes and referenced libraries become components', async () => {
  const r = await extract(FULLSTACK);
  assert.deepEqual(namesOf(r.facts, 'Shop.Api'), ['App shell', 'CustomersController', 'OrderEndpoints', 'Shop.Infrastructure']);
  assert.deepEqual(namesOf(r.facts, 'Shop.Functions'), ['App shell', 'OrderFunctions', 'Shop.Infrastructure']);
  const ids = r.dsl.match(/c_\w+ = component "Shop\.Infrastructure"/g) || [];
  assert.equal(new Set(ids).size, 2, 'one Shop.Infrastructure component per owner, with different ids');
  assert.equal(r.facts.elements.some(e => e.name === 'Shop.Infrastructure'), false);
});

const { JOBS_REPO } = require('./helpers/with-repo');
const filesOf = (facts, owner, name) => facts.components.find(c => c.owner === owner && c.name === name).evidence.map(e => path.basename(e.file)).sort();

test('a queue sent and received inside one Functions app becomes an edge between the two function classes', async () => {
  await withRepo(JOBS_REPO, async dir => {
    const r = await extract(dir);
    assert.deepEqual(namesOf(r.facts, 'Jobs.Functions'), ['JobWatcherFunction', 'ReportJobFunction']);
    assert.deepEqual(filesOf(r.facts, 'Jobs.Functions', 'ReportJobFunction'), ['ReportJobFunction.cs', 'ReportJobOutput.cs']);
    assert.deepEqual(filesOf(r.facts, 'Jobs.Functions', 'JobWatcherFunction'), ['JobWatcherFunction.cs', 'JobWatcherOutput.cs']);
  });
});

test('output-binding types join their function class only when unambiguous', async () => {
  const { FUNCTIONS_CSPROJ } = require('./helpers/with-repo');
  await withRepo({
    'App.Functions/App.Functions.csproj': FUNCTIONS_CSPROJ,
    'App.Functions/Program.cs': 'var host = new HostBuilder().Build();',
    'App.Functions/Real/AlphaFunction.cs': `public class AlphaFunction
{
    [Function("Alpha")]
    public Task<AlphaOutput> Run([TimerTrigger("0 * * * * *")] object t) => null;
    [Function("Beta")]
    public Task<DupOutput> Beta([TimerTrigger("0 * * * * *")] object t) => null;
    [Function("Gamma")]
    public Task<MissingOutput> Gamma([TimerTrigger("0 * * * * *")] object t) => null;
}`,
    'App.Functions/Outputs/AlphaOutput.cs': 'public class AlphaOutput { }',
    'App.Functions/Outputs/DupOutput.cs': 'public class DupOutput { }',
    'App.Functions/Other/DupOutput.cs': 'namespace Other; public class DupOutput { }',
    'App.Functions/Ghost/GhostFunction.cs': `public class GhostFunction
{
    // [Function("Ghost")]
    /* [Function("Ghost2")] */
    public void Run() { }
}`,
  }, async dir => {
    const r = await extract(dir);
    const comps = new Map(r.facts.components.map(c => [c.name, c.evidence.map(e => e.file.split('/').slice(-2).join('/')).sort()]));
    assert.deepEqual(comps.get('AlphaFunction'), ['Outputs/AlphaOutput.cs', 'Real/AlphaFunction.cs']);
    assert.ok(comps.has('Outputs') && comps.has('Other'), 'ambiguous or unresolvable types fall back to the folder rule');
    assert.deepEqual(comps.get('Outputs'), ['Outputs/DupOutput.cs']);
    assert.ok(comps.has('Ghost') && !comps.has('GhostFunction'), 'a commented-out [Function] is not an anchor');
  });
});
