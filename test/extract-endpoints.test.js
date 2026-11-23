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
    const normDate = t => t.replace(/ on \d{4}-\d{2}-\d{2}\./, ' on <date>.');
    assert.equal(normDate(r.dsl), normDate(gold.dsl), `${name} dsl`);
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

// ---- retry 1: wrong handler links, nodes for non-endpoints, silent misses, wrong spans
const TOP = 'var app = WebApplication.CreateBuilder(args).Build();\n';
const PKG = JSON.stringify({ name: 'nodeapi', dependencies: { express: '4', axios: '1' } });
const jsRepo = (body, more = {}) => repo({ 'package.json': PKG, 'server.js': "const app = require('express')();\n" + body, ...more });
const rowsFor = (r, file, line) => r.facts.unresolved.filter(u => u.file === file && u.line === line);

test('R1.1 a bare handler name resolves only to the enclosing type, never to another type that has a method of that name', async () => {
  for (const [body, other] of [
    ['app.MapGet("/h", Health);\nstring Health() => "ok";\n', 'public string Health() => "other";'],
    ['var health = () => "ok";\napp.MapGet("/h", health);\n', 'public string health() => "other";'],
  ]) {
    const r = await extract(repo({ 'Api.csproj': WEB, 'Program.cs': TOP + body, 'Monitor.cs': `public class Monitor\n{\n    ${other}\n}\n` }));
    const e = find(r, 'Api/GET /h');
    assert.ok(e);
    assert.equal(e.handler, null, body);
    assert.equal(rowsFor(r, 'Program.cs', body.startsWith('app') ? 2 : 3).filter(u => /handler/.test(u.what)).length, 1, body);
  }
});

test('R1.1 a local of the same name shadows the enclosing type method; the method group in its own class still links', async () => {
  const r = await extract(repo({
    'Api.csproj': WEB, 'Program.cs': TOP + 'app.MapO();\n',
    'OEndpoints.cs': [
      'public static class OEndpoints', // 1
      '{',
      '    public static void MapO(this IEndpointRouteBuilder g)',
      '    {',
      '        g.MapGet("/o", List);', // 5
      '    }',
      '    public static void MapP(this IEndpointRouteBuilder g)',
      '    {',
      '        var List = Make();',
      '        g.MapGet("/p", List);', // 10
      '    }',
      '    static string List() => "";',
      '}',
    ].join('\n'),
  }));
  const own = r.facts.endpoints.find(e => e.evidence.line === 5);
  assert.deepEqual([own.handler.kind, own.handler.node], ['named', 'Api/OEndpoints']);
  const shadowed = r.facts.endpoints.find(e => e.evidence.line === 10);
  assert.equal(shadowed.handler, null);
  assert.equal(rowsFor(r, 'OEndpoints.cs', 10).filter(u => /handler/.test(u.what)).length, 1);
});

test('R1.2 a qualifier matches a type with the exact case-sensitive rule and never when a local has that name', async () => {
  const orders = 'public class Orders\n{\n    public string List() => "";\n}\n';
  const a = await extract(repo({ 'Api.csproj': WEB, 'Program.cs': TOP + 'var orders = Factory.Make();\napp.MapGet("/o", orders.List);\n', 'Orders.cs': orders }));
  assert.equal(find(a, 'Api/GET /o').handler, null);
  assert.equal(rowsFor(a, 'Program.cs', 3).filter(u => /handler/.test(u.what)).length, 1);
  const b = await extract(repo({ 'Api.csproj': WEB, 'Program.cs': TOP + 'var Orders = Factory.Make();\napp.MapGet("/o", Orders.List);\n', 'Orders.cs': orders }));
  assert.equal(find(b, 'Api/GET /o').handler, null, 'a local named Orders shadows the type');
  const c = await extract(repo({ 'Api.csproj': WEB, 'Program.cs': TOP + 'app.MapGet("/o", Orders.List);\n', 'Orders.cs': orders }));
  assert.equal(find(c, 'Api/GET /o').handler.node, 'Api/Orders');
});

test('R1 a named JS handler in its own module still links', async () => {
  const r = await extract(jsRepo("function list(req, res) { res.end(); }\napp.get('/n', list);\n"));
  assert.equal(find(r, 'nodeapi/GET /n').handler.kind, 'named');
});

test('R3 a route in a comment is neither a node nor a row (provides are pinned by the unchanged-output tests)', async () => {
  const cs = await extract(repo({ 'Api.csproj': WEB, 'Program.cs': TOP + '// app.MapGet("/ghost", () => 1);\n/*\napp.MapPost("/ghost2", () => 2);\n*/\n', 'C.cs': '[Route("a")]\npublic class AController : ControllerBase\n{\n  // [HttpGet("ghost")]\n  public int X() => 1;\n}\n' }));
  assert.deepEqual(cs.facts.endpoints, []);
  assert.deepEqual(cs.facts.unresolved.filter(u => /ghost|GET|POST/.test(u.what) && /handler|not read|endpoint/.test(u.what)), []);
  const js = await extract(jsRepo("// app.get('/ghost', h);\n/* app.post('/g2', h) */\n"));
  assert.deepEqual(js.facts.endpoints, []);
  assert.deepEqual(js.facts.unresolved.filter(u => /ghost|g2/.test(u.what)), []);
  const fn = await extract(repo({ 'Fn.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.Azure.Functions.Worker" Version="1"/></ItemGroup></Project>', 'F.cs': 'public class F\n{\n    // [Function("A")] [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "ghost")]\n    public int A() => 1;\n}\n' }));
  assert.deepEqual(fn.facts.endpoints, []);
  assert.deepEqual(fn.facts.unresolved.filter(u => /ghost/.test(u.what)), []);
});

test('R4 a JS call with no handler argument is neither a node nor a row; with a handler it needs an express receiver', async () => {
  const r = await extract(jsRepo([
    "app.get('/real', async (req, res) => {", // 2
    "  const x = await axios.get('/remote/thing');", // 3
    '  res.json(x);',
    '});',
    "const v = cache.get('/not/a/route');", // 6
    "axios.post('/remote', body);", // 7
    "const router = require('express').Router();",
    "router.get('/r', (req, res) => res.end());", // 9
    'module.exports = (srv) => { srv.get(\'/inj\', (req, res) => res.end()); };', // 10
    "const inj = (app) => app.put('/in', (req, res) => res.end());", // 11
  ].join('\n') + '\n', { 'server.test.js': "request(app).get('/real');\nagent.post('/real');\n" }));
  assert.deepEqual(r.facts.endpoints.map(e => e.node).sort(), ['nodeapi/GET /r', 'nodeapi/GET /real', 'nodeapi/PUT /in'].sort(), r.facts.endpoints.map(e => e.node).join());
  assert.equal(rowsFor(r, 'server.js', 3).length + rowsFor(r, 'server.js', 6).length + rowsFor(r, 'server.test.js', 2).length, 0);
  const lost = rowsFor(r, 'server.js', 7);
  assert.equal(lost.length, 1);
  assert.match(lost[0].what, /axios/);
  assert.equal(rowsFor(r, 'server.js', 10).length, 1, 'a route on an unknown receiver is a row, not a silent loss');
});

test('R5 a Map call chained off MapGroup is reported, not dropped', async () => {
  const r = await extract(repo({ 'Api.csproj': WEB, 'Program.cs': TOP + 'app.MapGroup("/g").MapGet("/in", () => 1);\n' }));
  assert.deepEqual(r.facts.endpoints, []);
  const rows = rowsFor(r, 'Program.cs', 2);
  assert.equal(rows.length, 1);
  assert.match(rows[0].what, /not read/);
});

test('R6 the second route call on one line is reported', async () => {
  const cs = await extract(repo({ 'Api.csproj': WEB, 'Program.cs': TOP + 'app.MapGet("/a", () => 1); app.MapPost("/b", () => 2);\n' }));
  assert.deepEqual(cs.facts.endpoints.map(e => e.node), ['Api/GET /a']);
  const rows = rowsFor(cs, 'Program.cs', 2);
  assert.equal(rows.length, 1);
  assert.match(rows[0].what, /MapPost.*not read/);
  const js = await extract(jsRepo("app.get('/a', (q, s) => s.end()); app.post('/b', (q, s) => s.end());\n"));
  assert.deepEqual(js.facts.endpoints.map(e => e.node), ['nodeapi/GET /a']);
  const jr = rowsFor(js, 'server.js', 2);
  assert.equal(jr.length, 1);
  assert.match(jr[0].what, /post.*not read/);
});

test('R7 regex literals are blanked, division is not mistaken for one', async () => {
  const r = await extract(jsRepo([
    "app.get('/p', (req, res) => {", // 2
    '  res.send(/\\)/.test(req.url));',
    '});', // 4
    "app.get('/q', (req, res) => {", // 5
    '  res.send(req.url.replace(/"/g, \'\'));',
    '});', // 7
    "app.get('/d', (req, res) => {", // 8
    '  const half = req.n / 2 / (3);', // 9
    "  res.send('(');",
    '});', // 11
    "app.get('/c', (req, res) => { const k = [/[)/]/]; res.end(); });", // 12
  ].join('\n') + '\n'));
  const span = n => { const h = find(r, n).handler; return h && [h.line, h.endLine]; };
  assert.deepEqual(span('nodeapi/GET /p'), [2, 4]);
  assert.deepEqual(span('nodeapi/GET /q'), [5, 7]);
  assert.deepEqual(span('nodeapi/GET /d'), [8, 11]);
  assert.deepEqual(span('nodeapi/GET /c'), [12, 12]);
  assert.equal(r.facts.unresolved.filter(u => u.file === 'server.js' && /handler/.test(u.what)).length, 0);
});

test('R8 an F# type variable does not swallow the handlers after it, and csharp.blankComments is unchanged for others', async () => {
  const r = await extract(repo({ 'Svc.fsproj': WEB, 'Program.fs': 'let app = WebApplication.CreateBuilder().Build()\napp.MapPost("/rate", Func<_,_>(fun (x: \'a) -> x)) |> ignore\napp.MapPost("/two", Func<_>(fun () -> 1)) |> ignore\n' }));
  const span = n => { const h = find(r, n).handler; return h && [h.line, h.endLine]; };
  assert.deepEqual(span('Svc/POST /rate'), [2, 2]);
  assert.deepEqual(span('Svc/POST /two'), [3, 3]);
  const { blankComments } = require('../extract/csharp.js');
  assert.equal(blankComments("var c = 'a'; // x\nvar s = \"q\";"), "var c = 'a';     \nvar s = \"q\";");
  assert.equal(blankComments("'a x'", true), "'   '");
});

test('S1b r2 blankJs is linear: 1 MB with many slashes blanks in well under a second', () => {
  const { blankJs } = require('../extract/endpoints.js');
  const text = 'let a = b / c; // note\n'.repeat(45000);
  const t0 = Date.now();
  const out = blankJs(text);
  const ms = Date.now() - t0;
  assert.equal(out.length, text.length);
  assert.ok(ms < 1000, `blankJs took ${ms} ms`);
});

test('S1b r2 a JSX closing tag and division after ++ keep their handler span', async () => {
  const r = await extract(repo({ 'package.json': '{"name":"nodeapi","dependencies":{"express":"4"}}', 'server.js': [
    "const app = require('express')();",
    'app.get("/page", (req, res) => res.send(<p>hi</p>)); // see docs/pages',
    'app.get("/after", (q, r) => r.end());',
    "app.get('/d', (q, r) => { let i = 0; i++ / 2; r.end(); }); // a/b",
    "app.get('/e', (q, r) => r.end());",
  ].join('\n') + '\n' }));
  for (const n of ['/page', '/after', '/d', '/e']) {
    const e = find(r, `nodeapi/GET ${n}`);
    assert.ok(e && e.handler && e.handler.kind === 'inline', n);
  }
  assert.equal(r.facts.unresolved.filter(u => u.file === 'server.js').length, 0);
});

test('S1b r2 a long blanked string literal does not make the Map* scan quadratic', async () => {
  const t0 = Date.now();
  const r = await extract(repo({ 'Api.csproj': WEB, 'Program.cs': 'var app = WebApplication.CreateBuilder().Build();\nvar s = "' + ' '.repeat(60000) + '";\napp.MapGet("/ok", () => 1);\n' }));
  const ms = Date.now() - t0;
  assert.ok(find(r, 'Api/GET /ok'));
  assert.ok(ms < 1500, `extract took ${ms} ms`);
});
