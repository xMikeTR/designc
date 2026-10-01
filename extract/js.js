// JS/TS package discovery (SPA and Node API deployables, plus libraries) and the HTTP routes
// Node APIs provide. Outbound calls (extract/js-calls.js) are a separate pass.
const fs = require('fs');
const path = require('path');
const jsCalls = require('./js-calls');

const SPA_TRIGGERS = ['vite', 'next', 'react-scripts', '@angular/core', 'vue', 'svelte'];
const NODE_TRIGGERS = ['express', 'fastify', 'koa', '@nestjs/core', 'hono'];
const SRC_RE = /\.(js|jsx|ts|tsx|mjs|cjs)$/i;
const keyOf = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function spaTech(deps) {
  if ('next' in deps) return 'Next.js';
  if ('react-scripts' in deps) return 'React SPA (CRA)';
  if ('@angular/core' in deps) return 'Angular SPA';
  const bundler = 'vite' in deps ? ' (Vite)' : '';
  if ('vue' in deps) return `Vue SPA${bundler}`;
  if ('svelte' in deps) return `Svelte SPA${bundler}`;
  if ('react' in deps) return `React SPA${bundler}`;
  return `SPA${bundler}`;
}
function nodeTech(deps) {
  if ('express' in deps) return 'Node.js (Express)';
  if ('fastify' in deps) return 'Node.js (Fastify)';
  if ('koa' in deps) return 'Node.js (Koa)';
  if ('@nestjs/core' in deps) return 'Node.js (NestJS)';
  return 'Node.js (Hono)';
}

// lowercase; collapse '//'; strip trailing '/'; every parameter form becomes '{}'
function normaliseRoute(r) {
  let s = String(r).toLowerCase();
  s = s.replace(/\$\{[^}]*\}/g, '{}');
  s = s.replace(/'\s*\+\s*\w+\s*\+\s*'/g, '{}');
  s = s.replace(/:[a-z0-9_]+/g, '{}');
  s = s.replace(/\{[^}]*\}/g, '{}');
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}

const ROUTE_RE = /\b\w+\.(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]+)\2/;
const USE_RE = /\b\w+\.use\(\s*(['"`])([^'"`]+)\1\s*,\s*([\w.]+)\s*\)/;
function importSource(text, id) {
  const re = new RegExp(`\\b(?:const|let|var)\\s*\\{?[^={]*\\b${id}\\b[^={]*\\}?\\s*=\\s*require\\(\\s*(['"\`])(\\.[^'"\`]+)\\1\\s*\\)|import\\s+[^;]*\\b${id}\\b[^;]*\\s+from\\s+(['"\`])(\\.[^'"\`]+)\\3`);
  const m = re.exec(text);
  return m && (m[2] || m[4]);
}
function resolveRelative(fromFile, relPath) {
  const base = path.resolve(path.dirname(fromFile), relPath);
  for (const cand of [base, base + '.js', base + '.ts', base + '.jsx', base + '.tsx', path.join(base, 'index.js'), path.join(base, 'index.ts')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

async function routesInFile(file, prefix, owner, read, rel, provides) {
  const text = await read(file);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = ROUTE_RE.exec(line);
    if (!m) return;
    const full = prefix ? `${prefix}${m[3].startsWith('/') ? '' : '/'}${m[3]}` : m[3];
    provides.push({ owner, kind: 'http', key: normaliseRoute(full), evidence: { file: rel(file), line: i + 1, text: line.trim().slice(0, 200) } });
  });
}

async function scan(ctx) {
  const { files, rel, read } = ctx;
  const pkgFiles = files.filter(f => path.basename(f) === 'package.json');
  const pkgDefs = [];
  for (const f of pkgFiles) {
    let json;
    try { json = JSON.parse(await read(f)); } catch { continue; }
    const dir = path.dirname(f);
    const deps = { ...(json.dependencies || {}), ...(json.devDependencies || {}) };
    const name = json.name || path.basename(dir);
    let kind = 'library', tech = null;
    if (NODE_TRIGGERS.some(t => t in deps)) { kind = 'node-api'; tech = nodeTech(deps); }
    else if (SPA_TRIGGERS.some(t => t in deps)) { kind = 'spa'; tech = spaTech(deps); }
    if (kind !== 'library' && (fs.existsSync(path.join(dir, 'staticwebapp.config.json')) || fs.existsSync(path.join(dir, 'public', 'staticwebapp.config.json')))) tech += ', Static Web App';
    pkgDefs.push({ key: keyOf(name), name, dir, kind, deps: Object.keys(deps), tech, file: f, files: [], ports: [] });
  }
  if (!pkgDefs.length) return { projects: [], elements: [], edges: [], consumes: [], provides: [], unresolved: [] };

  const byDepth = pkgDefs.slice().sort((a, b) => b.dir.length - a.dir.length);
  for (const f of files.filter(f => SRC_RE.test(f))) {
    const p = byDepth.find(p => f.startsWith(p.dir + path.sep)); if (p) p.files.push(f);
  }
  const units = [];
  for (const p of pkgDefs.filter(p => p.kind !== 'library')) for (const f of p.files) units.push({ owner: p.key, file: rel(f), relFromRoot: path.relative(p.dir, f).split(path.sep).join('/'), evidence: { file: rel(f), line: 1, text: path.basename(f) } });

  for (const p of pkgDefs) {
    if (p.kind === 'spa') {
      for (const cfgName of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
        const cfgFile = path.join(p.dir, cfgName);
        if (fs.existsSync(cfgFile)) {
          const m = /server\s*:\s*\{[^}]*\bport\s*:\s*(\d+)/s.exec(await read(cfgFile));
          if (m) p.ports = [m[1]];
          break;
        }
      }
    } else if (p.kind === 'node-api') {
      for (const f of p.files) {
        const m = /\.listen\(\s*(\d+)/.exec(await read(f));
        if (m) { p.ports = [m[1]]; break; }
      }
    }
  }

  const elements = new Map();
  const add = (p) => { const k = keyOf(p.name); if (!elements.has(k)) elements.set(k, { name: p.name, kind: 'container', tech: p.tech, evidence: [], project: rel(p.file), role: p.kind, ports: p.ports }); return elements.get(k); };
  for (const p of pkgDefs) {
    if (p.kind === 'library') continue;
    const el = add(p);
    el.evidence.push({ file: rel(p.file), line: 1, text: `package.json: ${p.kind === 'spa' ? 'SPA' : 'Node API'} (${p.deps.join(', ')})` });
  }

  const projects = pkgDefs.map(p => ({ name: p.name, kind: p.kind === 'library' ? 'library' : p.kind === 'spa' ? 'app' : 'web', lang: p.files.some(f => /\.tsx?$/i.test(f)) ? 'TS' : 'JS', file: rel(p.file), sources: p.files.length }));

  const provides = [];
  for (const p of pkgDefs) {
    if (p.kind !== 'node-api') continue;
    const mountedFiles = new Set();
    for (const f of p.files) {
      const text = await read(f);
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const useM = USE_RE.exec(lines[i]);
        if (!useM) continue;
        const [, , prefix, routerId] = useM;
        const relPath = importSource(text, routerId);
        if (!relPath) continue;
        const target = resolveRelative(f, relPath);
        if (target) { await routesInFile(target, prefix, keyOf(p.name), read, rel, provides); mountedFiles.add(target); }
      }
    }
    for (const f of p.files) {
      if (mountedFiles.has(f)) continue;
      await routesInFile(f, '', keyOf(p.name), read, rel, provides);
    }
  }
  // dedup as a safety net in case two mounts ever resolve to the same route
  const seen = new Set();
  const dedupedProvides = [];
  for (const p of provides) { const k = p.owner + '|' + p.key; if (seen.has(k)) continue; seen.add(k); dedupedProvides.push(p); }

  const calls = await jsCalls.scan(ctx, pkgDefs.map(p => ({ key: p.key, name: p.name, dir: p.dir, kind: p.kind, deps: p.deps, files: p.files })));

  return {
    projects,
    elements: [...elements.values(), ...calls.elements],
    edges: [...calls.edges],
    consumes: [...calls.consumes],
    provides: [...dedupedProvides, ...calls.provides],
    units,
    unresolved: [...calls.unresolved],
  };
}

module.exports = { id: 'js', scan };
