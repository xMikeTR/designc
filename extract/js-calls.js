// Outbound HTTP/hub/SDK call detection for JS/TS packages: fetch/axios/ky calls (including
// through a same-module base+path wrapper), the Vite dev proxy, SignalR hub connections, Azure
// Service Bus senders/receivers, and the shared catalogue of SDK clients (extract/catalogue.js).
// Nothing is guessed: a call whose target can't be traced to a literal or a traceable env var
// goes to unresolved with file and line, never an edge.
const fs = require('fs');
const path = require('path');
const catalogue = require('./catalogue');

const keyOf = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// lowercase; collapse '//'; strip trailing '/'; every parameter form becomes '{}'
function normaliseRoute(r) {
  let s = String(r).toLowerCase();
  s = s.replace(/\$\{[^}]*\}/g, '{}');
  s = s.replace(/:[a-z0-9_]+/g, '{}');
  s = s.replace(/\{[^}]*\}/g, '{}');
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}

function matchStringLiteral(s) {
  const m = /^(['"])((?:(?!\1).)*)\1$/.exec(s.trim());
  return m ? m[2] : null;
}
function matchTemplateLiteral(s) {
  const m = /^`([\s\S]*)`$/.exec(s.trim());
  return m ? m[1] : null;
}
// Resolves a call argument's source text to a path string: a plain literal, a template literal
// (left as-is; normaliseRoute turns its ${...} spans into '{}'), or a '+'-joined concatenation of
// literals and bare expressions (each non-literal segment becomes '{}'). Returns null when no
// literal segment can be found at all.
function resolvePathExpr(argText) {
  const trimmed = argText.trim();
  const lit = matchStringLiteral(trimmed); if (lit !== null) return lit;
  const tmpl = matchTemplateLiteral(trimmed); if (tmpl !== null) return tmpl;
  const segs = trimmed.split(/\s*\+\s*/);
  if (segs.length < 2) return null;
  let out = '', sawLiteral = false;
  for (const seg of segs) {
    const l = matchStringLiteral(seg);
    const t = matchTemplateLiteral(seg);
    if (l !== null) { out += l; sawLiteral = true; }
    else if (t !== null) { out += t; sawLiteral = true; }
    else out += '{}';
  }
  return sawLiteral ? out : null;
}

// Module-level `const NAME = '<literal>'` (no interpolation), so `${NAME}/path` and `NAME + '/path'`
// resolve to the literal at a call site in the same file.
function stringConsts(text) {
  const out = new Map();
  for (const m of text.matchAll(/^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*(['"`])((?:(?!\2)[^\\$])*)\2\s*;?\s*$/gm)) out.set(m[1], m[3]);
  return out;
}
function inlineConsts(argText, consts) {
  if (!consts.size) return argText;
  const t = argText.trim();
  if (consts.has(t)) return `'${consts.get(t)}'`;
  if (t.startsWith('`')) return t.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (all, n) => (consts.has(n) ? consts.get(n) : all));
  return t.split(/\s*\+\s*/).map(seg => (consts.has(seg) ? `'${consts.get(seg)}'` : seg)).join(' + ');
}
// Same-file functions that hand their first parameter to fetch (`function request(url) { ... fetch(url) }`
// or `const request = async (url) => fetch(url)`): the fetch is plumbing, the call sites carry the URL.
// The enclosing function is the nearest header before the fetch whose first parameter is that identifier.
// Only a function that is not exported and is called in the same file counts: otherwise callers elsewhere
// would be missed silently, so its fetch stays unresolved.
const FN_HEADER_RE = /(?:\bfunction\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(\s*([A-Za-z_$][\w$]*)|\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:<[^>]*>)?\s*\(\s*([A-Za-z_$][\w$]*))/g;
const callSites = (text, name) => findCalls(text, new RegExp(`(?<!function\\s+)(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*(?:<[^()]*?>)?\\s*\\(`, 'g'));
function fetchWrappers(text, fetchCalls) {
  const headers = [...text.matchAll(FN_HEADER_RE)].map(m => ({ name: m[1] || m[3], param: m[2] || m[4], index: m.index,
    exported: /\bexport\s+(?:default\s+)?(?:async\s+)?$/.test(text.slice(Math.max(0, m.index - 30), m.index)) }));
  const names = new Set(), plumbing = new Set();
  for (const { argsText, index } of fetchCalls) {
    const first = (splitTopLevelArgs(argsText)[0] || '').trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(first)) continue;
    const h = headers.filter(x => x.index < index).pop();
    if (h && h.param === first && !h.exported && callSites(text, h.name).length) { names.add(h.name); plumbing.add(index); }
  }
  return { names, plumbing };
}

function splitTopLevelArgs(s) {
  const args = [];
  let depth = 0, cur = '', inStr = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { cur += c; if (c === '\\') { cur += s[++i] || ''; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; cur += c; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; cur += c; continue; }
    if (c === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) args.push(cur);
  return args.map(a => a.trim());
}
function extractBalanced(text, openIdx) {
  let depth = 0, i = openIdx, inStr = null;
  const start = openIdx + 1;
  for (i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    else if (c === '(') depth++;
    else if (c === ')') { if (depth === 0) break; depth--; }
  }
  return { argsText: text.slice(start, i), endIdx: i };
}
function findCalls(text, re) {
  const out = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = g.exec(text))) {
    const openIdx = m.index + m[0].length - 1;
    const { argsText } = extractBalanced(text, openIdx);
    out.push({ match: m, argsText, index: m.index });
  }
  return out;
}
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

function importedFrom(text, ident) {
  const reqRe = new RegExp(`\\b(?:const|let|var)\\s*\\{?[^={]*\\b${ident}\\b[^={]*\\}?\\s*=\\s*require\\(\\s*(['"\`])(\\.[^'"\`]+)\\1\\s*\\)`);
  const m1 = reqRe.exec(text);
  if (m1) return m1[2];
  const impRe = new RegExp(`import\\s+[^;]*\\b${ident}\\b[^;]*\\bfrom\\s+(['"\`])(\\.[^'"\`]+)\\1`);
  const m2 = impRe.exec(text);
  return m2 ? m2[2] : null;
}
function resolveRelative(fromFile, relPath) {
  const base = path.resolve(path.dirname(fromFile), relPath);
  for (const cand of [base, base + '.ts', base + '.tsx', base + '.js', base + '.jsx', path.join(base, 'index.ts'), path.join(base, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}
function importedPackages(text) {
  const names = new Set();
  for (const m of text.matchAll(/import\s+[^'"`]*from\s+(['"`])([^'"`]+)\1/g)) names.add(m[2]);
  for (const m of text.matchAll(/^\s*import\s+(['"`])([^'"`]+)\1\s*;?/gm)) names.add(m[2]);
  for (const m of text.matchAll(/require\(\s*(['"`])([^'"`]+)\1\s*\)/g)) names.add(m[2]);
  return [...names].filter(n => !n.startsWith('.'));
}

// label overrides the default ('Uses' for data, 'Authenticates via' otherwise) where that would mislead
const CATALOGUE_TRIGGERS = {
  '@azure/msal-browser': { cat: 'ENTRA_ID', kind: 'sync', tech: 'MSAL' },
  '@azure/msal-node': { cat: 'ENTRA_ID', kind: 'sync', tech: 'MSAL' },
  '@newrelic/browser-agent': { cat: 'NEW_RELIC', kind: 'sync', tech: 'New Relic agent', label: 'Sends telemetry to' },
  newrelic: { cat: 'NEW_RELIC', kind: 'sync', tech: 'New Relic agent', label: 'Sends telemetry to' },
  applicationinsights: { cat: 'APPLICATION_INSIGHTS', kind: 'sync', tech: 'App Insights SDK', label: 'Sends telemetry to' },
  '@microsoft/applicationinsights-web': { cat: 'APPLICATION_INSIGHTS', kind: 'sync', tech: 'App Insights SDK', label: 'Sends telemetry to' },
  pg: { cat: 'POSTGRESQL', kind: 'data', tech: 'pg' },
  mysql2: { cat: 'MYSQL', kind: 'data', tech: 'mysql2' },
  mongodb: { cat: 'MONGO_DB', kind: 'data', tech: 'MongoDB driver' },
  mongoose: { cat: 'MONGO_DB', kind: 'data', tech: 'Mongoose' },
  ioredis: { cat: 'REDIS', kind: 'data', tech: 'ioredis' },
  redis: { cat: 'REDIS', kind: 'data', tech: 'redis' },
  '@azure/storage-blob': { cat: 'BLOB_STORAGE', kind: 'data', tech: 'Blob SDK' },
  '@azure/cosmos': { cat: 'COSMOS_DB', kind: 'data', tech: 'Cosmos SDK' },
  '@azure/keyvault-secrets': { cat: 'KEY_VAULT', kind: 'data', tech: 'Key Vault SDK' },
};

const FETCH_RE = /\bfetch\s*\(/g;
const AXIOS_RE = /\baxios\.(get|post|put|patch|delete)\s*\(/g;
const KY_RE = /\bky\.(get|post|put|patch|delete)\s*\(/g;
const WITHURL_RE = /\.withUrl\s*\(/g;
const SENDER_RE = /\bcreateSender\s*\(/g;
const RECEIVER_RE = /\b(?:createReceiver|subscribe)\s*\(/g;
const MEMBER_CALL_RE = /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
const BASE_RE = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:import\.meta\.env\.(\w+)|process\.env\.(\w+))\s*(?:\|\||\?\?)\s*(['"`])((?:(?!\4).)*)\4/;

async function scan(ctx, packages) {
  const { read, rel } = ctx;
  const files = [...new Set((packages || []).flatMap(p => p.files || []))].filter(f => /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(f));
  const elements = new Map();
  const add = (name, kind, tech) => { const k = keyOf(name); if (!elements.has(k)) elements.set(k, { name, kind, tech, evidence: [] }); return elements.get(k); };
  const consumes = [], provides = [], edges = [], unresolved = [];
  const addEdge = (from, to, kind, label, tech, evidence) => {
    let e = edges.find(x => x.from === from && x.to === to && x.kind === kind);
    if (!e) { e = { from, to, kind, label, tech, evidence: [] }; edges.push(e); }
    e.evidence.push(evidence);
  };

  const text = new Map();
  for (const f of files) text.set(f, await read(f));
  const ownerOf = f => { const p = (packages || []).find(p => (p.files || []).includes(f)); return p ? keyOf(p.name) : null; };

  // ---- wrapper modules: const base = import.meta.env.X (or process.env.X) || '<lit>', plus a
  // same-file `${base}${something}` template — the module's own fetch call is plumbing, not a
  // call site to report; real call sites are wherever the exported object is imported and used.
  const wrappers = new Map(); // file -> { exportName, base: { literal, env } }
  for (const f of files) {
    const t = text.get(f);
    const baseM = BASE_RE.exec(t);
    if (!baseM) continue;
    const [, varName, envA, envB, , literal] = baseM;
    const tmplRe = new RegExp('`\\$\\{\\s*' + varName + '\\s*\\}\\$\\{');
    if (!tmplRe.test(t)) continue;
    const expM = /export\s+const\s+(\w+)\s*=\s*\{/.exec(t);
    if (!expM) continue;
    wrappers.set(f, { exportName: expM[1], base: { literal, env: envA || envB } });
  }

  // ---- dev proxy targets from vite.config.*
  const proxies = [];
  for (const f of files) {
    if (!/vite\.config\.(ts|js|mjs)$/i.test(path.basename(f))) continue;
    const t = text.get(f);
    const proxyBlockM = /proxy\s*:\s*\{([\s\S]*?)\n\s*\}\s*,?\s*\n\s*\}/.exec(t);
    const block = proxyBlockM ? proxyBlockM[1] : t;
    const entryRe = /(['"`])([^'"`]+)\1\s*:\s*\{[^}]*?target\s*:\s*(?:process\.env\.\w+\s*\|\|\s*)?(['"`])([^'"`]+)\3/g;
    let m;
    while ((m = entryRe.exec(block))) proxies.push({ prefix: m[2], target: m[4] });
  }
  const devTargetFor = key => { const p = proxies.find(p => key.startsWith(p.prefix)); return p ? p.target : undefined; };

  const pushHttpConsume = (owner, resolved, env, evidence) => {
    const local = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?(\/[^?#]*)?/i.exec(resolved);
    if (local) {
      // a local service, not an external system: link by path like a relative call; the port breaks ties
      const c = { owner, kind: 'http', key: normaliseRoute(local[2] || '/'), evidence };
      if (local[1]) c.devTarget = `http://localhost:${local[1]}`;
      consumes.push(c);
      return;
    }
    if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
      let u; try { u = new URL(resolved); } catch { unresolved.push({ where: owner, what: `call target "${resolved}" is not a valid URL`, ...evidence }); return; }
      const ext = add(u.hostname, 'external', 'External HTTP API'); ext.evidence.push(evidence);
      addEdge(owner, keyOf(u.hostname), 'sync', 'Calls', 'HTTPS', evidence);
      return;
    }
    if (!resolved.startsWith('/')) { unresolved.push({ where: owner, what: `call target "${resolved}" is not a recognisable path`, ...evidence }); return; }
    const key = normaliseRoute(resolved);
    const c = { owner, kind: 'http', key, evidence };
    if (env) c.env = env;
    const dt = devTargetFor(key);
    if (dt) c.devTarget = dt;
    consumes.push(c);
  };

  for (const f of files) {
    const t = text.get(f);
    const owner = ownerOf(f);
    if (!owner) continue;
    const isWrapper = wrappers.has(f);

    // direct fetch/axios/ky calls (skip the wrapper module's own plumbing call)
    if (!isWrapper) {
      const consts = stringConsts(t);
      const fetchCalls = findCalls(t, FETCH_RE);
      const local = fetchWrappers(t, fetchCalls);
      for (const { argsText, index } of fetchCalls) {
        if (local.plumbing.has(index)) continue;
        const firstArg = splitTopLevelArgs(argsText)[0] || '';
        const resolved = resolvePathExpr(inlineConsts(firstArg, consts));
        const evidence = { file: rel(f), line: lineOf(t, index), text: t.split('\n')[lineOf(t, index) - 1].trim().slice(0, 200) };
        if (resolved === null) { unresolved.push({ where: owner, what: 'fetch() argument is not a literal, template or resolvable concatenation', ...evidence }); continue; }
        pushHttpConsume(owner, resolved, null, evidence);
      }
      for (const name of local.names) {
        for (const { argsText, index } of callSites(t, name)) {
          const firstArg = splitTopLevelArgs(argsText)[0] || '';
          const resolved = resolvePathExpr(inlineConsts(firstArg, consts));
          const evidence = { file: rel(f), line: lineOf(t, index), text: t.split('\n')[lineOf(t, index) - 1].trim().slice(0, 200) };
          if (resolved === null) { unresolved.push({ where: owner, what: `${name}() argument is not a literal, template or resolvable concatenation`, ...evidence }); continue; }
          pushHttpConsume(owner, resolved, null, evidence);
        }
      }
      for (const re of [AXIOS_RE, KY_RE]) {
        for (const { argsText, index } of findCalls(t, re)) {
          const firstArg = splitTopLevelArgs(argsText)[0] || '';
          const resolved = resolvePathExpr(inlineConsts(firstArg, consts));
          const evidence = { file: rel(f), line: lineOf(t, index), text: t.split('\n')[lineOf(t, index) - 1].trim().slice(0, 200) };
          if (resolved === null) { unresolved.push({ where: owner, what: 'call argument is not a literal, template or resolvable concatenation', ...evidence }); continue; }
          pushHttpConsume(owner, resolved, null, evidence);
        }
      }
    }

    // SignalR hub connections
    for (const { argsText, index } of findCalls(t, WITHURL_RE)) {
      const evidence = { file: rel(f), line: lineOf(t, index), text: t.split('\n')[lineOf(t, index) - 1].trim().slice(0, 200) };
      const trimmed = argsText.trim();
      const lit = matchStringLiteral(trimmed) ?? matchTemplateLiteral(trimmed);
      const envM = /^import\.meta\.env\.(\w+)$/.exec(trimmed) || /^process\.env\.(\w+)$/.exec(trimmed);
      if (lit !== null) consumes.push({ owner, kind: 'hub', key: normaliseRoute(lit), evidence });
      else if (envM) consumes.push({ owner, kind: 'hub', key: null, env: envM[1], evidence });
      else unresolved.push({ where: owner, what: 'withUrl() argument is not a literal or a traceable env var', ...evidence });
    }

    // Azure Service Bus
    for (const { argsText, index } of findCalls(t, SENDER_RE)) {
      const lit = matchStringLiteral(splitTopLevelArgs(argsText)[0] || '');
      const evidence = { file: rel(f), line: lineOf(t, index), text: t.split('\n')[lineOf(t, index) - 1].trim().slice(0, 200) };
      if (lit !== null) consumes.push({ owner, kind: 'queue', key: lit, evidence });
      else unresolved.push({ where: owner, what: 'createSender() queue name is not a literal', ...evidence });
    }
    for (const { argsText, index } of findCalls(t, RECEIVER_RE)) {
      const lit = matchStringLiteral(splitTopLevelArgs(argsText)[0] || '');
      const evidence = { file: rel(f), line: lineOf(t, index), text: t.split('\n')[lineOf(t, index) - 1].trim().slice(0, 200) };
      if (lit !== null) provides.push({ owner, kind: 'queue', key: lit, evidence });
    }

    // wrapper calls: <ident>.<method>(<args>) where <ident> imports a known wrapper module
    for (const { match, argsText, index } of findCalls(t, MEMBER_CALL_RE)) {
      const [, recv, method] = match;
      if (['axios', 'ky'].includes(recv)) continue;
      if (['withUrl', 'createSender', 'createReceiver', 'subscribe'].includes(method)) continue;
      const relPath = importedFrom(t, recv);
      if (!relPath) continue;
      const target = resolveRelative(f, relPath);
      if (!target || !wrappers.has(target)) continue;
      const wrapper = wrappers.get(target);
      const firstArg = splitTopLevelArgs(argsText)[0] || '';
      const pathPart = resolvePathExpr(firstArg);
      const evidence = { file: rel(f), line: lineOf(t, index), text: t.split('\n')[lineOf(t, index) - 1].trim().slice(0, 200) };
      if (pathPart === null) { unresolved.push({ where: owner, what: `${recv}.${method}() argument is not a literal, template or resolvable concatenation`, ...evidence }); continue; }
      pushHttpConsume(owner, wrapper.base.literal + pathPart, wrapper.base.env, evidence);
    }

    // catalogue: shared external/store SDKs, triggered by importing the package
    for (const pkg of importedPackages(t)) {
      const trig = CATALOGUE_TRIGGERS[pkg];
      if (!trig) continue;
      const entry = catalogue[trig.cat];
      const el = add(entry.name, entry.kind, trig.tech);
      const lineIdx = t.split('\n').findIndex(l => l.includes(pkg));
      const evidence = { file: rel(f), line: lineIdx >= 0 ? lineIdx + 1 : 1, text: (t.split('\n')[lineIdx] || '').trim().slice(0, 200) };
      el.evidence.push(evidence);
      addEdge(owner, keyOf(entry.name), trig.kind, trig.label || (trig.kind === 'data' ? 'Uses' : 'Authenticates via'), trig.tech, evidence);
    }
  }

  return { elements: [...elements.values()], edges, consumes, provides, unresolved };
}

module.exports = { scan };
