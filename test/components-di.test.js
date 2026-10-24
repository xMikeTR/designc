const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extract } = require('../extract.js');
const { withRepo, FUNCTIONS_CSPROJ } = require('./helpers/with-repo');

const WEB = '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>';
const LIB = '<Project Sdk="Microsoft.NET.Sdk"></Project>';
const ref = p => `<ItemGroup><ProjectReference Include="../${p}/${p}.csproj" /></ItemGroup>`;
const withRefs = (csproj, ...ps) => csproj.replace('</Project>', ps.map(ref).join('') + '</Project>');
const edgesOf = (facts, owner) => facts.componentEdges.filter(e => e.via !== 'container-edge' && e.via !== 'queue-internal' && e.from.startsWith(`c_${owner}_`));
const pair = (facts, from, to) => facts.componentEdges.filter(e => e.from === from && e.to === to);

test('constructor, lambda and registration references become Uses edges', async () => {
  await withRepo({
    'Shop.Api/Shop.Api.csproj': withRefs(WEB, 'Shop.Infrastructure'),
    'Shop.Api/Program.cs': `var app = builder.Build();
builder.Services.AddScoped<IWarehouse, Warehouse>();
var api = app.MapGroup("/api");
api.MapOrderEndpoints();`,
    'Shop.Api/Controllers/CustomersController.cs': `public class CustomersController : ControllerBase
{
    public CustomersController(IWarehouse warehouse) { }
}`,
    'Shop.Api/Endpoints/OrderEndpoints.cs': `public static class OrderEndpoints
{
    public static void MapOrderEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/{id}", (IWarehouse warehouse, string id) => Results.Ok(id));
    }
}`,
    'Shop.Infrastructure/Shop.Infrastructure.csproj': LIB,
    'Shop.Infrastructure/IWarehouse.cs': 'public interface IWarehouse { }',
    'Shop.Infrastructure/Warehouse.cs': 'public class Warehouse : IWarehouse { }',
  }, async dir => {
    const { facts } = await extract(dir);
    const to = 'c_shopapi_shopinfrastructure';
    for (const from of ['c_shopapi_customerscontroller', 'c_shopapi_orderendpoints', 'c_shopapi_appshell']) {
      const [e, ...rest] = pair(facts, from, to);
      assert.ok(e, `${from} uses Shop.Infrastructure`);
      assert.equal(rest.length, 0);
      assert.deepEqual([e.kind, e.label, e.tech], ['sync', 'Uses', 'in-process']);
      assert.ok(e.evidence.length >= 1);
    }
    assert.equal(pair(facts, 'c_shopapi_appshell', 'c_shopapi_orderendpoints').length, 0, 'an extension-method call is not a type reference');
    assert.equal(facts.edges.some(e => e.tech === 'in-process'), false, 'facts.edges unchanged');
  });
});

const JOBS = {
  'Jobs.Functions/Jobs.Functions.csproj': withRefs(FUNCTIONS_CSPROJ, 'Jobs.Core'),
  'Jobs.Functions/Program.cs': `var host = new HostBuilder().ConfigureServices(s =>
{
    s.AddSingleton<IJobRunner, LocalRunner>();
    s.AddSingleton<IJobRunner, CloudRunner>();
    s.AddSingleton<IClock, SystemClock>();
}).Build();`,
  'Jobs.Functions/RunFunction.cs': `public class RunFunction
{
    private readonly IJobRunner runner;
    public RunFunction(IJobRunner runner, IClock clock) { this.runner = runner; }
    [Function("Run")]
    public void Run([TimerTrigger("0 * * * * *")] object t) { }
}`,
  'Jobs.Functions/Local/LocalRunner.cs': 'public class LocalRunner : IJobRunner { }',
  'Jobs.Functions/Cloud/CloudRunner.cs': 'public class CloudRunner : IJobRunner { }',
  'Jobs.Functions/Clock/SystemClock.cs': 'public class SystemClock : IClock { }',
  'Jobs.Core/Jobs.Core.csproj': LIB,
  'Jobs.Core/IJobRunner.cs': 'public interface IJobRunner { }',
  'Jobs.Core/IClock.cs': 'public interface IClock { }',
};
const RUN = 'c_jobsfunctions_runfunction';

test('several registrations give DI-candidate edges from the composition root and one unresolved entry per owner', async () => {
  await withRepo(JOBS, async dir => {
    const { facts } = await extract(dir);
    const ROOT = 'c_jobsfunctions_appshell';
    const one = (from, to) => { const es = pair(facts, from, to); assert.equal(es.length, 1, to); return es[0]; };
    assert.deepEqual([one(RUN, 'c_jobsfunctions_jobscore').label, one(RUN, 'c_jobsfunctions_jobscore').via], ['Uses', 'type']);
    assert.equal(pair(facts, RUN, 'c_jobsfunctions_local').length, 0, 'a consumer of the interface does not depend on its implementations');
    assert.equal(pair(facts, RUN, 'c_jobsfunctions_clock').length, 0);
    const local = one(ROOT, 'c_jobsfunctions_local'), cloud = one(ROOT, 'c_jobsfunctions_cloud');
    assert.deepEqual([local.label, local.via, cloud.label, cloud.via], ['Uses (DI candidate)', 'di-candidate', 'Uses (DI candidate)', 'di-candidate']);
    const clock = one(ROOT, 'c_jobsfunctions_clock');
    assert.deepEqual([clock.label, clock.via], ['Uses', 'di']);
    const un = facts.unresolved.filter(u => /several registrations/.test(u.what));
    assert.equal(un.length, 1);
    assert.match(un[0].what, /IJobRunner has 2 registrations \(LocalRunner, CloudRunner\)/);
    assert.equal(un[0].where, 'Jobs.Functions');
    assert.match(un[0].file, /Program\.cs$/);
  });
});

test('a call to a service-registration extension method is one edge to the project that declares it', async () => {
  await withRepo({
    'Shop.Api/Shop.Api.csproj': withRefs(WEB, 'Shop.Infrastructure'),
    'Shop.Api/Program.cs': 'builder.Services.AddInfrastructure(builder.Configuration);',
    'Shop.Infrastructure/Shop.Infrastructure.csproj': LIB,
    'Shop.Infrastructure/DependencyInjection.cs': `public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection services, object cfg) { return services; }
}`,
  }, async dir => {
    const { facts } = await extract(dir);
    const es = pair(facts, 'c_shopapi_appshell', 'c_shopapi_shopinfrastructure');
    assert.equal(es.length, 1);
    assert.equal(es[0].via, 'di');
  });
});

test('ambiguous or out-of-closure type names never make an edge', async () => {
  await withRepo({
    'App.Api/App.Api.csproj': withRefs(WEB, 'App.Core'),
    'App.Api/Program.cs': `// Hidden is only mentioned in a comment
var s = "Hidden Thing";
public class Startup
{
    public Startup(Dup dup, Outside outside, Hidden hidden) { }
}`,
    'App.Core/App.Core.csproj': LIB,
    'App.Core/A/Dup.cs': 'namespace A { public class Dup { } }',
    'App.Core/B/Dup.cs': 'namespace B { public class Dup { } }',
    'App.Core/Hidden.cs': '// class Hidden\npublic class Other { }',
    'Elsewhere/Elsewhere.csproj': LIB,
    'Elsewhere/Outside.cs': 'public class Outside { }',
  }, async dir => {
    const { facts } = await extract(dir);
    assert.deepEqual(facts.componentEdges.filter(e => e.label.startsWith('Uses')), []);
  });
});

test('a certain reference from a consumer is its own edge, apart from the root\'s DI candidate', async () => {
  await withRepo({
    ...JOBS,
    'Jobs.Functions/RunFunction.cs': `public class RunFunction
{
    public RunFunction(IJobRunner runner) { }
    [Function("Run")]
    public void Run([TimerTrigger("0 * * * * *")] object t) { var l = new LocalRunner(); }
}`,
  }, async dir => {
    const { facts } = await extract(dir);
    const es = pair(facts, RUN, 'c_jobsfunctions_local');
    assert.equal(es.length, 1);
    assert.equal(es[0].label, 'Uses');
    assert.ok(['type', 'di'].includes(es[0].via));
    assert.equal(pair(facts, 'c_jobsfunctions_appshell', 'c_jobsfunctions_local')[0].label, 'Uses (DI candidate)');
    assert.equal(pair(facts, 'c_jobsfunctions_appshell', 'c_jobsfunctions_cloud')[0].label, 'Uses (DI candidate)');
  });
});

test('a type in a project the file\'s own project cannot reach makes no edge and is reported', async () => {
  await withRepo({
    'Shop.Api/Shop.Api.csproj': withRefs(WEB, 'Shop.Application', 'Shop.Infrastructure'),
    'Shop.Application/Shop.Application.csproj': LIB,
    'Shop.Application/OrderService.cs': 'public class OrderService { public OrderService(SqlStore store) { } }',
    'Shop.Infrastructure/Shop.Infrastructure.csproj': withRefs(LIB, 'Shop.Application'),
    'Shop.Infrastructure/SqlStore.cs': 'public class SqlStore { }',
  }, async dir => {
    const { facts } = await extract(dir);
    assert.equal(facts.componentEdges.filter(e => e.from === 'c_shopapi_shopapplication' && e.to === 'c_shopapi_shopinfrastructure').length, 0);
    assert.ok(facts.unresolved.some(u => /Shop\.Application refers to a type in Shop\.Infrastructure, but has no ProjectReference path/.test(u.what)));
  });
});
