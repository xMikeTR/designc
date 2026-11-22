// S1b: facts.endpoints, one node per HTTP endpoint and its handler (extract/endpoints.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extract } = require('../extract.js');

const ROOT = path.join(__dirname, '..');
const FARES = path.join(ROOT, 'demo', 'fares-e2e', 'codebase');
const FULL = path.join(ROOT, 'fixtures', 'fullstack');

// A scratch repo from {relative path: text}; one web project per `csproj` file given.
function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-ep-'));
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return dir;
}
const WEB = '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>';
const find = (r, node) => r.facts.endpoints.find(e => e.node === node);
const rowsAt = (r, line) => r.facts.unresolved.filter(u => u.line === line);

test('fares demo: every endpoint has an inline handler with its span', async () => {
  const r = await extract(FARES);
  const nodes = r.facts.endpoints.map(e => e.node).sort();
  assert.deepEqual(nodes, ['Fares.Api/POST /bookings', 'Surcharge.Engine/POST /rate', 'WeatherFeed.Adapter/POST /modelled-loss'].sort());
  const post = find(r, 'Fares.Api/POST /bookings');
  assert.equal(post.id, 'p_faresapi_post_bookings');
  assert.equal(post.container, 'Fares.Api');
  assert.equal(post.component, 'c_faresapi_appshell');
  assert.equal(post.method, 'POST');
  assert.equal(post.route, '/bookings');
  assert.deepEqual(post.evidence, { file: 'src/Fares.Api/Program.cs', line: 13 });
  assert.deepEqual({ ...post.handler, uses: undefined }, { kind: 'inline', node: 'Fares.Api/POST /bookings#handler', file: 'src/Fares.Api/Program.cs', line: 13, endLine: 21, uses: undefined });
  const ids = new Set(r.facts.code.types.map(t => t.id));
  for (const u of post.handler.uses) assert.ok(ids.has(u), `${u} is a code type`);
  const names = post.handler.uses.map(u => r.facts.code.types.find(t => t.id === u).name).sort();
  assert.deepEqual(names, ['Booking', 'BookingsDbContext', 'EscalationPublisher']);
  const weather = find(r, 'WeatherFeed.Adapter/POST /modelled-loss');
  assert.deepEqual([weather.handler.kind, weather.handler.line, weather.handler.endLine], ['inline', 6, 6]);
  const fs12 = find(r, 'Surcharge.Engine/POST /rate');
  assert.deepEqual([fs12.handler.kind, fs12.handler.line, fs12.handler.endLine], ['inline', 12, 12]);
  assert.ok(r.facts.endpoints.every(e => e.handler));
});

test('fullstack: six endpoints from minimal API, controller, Functions and Express', async () => {
  const r = await extract(FULL);
  assert.equal(r.facts.endpoints.length, 6, r.facts.endpoints.map(e => e.node).join('\n'));
  assert.ok(r.facts.endpoints.every(e => e.method && e.handler), JSON.stringify(r.facts.endpoints.filter(e => !e.method || !e.handler)));
  const cust = find(r, 'Shop.Api/GET /api/v1/customers/{}');
  assert.equal(cust.handler.kind, 'named');
  assert.equal(cust.handler.node, 'Shop.Api/CustomersController');
  assert.equal(cust.evidence.file, 'api/src/Shop.Api/Controllers/CustomersController.cs');
  assert.ok(r.facts.endpoints.some(e => e.container === 'node-api' && e.method === 'POST' && e.route === '/api/v2/invoices' && e.handler.kind === 'inline'));
  const fn = r.facts.endpoints.find(e => e.container === 'Shop.Functions');
  assert.equal(fn.handler.kind, 'named');
});

test('existing extraction output is unchanged apart from endpoints and added unresolved rows', async () => {
  for (const [name, dir] of [['fullstack', FULL], ['fares', FARES]]) {
    const gold = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', `extract-golden-${name}.json`), 'utf8'));
    const r = await extract(dir);
    const { endpoints, unresolved, extractedAt, ...rest } = r.facts;
    const { unresolved: gu, extractedAt: ge, ...grest } = gold.facts;
    assert.deepEqual(rest, grest, `${name} facts`);
    assert.equal(r.dsl, gold.dsl, `${name} dsl`);
    assert.deepEqual(r.stats, gold.stats, `${name} stats`);
    // every old unresolved row is still there, in order
    let i = 0;
    for (const u of unresolved) if (i < gu.length && JSON.stringify(u) === JSON.stringify(gu[i])) i++;
    assert.equal(i, gu.length, `${name} unresolved keeps every old row`);
  }
});

test('three silent route misses become unresolved rows, with no endpoint', async () => {
  const dir = repo({
    'Api.csproj': WEB,
    'Program.cs': [
      'var builder = WebApplication.CreateBuilder(args);', // 1
      'var app = builder.Build();', // 2
      'app.MapGet(Routes.Orders, () => "x");', // 3
      'app.MapPost(', // 4
      '  "/later", () => "y");', // 5
      '// app.MapGet(Routes.Commented, () => 1);', // 6
      'var s = "app.MapGet(Routes.InString, ";', // 7
      'app.MapGet("/ok", () => "z");', // 8
    ].join('\n'),
    'ItemsController.cs': [
      'public class ItemsController : ControllerBase', // 1
      '{',
      '    [HttpGet("api/items")]', // 3
      '    public IActionResult List() => Ok();',
      '    // [HttpPost("api/commented")]', // 5
      '}',
    ].join('\n'),
  });
  const r = await extract(dir);
  assert.deepEqual(r.facts.endpoints.map(e => e.node), ['Api/GET /ok']);
  const prog = u => u.file === 'Program.cs';
  assert.deepEqual(r.facts.unresolved.filter(prog).map(u => u.line).sort(), [3, 4]);
  assert.ok(r.facts.unresolved.filter(prog).every(u => /not read/.test(u.what) && u.where === 'Api'));
  const ctl = r.facts.unresolved.filter(u => u.file === 'ItemsController.cs');
  assert.deepEqual(ctl.map(u => u.line), [3]);
  assert.match(ctl[0].what, /\[Route\]/);
});

test('a Map call inside an extension method, called through a group, is an endpoint and not a miss', async () => {
  const dir = repo({
    'Api.csproj': WEB,
    'Program.cs': 'var builder = WebApplication.CreateBuilder(args);\nvar app = builder.Build();\nvar g = app.MapGroup("/orders");\ng.MapOrders();\n',
    'OrderEndpoints.cs': [
      'public static class OrderEndpoints',
      '{',
      '    public static void MapOrders(this RouteGroupBuilder g)',
      '    {',
      '        g.MapGet("/list", () => 1);',
      '    }',
      '}',
    ].join('\n'),
  });
  const r = await extract(dir);
  const e = find(r, 'Api/GET /orders/list');
  assert.ok(e, JSON.stringify(r.facts.endpoints));
  assert.deepEqual(e.evidence, { file: 'OrderEndpoints.cs', line: 5 });
  assert.equal(e.handler.kind, 'inline');
  assert.equal(r.facts.unresolved.some(u => /not read/.test(u.what)), false);
});

test('MapMethods and Express all have method null, node ANY and an unresolved row', async () => {
  const dir = repo({
    'Api.csproj': WEB,
    'Program.cs': 'var app = WebApplication.CreateBuilder(args).Build();\napp.MapMethods("/multi", new[] { "GET", "POST" }, () => 1);\n',
    'node/package.json': JSON.stringify({ name: 'nodeapi', dependencies: { express: '4' } }),
    'node/server.js': "const app = require('express')();\napp.all('/any', (req, res) => res.end());\n",
  });
  const r = await extract(dir);
  for (const [node, line] of [['Api/ANY /multi', 2], ['nodeapi/ANY /any', 2]]) {
    const e = find(r, node);
    assert.ok(e, node + ' ' + r.facts.endpoints.map(x => x.node));
    assert.equal(e.method, null);
    assert.equal(e.evidence.line, line);
    assert.ok(r.facts.unresolved.some(u => u.where === e.container && u.line === line && /HTTP method/.test(u.what)), node);
  }
});

test('the same method and route twice in a container: an unresolved row and no node', async () => {
  const dir = repo({
    'Api.csproj': WEB,
    'Program.cs': 'var app = WebApplication.CreateBuilder(args).Build();\napp.MapGet("/dup", () => 1);\napp.MapGet("/dup", () => 2);\napp.MapPost("/dup", () => 3);\n',
  });
  const r = await extract(dir);
  assert.deepEqual(r.facts.endpoints.map(e => e.node), ['Api/POST /dup']);
  assert.ok(r.facts.unresolved.some(u => u.where === 'Api' && /GET \/dup/.test(u.what) && /twice|2 times/.test(u.what)));
});

test('uses are linked by exact name in the same container and never when the name is ambiguous', async () => {
  const dir = repo({
    'Api.csproj': WEB,
    'Program.cs': 'var app = WebApplication.CreateBuilder(args).Build();\napp.MapGet("/x", () => Results.Ok(new Widget(Helper.Make())));\n',
    'Widget.cs': 'public class Widget { }\n',
    'A/Helper.cs': 'public class Helper { }\n',
    'B/Helper.cs': 'public class Helper { }\n',
  });
  // two components, so the two Helpers are two types (one component would merge them as partials)
  const r = await extract(dir, { components: [{ name: 'Alpha', paths: ['A/**'] }, { name: 'Beta', paths: ['B/**'] }] });
  const e = find(r, 'Api/GET /x');
  const names = e.handler.uses.map(u => r.facts.code.types.find(t => t.id === u).name);
  assert.deepEqual(names, ['Widget']);
  assert.ok(r.facts.unresolved.some(u => /"Helper"/.test(u.what) && u.where === 'Api'));
});

test('parens, braces and lambdas inside strings and comments do not move a handler span', async () => {
  const dir = repo({
    'Api.csproj': WEB,
    'Program.cs': [
      'var app = WebApplication.CreateBuilder(args).Build();', // 1
      'app.MapGet("/a", () =>', // 2
      '{',
      '    var s = "}) x => { ((";', // 4
      '    // ) } stray',
      '    return s;', // 6
      '});', // 7
      'app.MapGet("/b", () => "ok");', // 8
    ].join('\n'),
    'node/package.json': JSON.stringify({ name: 'nodeapi', dependencies: { express: '4' } }),
    'node/server.js': [
      "const app = require('express')();", // 1
      "app.get('/s', (req, res) => {", // 2
      "  const t = `}) => { ${'('}`;", // 3
      "  res.send('))}');", // 4
      '});', // 5
    ].join('\n'),
  });
  const r = await extract(dir);
  assert.deepEqual([find(r, 'Api/GET /a').handler.line, find(r, 'Api/GET /a').handler.endLine], [2, 7]);
  assert.deepEqual([find(r, 'Api/GET /b').handler.line, find(r, 'Api/GET /b').handler.endLine], [8, 8]);
  assert.deepEqual([find(r, 'nodeapi/GET /s').handler.line, find(r, 'nodeapi/GET /s').handler.endLine], [2, 5]);
});

test('a named handler is the type that holds the method; none or several types: handler null and an unresolved row', async () => {
  const dir = repo({
    'Api.csproj': WEB,
    'Program.cs': [
      'var app = WebApplication.CreateBuilder(args).Build();',
      'app.MapGet("/one", OrderHandlers.List);', // 2
      'app.MapGet("/two", Dup);', // 3
      'app.MapGet("/three", Missing);', // 4
    ].join('\n'),
    'OrderHandlers.cs': 'public static class OrderHandlers\n{\n    public static string List() => "";\n    public static string Dup() => "";\n}\n',
    'Other.cs': 'public static class Other\n{\n    public static string Dup() => "";\n}\n',
  });
  const r = await extract(dir);
  const one = find(r, 'Api/GET /one');
  assert.deepEqual([one.handler.kind, one.handler.node, one.handler.file, one.handler.line, one.handler.endLine], ['named', 'Api/OrderHandlers', 'OrderHandlers.cs', 1, 5]);
  for (const [node, line] of [['Api/GET /two', 3], ['Api/GET /three', 4]]) {
    assert.equal(find(r, node).handler, null, node);
    assert.ok(r.facts.unresolved.some(u => u.line === line && u.file === 'Program.cs' && /handler/.test(u.what)), node);
  }
});

test('split repos: nodes use the container name and file paths carry the repo prefix', async () => {
  const a = repo({ 'Api.csproj': WEB, 'Program.cs': 'var app = WebApplication.CreateBuilder(args).Build();\napp.MapGet("/a", () => 1);\n' });
  const b = repo({ 'Api.csproj': WEB, 'Program.cs': 'var app = WebApplication.CreateBuilder(args).Build();\napp.MapGet("/b", () => 2);\n' });
  const c = repo({ 'Web.csproj': WEB, 'Program.cs': 'var app = WebApplication.CreateBuilder(args).Build();\napp.MapGet("/c", () => 3);\n' });
  const r = await extract({ One: a, Two: b, Three: c });
  const nodes = r.facts.endpoints.map(e => e.node).sort();
  assert.deepEqual(nodes, ['Api (One)/GET /a', 'Api (Two)/GET /b', 'Web/GET /c']);
  const one = find(r, 'Api (One)/GET /a');
  assert.equal(one.evidence.file, 'One/Program.cs');
  assert.equal(one.handler.file, 'One/Program.cs');
  assert.deepEqual([one.handler.line, one.handler.endLine], [2, 2]);
  assert.equal(find(r, 'Web/GET /c').handler.file, 'Three/Program.cs');
});
