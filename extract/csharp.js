// Deterministic as-built extraction for .NET projects. Every element and edge carries evidence
// (file, line, text). Nothing is guessed: what can't be resolved is reported as "unresolved"
// instead of becoming an edge.
const fs = require('fs');
const path = require('path');
const catalogue = require('./catalogue');

const keyOf = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const humanTech = { web: 'ASP.NET Core', worker: '.NET Worker', app: '.NET app' };

// lowercase; ensure leading '/'; collapse '//'; strip trailing '/'; every {param} form becomes '{}'
function normaliseRouteCs(r) {
  let s = String(r);
  if (!s.startsWith('/')) s = '/' + s;
  s = s.toLowerCase();
  s = s.replace(/\{[^}]*\}/g, '{}');
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}
function joinRoute(prefix, route) {
  const p = prefix || '', r = route || '';
  if (!p) return r || '/';
  if (!r) return p;
  return p.replace(/\/+$/, '') + '/' + r.replace(/^\/+/, '');
}

// ---- minimal-API route resolution: MapGroup prefix chains (local vars, and across files via
// extension methods on IEndpointRouteBuilder/RouteGroupBuilder), MapGet/Post/Put/Patch/Delete/
// Methods, and MapHub<T>.
const MAP_VERB_RE = /\b(\w+)\.(MapGet|MapPost|MapPut|MapPatch|MapDelete|MapMethods)\(\s*"([^"]*)"/;
const MAP_GROUP_ASSIGN_RE = /\b(?:var|IEndpointRouteBuilder|RouteGroupBuilder)\s+(\w+)\s*=\s*(\w+)\.MapGroup\(\s*"([^"]*)"\s*\)/;
const EXT_METHOD_DEF_RE = /\bpublic\s+static\s+\S+\s+(\w+)\s*\(\s*this\s+(?:IEndpointRouteBuilder|RouteGroupBuilder)\s+(\w+)/;
const EXT_METHOD_CALL_RE = /\b(\w+)\.(\w+)\(\s*\)\s*;/;
const ROOT_VAR_RE = /\bvar\s+(\w+)\s*=\s*\w+(?:\.\w+)*\.Build\s*\(\s*\)/g;
const HUB_RE = /\bMapHub\s*<[^>]+>\s*\(\s*"([^"]+)"/;

function analyzeMinimalApiFile(text) {
  const lines = text.split(/\r?\n/);
  const prefixes = new Map(); // var -> {kind:'concrete', value} | {kind:'symbolic', param, suffix}
  let extDef = null;
  const extM = EXT_METHOD_DEF_RE.exec(text);
  if (extM) { extDef = { methodName: extM[1], paramName: extM[2] }; prefixes.set(extM[2], { kind: 'symbolic', param: extM[2], suffix: '' }); }
  for (const rm of text.matchAll(ROOT_VAR_RE)) prefixes.set(rm[1], { kind: 'concrete', value: '' });
  const resolve = v => prefixes.get(v) || { kind: 'concrete', value: '' };

  const directRoutes = [];
  lines.forEach((line, i) => {
    const gm = MAP_GROUP_ASSIGN_RE.exec(line);
    if (gm) {
      const [, localVar, baseVar, literal] = gm;
      const base = resolve(baseVar);
      prefixes.set(localVar, base.kind === 'concrete'
        ? { kind: 'concrete', value: joinRoute(base.value, literal) }
        : { kind: 'symbolic', param: base.param, suffix: joinRoute(base.suffix, literal) });
      return;
    }
    const vm = MAP_VERB_RE.exec(line);
    if (vm) directRoutes.push({ baseVar: vm[1], verb: vm[2], route: vm[3], lineIdx: i });
    const hm = HUB_RE.exec(line);
    if (hm) directRoutes.push({ baseVar: null, verb: 'MapHub', route: hm[1], lineIdx: i });
  });
  return { prefixes, extDef, directRoutes, resolve };
}
function finalizeMinimalApiRoute(dr, resolve) {
  if (dr.verb === 'MapHub') return { kind: 'concrete', value: dr.route };
  const base = resolve(dr.baseVar);
  return base.kind === 'concrete'
    ? { kind: 'concrete', value: joinRoute(base.value, dr.route) }
    : { kind: 'symbolic', param: base.param, suffix: joinRoute(base.suffix, dr.route) };
}

// ---- controllers: [Route("template")] on the class ([controller] -> class name minus
// "Controller"), [Http(Get|Post|Put|Patch|Delete)("sub")] on actions.
function scanControllerRoutes(text) {
  const lines = text.split(/\r?\n/);
  let classRoutePrefix = null, className = null;
  const routes = [];
  for (let i = 0; i < lines.length; i++) {
    const rAttr = /\[Route\(\s*"([^"]+)"\s*\)\]/.exec(lines[i]);
    if (rAttr) classRoutePrefix = rAttr[1];
    const classM = /\bclass\s+(\w+)/.exec(lines[i]);
    if (classM) className = classM[1];
    const hAttr = /\[Http(Get|Post|Put|Patch|Delete)(?:\(\s*"([^"]*)"\s*\))?\]/.exec(lines[i]);
    if (hAttr) routes.push({ verb: hAttr[1], sub: hAttr[2] || '', lineIdx: i });
  }
  if (!classRoutePrefix || !className) return [];
  const controllerName = className.replace(/Controller$/, '');
  const prefix = classRoutePrefix.replace('[controller]', controllerName);
  return routes.map(r => ({ ...r, route: joinRoute(prefix, r.sub) }));
}

// ---- Azure Functions: [HttpTrigger(..., Route = "<r>")] (literal or $"{X.Y}/<r>" interpolated
// against a `const string Y = "..."` in the closure), prefixed by host.json's routePrefix
// (default 'api', respecting an explicit '').
const HTTPTRIGGER_LITERAL_RE = /\[HttpTrigger\([^)]*\bRoute\s*=\s*"([^"]*)"/;
const HTTPTRIGGER_INTERP_RE = /\[HttpTrigger\([^)]*\bRoute\s*=\s*\$"\{(\w+)\.(\w+)\}\/?([^"]*)"/;
const SB_TRIGGER_RE = /\[ServiceBusTrigger\(\s*"([^"]+)"/;
const SB_OUTPUT_RE = /\[ServiceBusOutput\(\s*"([^"]+)"/;

const stripJsonComments = t => t.replace(/^\uFEFF/, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"\\])\/\/.*$/gm, '$1');
function flatten(obj, prefix = '', out = {}) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}:${k}` : k, out);
  else out[prefix.toLowerCase()] = obj;
  return out;
}

// config["A:B"], Configuration["A:B"], GetValue<string>("A:B"), GetConnectionString("X")
const CONFIG_RE = /(?:[Cc]onfig(?:uration)?|_config|cfg)\s*\[\s*"([^"]+)"\s*\]|GetValue<\s*string\s*>\(\s*"([^"]+)"\s*\)|GetConnectionString\(\s*"([^"]+)"\s*\)|GetSection\(\s*"([^"]+)"\s*\)\s*\[\s*"([^"]+)"\s*\]/;
function configKey(text) {
  const m = CONFIG_RE.exec(text); if (!m) return null;
  if (m[3]) return 'ConnectionStrings:' + m[3];
  if (m[4]) return `${m[4]}:${m[5]}`;
  return m[1] || m[2];
}

async function scan(ctx) {
  const { files, rel, read } = ctx;
  const unresolved = [];

  // ---- projects
  const projects = [];
  for (const f of files.filter(f => /\.(cs|fs)proj$/i.test(f))) {
    const t = await read(f);
    const sdk = (/<Project[^>]*\bSdk="([^"]+)"/.exec(t) || [, ''])[1];
    const outputType = (/<OutputType>\s*(\w+)\s*<\/OutputType>/i.exec(t) || [, ''])[1].toLowerCase();
    const refs = [...t.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)].map(m => path.resolve(path.dirname(f), m[1].replace(/\\/g, '/')));
    const pkgs = [...t.matchAll(/<PackageReference\s+Include="([^"]+)"/g)].map(m => m[1]);
    const name = path.basename(f).replace(/\.(cs|fs)proj$/i, '');
    let kind = 'library';
    if (/Microsoft\.NET\.Sdk\.Web/i.test(sdk)) kind = 'web';
    else if (/Microsoft\.NET\.Sdk\.Worker/i.test(sdk)) kind = 'worker';
    else if (outputType === 'exe' || outputType === 'winexe') kind = pkgs.some(p => /Hosting|Functions/i.test(p)) ? 'worker' : 'app';
    if (/\.Tests?$|\.UnitTests$|\.IntegrationTests$/i.test(name) || pkgs.some(p => /^(xunit|nunit|MSTest\.TestFramework|Microsoft\.NET\.Test\.Sdk)$/i.test(p))) kind = 'test';
    projects.push({ name, file: f, dir: path.dirname(f), kind, lang: /\.fsproj$/i.test(f) ? 'F#' : 'C#', refs, pkgs, sources: [], settings: {}, ports: [] });
  }
  if (!projects.length) return { projects: [], elements: [], edges: [], consumes: [], provides: [], unresolved: [] };

  // ---- sources belong to the deepest project directory containing them
  const byDepth = projects.slice().sort((a, b) => b.dir.length - a.dir.length);
  for (const f of files.filter(f => /\.(cs|fs)$/i.test(f))) {
    const p = byDepth.find(p => f.startsWith(p.dir + path.sep)); if (p) p.sources.push(f);
  }
  // ---- settings and ports
  for (const p of projects) {
    for (const n of ['appsettings.json', 'appsettings.Development.json']) {
      const f = path.join(p.dir, n);
      if (fs.existsSync(f)) { try { Object.assign(p.settings, flatten(JSON.parse(stripJsonComments(await read(f))))); p.settingsFile = p.settingsFile || rel(f); } catch { unresolved.push({ where: p.name, what: `${n} is not valid JSON`, file: rel(f), line: 1 }); } }
    }
    const ls = path.join(p.dir, 'Properties', 'launchSettings.json');
    if (fs.existsSync(ls)) { const t = await read(ls); for (const m of t.matchAll(/https?:\/\/[^";]+?:(\d+)/g)) p.ports.push(m[1]); }
    // Azure Functions: local.settings.json Values fold into settings (for %Name% resolution);
    // host.json's extensions.http.routePrefix ('api' by default, '' respected when explicit).
    const lsj = path.join(p.dir, 'local.settings.json');
    if (fs.existsSync(lsj)) { try { const j = JSON.parse(stripJsonComments(await read(lsj))); if (j.Values) Object.assign(p.settings, flatten(j.Values)); } catch { unresolved.push({ where: p.name, what: 'local.settings.json is not valid JSON', file: rel(lsj), line: 1 }); } }
    const hj = path.join(p.dir, 'host.json');
    if (fs.existsSync(hj)) { try { const j = JSON.parse(stripJsonComments(await read(hj))); const rp = j.extensions && j.extensions.http && j.extensions.http.routePrefix; p.routePrefix = rp != null ? rp : 'api'; } catch { unresolved.push({ where: p.name, what: 'host.json is not valid JSON', file: rel(hj), line: 1 }); } }
  }
  const byFile = new Map(projects.map(p => [path.resolve(p.file), p]));
  const closure = p => { const seen = new Set(), stack = [p]; while (stack.length) { const x = stack.pop(); if (seen.has(x)) continue; seen.add(x); for (const r of x.refs) { const q = byFile.get(path.resolve(r)); if (q) stack.push(q); } } return [...seen]; };
  const deployables = projects.filter(p => ['web', 'worker', 'app'].includes(p.kind));
  const units = [];
  for (const d of deployables) for (const f of d.sources) units.push({ owner: keyOf(d.name), file: rel(f), relFromRoot: path.relative(d.dir, f).split(path.sep).join('/'), evidence: { file: rel(f), line: 1, text: path.basename(f) } });

  // ---- scan sources
  const hits = [];
  for (const p of projects) for (const f of p.sources) {
    const lines = (await read(f)).split(/\r?\n/);
    lines.forEach((text, i) => hits.push({ p, file: rel(f), line: i + 1, text, ctx: lines.slice(i, i + 4).join(' ') }));
  }
  const ev = s => ({ file: s.file, line: s.line, text: s.text.trim().slice(0, 200) });

  const elements = new Map(); // key -> element
  const add = (name, kind, tech, extra = {}) => { const k = keyOf(name); if (!elements.has(k)) elements.set(k, { name, kind, tech, evidence: [], ...extra }); return elements.get(k); };
  const isFunctionsWorker = d => d.pkgs.some(pkg => /^Microsoft\.Azure\.Functions\.Worker$/i.test(pkg));
  for (const d of deployables) {
    const tech = isFunctionsWorker(d) ? 'Azure Functions (.NET isolated)' : `${humanTech[d.kind]}${d.lang === 'F#' ? ' (F#)' : ''}`;
    const el = add(d.name, 'container', tech, { project: rel(d.file), role: d.kind, ports: d.ports.slice() });
    el.evidence.push({ file: rel(d.file), line: 1, text: `${d.kind === 'web' ? 'Web SDK project' : d.kind === 'worker' ? 'Worker project' : 'Executable project'}${d.refs.length ? `, references ${d.refs.map(r => path.basename(r).replace(/\.(cs|fs)proj$/i, '')).join(', ')}` : ''}` });
  }
  const edges = []; const addEdge = (from, to, kind, label, tech, evidence) => {
    let e = edges.find(x => x.from === from && x.to === to && x.kind === kind);
    if (!e) { e = { from, to, kind, label, tech, evidence: [] }; edges.push(e); }
    e.evidence.push(evidence); return e;
  };
  const ownersOf = p => deployables.filter(d => closure(d).includes(p));
  const setting = (d, key) => { for (const q of closure(d)) { const v = q.settings[key.toLowerCase()]; if (v != null) return v; } return undefined; };

  // stores: EF DbContext classes, used by deployables that mention them
  const contexts = [];
  for (const s of hits) {
    const m = /\b(?:class|type)\s+(\w+)\s*(?:\([^)]*\))?\s*(?::|inherit)\s*(?:[\w.]*\.)?(?:Identity)?DbContext\b/.exec(s.text);
    if (m) contexts.push({ cls: m[1], s });
  }
  for (const c of contexts) {
    let tech = 'Database (EF Core)';
    const provider = hits.find(s => s.text.includes(c.cls) && /Use(SqlServer|Npgsql|Cosmos|Sqlite|MySql|Oracle)/.test(s.ctx));
    if (provider) tech = { SqlServer: 'SQL Server', Npgsql: 'PostgreSQL', Cosmos: 'Cosmos DB', Sqlite: 'SQLite', MySql: 'MySQL', Oracle: 'Oracle' }[/Use(SqlServer|Npgsql|Cosmos|Sqlite|MySql|Oracle)/.exec(provider.ctx)[1]];
    const base = c.cls.replace(/Context$/, ''); const name = /db$/i.test(base) ? base : base + 'Db';
    const store = add(name, 'store', tech); store.evidence.push({ ...ev(c.s), text: `EF Core context ${c.cls}` });
    for (const d of deployables) {
      const own = closure(d).map(q => q);
      const uses = hits.filter(s => s.p === d && new RegExp(`\\b${c.cls}\\b`).test(s.text));
      if (!uses.length) continue;
      const writes = hits.some(s => own.includes(s.p) && /SaveChanges(Async)?\s*\(/.test(s.text) && s.p === d) || uses.some(s => /SaveChanges/.test(s.ctx));
      addEdge(keyOf(d.name), keyOf(name), 'data', writes ? 'Reads and writes' : 'Reads', 'EF Core', ev(uses[0]));
    }
  }
  // stores: Redis, Blob, Cosmos SDK clients
  for (const s of hits) {
    const owners = s.p.kind === 'library' ? ownersOf(s.p) : [s.p];
    const redis = /ConnectionMultiplexer\.Connect|AddStackExchangeRedisCache/.test(s.text);
    const blob = /new\s+BlobServiceClient\s*\(/.test(s.text);
    const cosmos = /new\s+CosmosClient\s*\(/.test(s.text);
    if (!redis && !blob && !cosmos) continue;
    const key = configKey(s.ctx);
    const nm = key ? key.split(':').pop() : redis ? 'Redis' : blob ? 'Blob Storage' : 'Cosmos DB';
    const store = add(nm, 'store', redis ? 'Redis' : blob ? 'Azure Blob Storage' : 'Cosmos DB'); store.evidence.push(ev(s));
    for (const d of owners) addEdge(keyOf(d.name), keyOf(nm), 'data', 'Uses', redis ? 'Redis' : blob ? 'Blob SDK' : 'Cosmos SDK', ev(s));
  }
  // sync HTTP: AddHttpClient with a BaseAddress from configuration
  for (const s of hits) {
    if (!/AddHttpClient/.test(s.text)) continue;
    const owners = s.p.kind === 'library' ? ownersOf(s.p) : [s.p];
    const key = configKey(s.ctx);
    const client = (/AddHttpClient<\s*(\w+)/.exec(s.text) || /AddHttpClient\(\s*"([^"]+)"/.exec(s.text) || [, 'HttpClient'])[1];
    for (const d of owners) {
      if (!key) { unresolved.push({ where: d.name, what: `HTTP client ${client} has no base address from configuration`, ...ev(s) }); continue; }
      const url = setting(d, key);
      if (!url || typeof url !== 'string') { unresolved.push({ where: d.name, what: `HTTP client ${client}: config key "${key}" has no value in appsettings`, ...ev(s) }); continue; }
      let u; try { u = new URL(url); } catch { unresolved.push({ where: d.name, what: `HTTP client ${client}: "${url}" is not a URL`, ...ev(s) }); continue; }
      const byPort = deployables.find(x => x !== d && u.port && x.ports.includes(u.port));
      const byName = deployables.find(x => x !== d && (keyOf(x.name) === keyOf(u.hostname.split('.')[0]) || keyOf(x.name) === keyOf(key.split(':').pop())));
      const target = /^(localhost|127\.0\.0\.1)$/.test(u.hostname) ? byPort : (byName || byPort);
      if (target) { addEdge(keyOf(d.name), keyOf(target.name), 'sync', `Calls via ${client}`, 'HTTP', { ...ev(s), text: `${s.text.trim().slice(0, 140)}  →  ${key} = ${url}` }); continue; }
      if (/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) { unresolved.push({ where: d.name, what: `HTTP client ${client} calls ${url}, which matches no project's launch port`, ...ev(s) }); continue; }
      const ext = add(u.hostname, 'external', 'External HTTP API'); ext.evidence.push({ ...ev(s), text: `${key} = ${url}` });
      addEdge(keyOf(d.name), keyOf(u.hostname), 'sync', `Calls via ${client}`, 'HTTPS', { ...ev(s), text: `${key} = ${url}` });
    }
  }
  // async: Azure Service Bus senders and processors, reported as queue consumes/provides —
  // link.js matches them on queue or topic name across the whole repo (and later, cross-language).
  const consumes = [], provides = [];
  for (const s of hits) {
    const m = /Create(Sender|Processor|Receiver|SessionProcessor)\s*\((.*)$/.exec(s.text); if (!m) continue;
    const owners = s.p.kind === 'library' ? ownersOf(s.p) : [s.p];
    for (const d of owners) {
      const lit = /^\s*"([^"]+)"/.exec(m[2]); const key = lit ? null : configKey(m[2]);
      const qn = lit ? lit[1] : key ? setting(d, key) : null;
      if (!qn) { unresolved.push({ where: d.name, what: `Service Bus ${m[1].toLowerCase()} with a queue name that isn't a literal or config value`, ...ev(s) }); continue; }
      if (m[1] === 'Sender') consumes.push({ owner: keyOf(d.name), kind: 'queue', key: String(qn), evidence: ev(s) });
      else provides.push({ owner: keyOf(d.name), kind: 'queue', key: String(qn), evidence: ev(s) });
    }
  }

  // ---- HTTP/hub routes: minimal-API (MapGroup/MapGet.../MapHub, including cross-file extension
  // method prefix propagation), controllers ([Route]+[Http*]), Azure Functions ([HttpTrigger]).
  const resolveQueueName = (lit, d) => {
    const m = /^%(.+)%$/.exec(lit);
    if (!m) return { qn: lit, env: undefined };
    const val = setting(d, m[1]);
    return val != null ? { qn: String(val), env: undefined } : { qn: null, env: m[1] };
  };
  for (const d of deployables) {
    const fileTexts = new Map();
    for (const f of d.sources) fileTexts.set(f, await read(f));
    const pushHttpRoute = (routeStr, kind, file, lineIdx, textLine) => {
      const evidence = { file: rel(file), line: lineIdx + 1, text: textLine.trim().slice(0, 200) };
      provides.push({ owner: keyOf(d.name), kind, key: normaliseRouteCs(routeStr), evidence });
    };

    if (!isFunctionsWorker(d)) {
      const analyses = new Map();
      for (const [f, t] of fileTexts) analyses.set(f, analyzeMinimalApiFile(t));
      const extByName = new Map(); // methodName -> { file, templates: [{suffix, verb, lineIdx}] }
      for (const [f, a] of analyses) {
        if (!a.extDef) continue;
        const templates = a.directRoutes
          .map(dr => ({ dr, res: finalizeMinimalApiRoute(dr, a.resolve) }))
          .filter(x => x.res.kind === 'symbolic' && x.res.param === a.extDef.paramName)
          .map(x => ({ suffix: x.res.suffix, verb: x.dr.verb, lineIdx: x.dr.lineIdx }));
        extByName.set(a.extDef.methodName, { file: f, templates });
      }
      for (const [f, a] of analyses) {
        const lines = fileTexts.get(f).split(/\r?\n/);
        for (const dr of a.directRoutes) {
          const res = finalizeMinimalApiRoute(dr, a.resolve);
          if (res.kind !== 'concrete') continue;
          pushHttpRoute(res.value, dr.verb === 'MapHub' ? 'hub' : 'http', f, dr.lineIdx, lines[dr.lineIdx]);
        }
        for (let i = 0; i < lines.length; i++) {
          const cm = EXT_METHOD_CALL_RE.exec(lines[i]);
          if (!cm) continue;
          const ext = extByName.get(cm[2]);
          if (!ext) continue;
          const base = a.resolve(cm[1]);
          if (base.kind !== 'concrete') continue;
          const extLines = fileTexts.get(ext.file).split(/\r?\n/);
          for (const tpl of ext.templates) pushHttpRoute(joinRoute(base.value, tpl.suffix), tpl.verb === 'MapHub' ? 'hub' : 'http', ext.file, tpl.lineIdx, extLines[tpl.lineIdx]);
        }
      }
      for (const [f, t] of fileTexts) {
        const lines = t.split(/\r?\n/);
        for (const r of scanControllerRoutes(t)) pushHttpRoute(r.route, 'http', f, r.lineIdx, lines[r.lineIdx]);
      }
    } else {
      const routePrefix = closure(d).map(q => q.routePrefix).find(rp => rp != null) ?? 'api';
      for (const [f, t] of fileTexts) {
        const lines = t.split(/\r?\n/);
        lines.forEach((line, i) => {
          const lit = HTTPTRIGGER_LITERAL_RE.exec(line);
          if (lit) { pushHttpRoute(joinRoute(routePrefix, lit[1]), 'http', f, i, line); return; }
          const interp = HTTPTRIGGER_INTERP_RE.exec(line);
          if (interp) {
            const [, clsVar, constName, suffix] = interp;
            const constRe = new RegExp(`\\bconst\\s+string\\s+${constName}\\s*=\\s*"([^"]*)"`);
            const constHit = hits.find(s => closure(d).includes(s.p) && constRe.test(s.text));
            if (constHit) pushHttpRoute(joinRoute(routePrefix, joinRoute(constRe.exec(constHit.text)[1], suffix)), 'http', f, i, line);
            else unresolved.push({ where: d.name, what: `HttpTrigger Route references ${clsVar}.${constName}, which could not be resolved to a literal`, file: rel(f), line: i + 1, text: line.trim().slice(0, 200) });
          }
        });
      }
    }

    // Azure Service Bus attributes: [ServiceBusTrigger] -> queue provide, [ServiceBusOutput] -> queue consume
    for (const [f, t] of fileTexts) {
      const lines = t.split(/\r?\n/);
      lines.forEach((line, i) => {
        const evidence = { file: rel(f), line: i + 1, text: line.trim().slice(0, 200) };
        const trig = SB_TRIGGER_RE.exec(line);
        if (trig) { const { qn, env } = resolveQueueName(trig[1], d); provides.push({ owner: keyOf(d.name), kind: 'queue', key: qn, ...(env ? { env } : {}), evidence }); }
        const out = SB_OUTPUT_RE.exec(line);
        if (out) { const { qn, env } = resolveQueueName(out[1], d); consumes.push({ owner: keyOf(d.name), kind: 'queue', key: qn, ...(env ? { env } : {}), evidence }); }
      });
    }
  }

  // ---- catalogue: shared external/store SDKs (extract/catalogue.js), triggered by text pattern
  // or PackageReference, attributed through library closures like the Redis/Blob/Cosmos block above.
  const CS_CATALOGUE_TEXT_TRIGGERS = [
    { re: /\bnew\s+SnowflakeDbConnection\s*\(/, cat: 'SNOWFLAKE', kind: 'data', label: 'Reads and writes' },
    { re: /\bnew\s+SqlConnection\s*\(/, cat: 'SQL_SERVER', kind: 'data', label: 'Reads and writes' },
    { re: /\bnew\s+NpgsqlConnection\s*\(/, cat: 'POSTGRESQL', kind: 'data', label: 'Reads and writes' },
    { re: /\bnew\s+SecretClient\s*\(/, cat: 'KEY_VAULT', kind: 'data', label: 'Reads secrets from' },
    { re: /\bAddJwtBearer\b|\bAddMicrosoftIdentityWebApi\b|GetSection\(\s*"AzureAd"\s*\)/, cat: 'ENTRA_ID', kind: 'sync', label: 'Authenticates via' },
    { re: /APPLICATIONINSIGHTS_CONNECTION_STRING|\bAddApplicationInsightsTelemetry\b/, cat: 'APPLICATION_INSIGHTS', kind: 'sync', label: 'Sends telemetry to' },
  ];
  for (const trig of CS_CATALOGUE_TEXT_TRIGGERS) {
    for (const s of hits) {
      if (!trig.re.test(s.text)) continue;
      const owners = s.p.kind === 'library' ? ownersOf(s.p) : [s.p];
      const entry = catalogue[trig.cat];
      const el = add(entry.name, entry.kind, entry.tech); el.evidence.push(ev(s));
      for (const d of owners) addEdge(keyOf(d.name), keyOf(entry.name), trig.kind, trig.label, entry.tech, ev(s));
    }
  }
  for (const p of projects) {
    if (!p.pkgs.some(pkg => /^NewRelic\.Agent/i.test(pkg))) continue;
    const owners = p.kind === 'library' ? ownersOf(p) : [p];
    const entry = catalogue.NEW_RELIC;
    const evidence = { file: rel(p.file), line: 1, text: 'PackageReference: NewRelic.Agent' };
    const el = add(entry.name, entry.kind, entry.tech); el.evidence.push(evidence);
    for (const d of owners) addEdge(keyOf(d.name), keyOf(entry.name), 'sync', 'Sends telemetry to', entry.tech, evidence);
  }

  return {
    projects: projects.map(p => ({ name: p.name, kind: p.kind, lang: p.lang, file: rel(p.file), sources: p.sources.length })),
    elements: [...elements.values()],
    edges,
    consumes,
    provides,
    units,
    unresolved,
  };
}

module.exports = { id: 'csharp', scan };
