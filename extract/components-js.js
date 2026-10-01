// Component assignment and import edges for JS/TS units. The scanner roots units at a package's src/
// when it has one.
//   rule 5  files directly in root are 'App shell'.
//   rule 6  support folders (types, constants, styles, assets, test, tests, mocks, __mocks__) are 'Shared'.
//   rule 7  a grouping folder (features, modules, domains) as the first folder steps down one level:
//           root/features/orders/** is 'orders', files directly in root/features are 'features'.
//   rule 8  otherwise the first folder under root names the component.
// Layer (d): import/require/dynamic import between the files of one owner's units, resolved only when
// the target is one of those files (relative, tsconfig paths, or a workspace library package by name).
const path = require('path');

const SUPPORT = new Set(['types', 'constants', 'styles', 'assets', 'test', 'tests', 'mocks', '__mocks__']);
const GROUPING = new Set(['features', 'modules', 'domains']);

function assign(unit) {
  const segs = unit.relFromRoot.split('/').filter(Boolean);
  if (segs.length <= 1) return { name: 'App shell', basis: 'app-shell', evidence: unit.evidence };
  const first = segs[0].toLowerCase();
  if (SUPPORT.has(first)) return { name: 'Shared', basis: 'shared', evidence: unit.evidence };
  if (GROUPING.has(first)) {
    if (segs.length === 2) return { name: segs[0], basis: 'first-folder', evidence: unit.evidence };
    return { name: segs[1], basis: 'first-folder', evidence: unit.evidence };
  }
  return { name: segs[0], basis: 'first-folder', evidence: unit.evidence };
}

// comments blanked to spaces (newlines and offsets kept); string and template literals respected
function blankJsComments(text) {
  let out = '', i = 0, q = null;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (q) {
      out += c;
      if (c === '\\') { out += text[i + 1] || ''; i += 2; continue; }
      if (c === q) q = null;
      i++;
    } else if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i++; } }
    else if (c === '/' && n === '*') {
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { out += text[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
    } else { if (c === '"' || c === "'" || c === '`') q = c; out += c; i++; }
  }
  return out;
}

const SPEC_RES = [
  /\bimport\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?(['"])([^'"\n]+)\1/g,
  /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s+from\s+(['"])([^'"\n]+)\1/g,
  /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
];
const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

// tsconfig "paths" of the package that owns `root` (the src dir or the package dir): [{ prefix, targets, star }]
async function pathAliases(root, read) {
  const pkgDir = path.posix.basename(root) === 'src' ? path.posix.dirname(root) : root;
  let text; try { text = await read(path.posix.join(pkgDir, 'tsconfig.json')); } catch { return []; }
  let cfg; try { cfg = JSON.parse(blankJsComments(text).replace(/,(\s*[}\]])/g, '$1')); } catch { return []; }
  const co = (cfg && cfg.compilerOptions) || {};
  const base = path.posix.join(pkgDir, co.baseUrl || '.');
  return Object.entries(co.paths || {}).map(([k, v]) => ({ star: k.endsWith('*'), prefix: k.replace(/\*$/, ''), targets: v.map(t => path.posix.join(base, t.replace(/\*$/, ''))) }));
}

async function edges(ctx) {
  const refs = [], owners = new Map();
  for (const u of ctx.units) {
    if (!/\.[cm]?[jt]sx?$/i.test(u.file)) continue;
    for (const o of u.owners) { if (!owners.has(o)) owners.set(o, []); owners.get(o).push(u); }
  }
  for (const [owner, units] of owners) {
    const have = new Set(units.map(u => u.file));
    const libs = new Map(); // workspace library package name -> one of its files
    for (const u of units) if (u.projectKind === 'library' && !libs.has(u.project)) libs.set(u.project, u.file);
    const aliases = new Map();
    const find = base => EXTS.map(e => base + e).find(f => have.has(f));
    for (const u of units) {
      if (!aliases.has(u.root)) aliases.set(u.root, await pathAliases(u.root, ctx.read));
      const text = await ctx.read(u.file), code = blankJsComments(text), lines = text.split(/\r?\n/);
      const resolve = spec => {
        if (spec.startsWith('.')) return find(path.posix.join(path.posix.dirname(u.file), spec));
        for (const a of aliases.get(u.root)) {
          if (!(a.star ? spec.startsWith(a.prefix) : spec === a.prefix)) continue;
          for (const t of a.targets) { const hit = find(a.star ? path.posix.join(t, spec.slice(a.prefix.length)) : t); if (hit) return hit; }
        }
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        return libs.get(name);
      };
      for (const re of SPEC_RES) for (const m of code.matchAll(re)) {
        const to = resolve(m[2]); if (!to || to === u.file) continue;
        const line = code.slice(0, m.index).split('\n').length;
        refs.push({ owner, from: u.file, to, via: 'import', evidence: [{ file: u.file, line, text: lines[line - 1].trim().slice(0, 200) }] });
      }
    }
  }
  return { refs, unresolved: [] };
}

module.exports = { assign, edges };
