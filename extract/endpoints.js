'use strict';
// facts.endpoints: one node per HTTP endpoint (verb, route, where) and its handler, an inline span or a named type.
// The scanners (csharp.js, js.js) report each route they find as a site {owner, route, method, via, type?, evidence};
// this module turns sites into nodes, finds the handler span in the source with the bracket matcher on a text whose
// comments and string contents are blanked, and resolves names against the code types of the same container.
// What it cannot read becomes an unresolved row, never a guess. Pure apart from `read`.
const { matchClose } = require('./code-util.js');
const { blankComments } = require('./csharp.js');

const keyOf = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const exact = s => String(s).replace(/[^A-Za-z0-9]/g, '');
const CALL_CS = /\b\w+\.(?:MapGet|MapPost|MapPut|MapPatch|MapDelete|MapMethods)\s*\(/;
const CALL_JS = /\b\w+\.(?:get|post|put|patch|delete|all)\s*\(/;
const NAME_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

// JS/TS text with comments and the inside of string and template literals blanked; offsets and newlines kept.
function blankJs(text) {
  let out = '', i = 0;
  const sp = c => (c === '\n' ? '\n' : ' ');
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i++; } }
    else if (c === '/' && n === '*') { while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { out += sp(text[i]); i++; } out += '  '; i += 2; }
    else if (c === '"' || c === "'" || c === '`') {
      out += c; i++;
      while (i < text.length && text[i] !== c && (text[i] !== '\n' || c === '`')) {
        if (text[i] === '\\') { out += ' ' + sp(text[i + 1] || ''); i += 2; } else { out += sp(text[i]); i++; }
      }
      if (text[i] === c) { out += c; i++; }
    } else { out += c; i++; }
  }
  return out;
}

const topArgs = inner => {
  const out = []; let depth = 0, from = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) { out.push(inner.slice(from, i)); from = i + 1; }
  }
  out.push(inner.slice(from));
  return out;
};

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// sites, elements (key -> {name}), components [{id, container, files}], types and typeEdges (extract/code.js), read(file).
// -> { endpoints, unresolved }
async function build({ sites, elements, components, types, typeEdges, read }) {
  const unresolved = [];
  const nameOf = k => (elements.get(k) || { name: String(k) }).name;
  const docs = new Map();
  const doc = async file => {
    if (docs.has(file)) return docs.get(file);
    const text = await read(file);
    const code = /\.(cs|fs)$/i.test(file) ? blankComments(text, true) : blankJs(text);
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    const d = { code, starts, lineOf: idx => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; } return lo + 1; } };
    docs.set(file, d);
    return d;
  };

  const byContainer = new Map(); // container name -> [type]
  for (const t of types) (byContainer.get(t.container) || byContainer.set(t.container, []).get(t.container)).push(t);
  const typeById = new Map(types.map(t => [t.id, t]));
  const edgesFrom = new Map();
  for (const e of typeEdges) (edgesFrom.get(e.from) || edgesFrom.set(e.from, []).get(e.from)).push(e.to);

  // the same method and route twice in one container: reported, and neither is a node
  const groups = new Map();
  for (const s of sites) {
    const k = `${s.owner}|${s.method || 'ANY'}|${s.route}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(s);
  }
  const kept = [];
  for (const g of groups.values()) {
    if (g.length === 1) { kept.push(g[0]); continue; }
    const s = g[0];
    unresolved.push({ where: nameOf(s.owner), what: `${s.method || 'ANY'} ${s.route} is declared ${g.length} times in this container, so it is not an endpoint node`, file: s.evidence.file, line: s.evidence.line, text: s.evidence.text });
  }
  kept.sort((a, b) => nameOf(a.owner).localeCompare(nameOf(b.owner)) || (a.route < b.route ? -1 : a.route > b.route ? 1 : 0) || String(a.method).localeCompare(String(b.method)));

  const warned = new Set();
  const typeNamed = (container, name) => (byContainer.get(container) || []).filter(t => t.kind !== 'module' && exact(t.name) === exact(name));
  const named = (container, t) => {
    const f = t.files[0];
    return { kind: 'named', node: `${container}/${t.name}`, file: f.file, line: f.line, endLine: f.endLine, uses: [...new Set(edgesFrom.get(t.id) || [])].filter(id => typeById.has(id)).sort() };
  };

  const used = new Set();
  const endpoints = [];
  for (const s of kept) {
    const container = nameOf(s.owner), verb = s.method || 'ANY';
    const node = `${container}/${verb} ${s.route}`;
    const base = `p_${keyOf(container)}_${verb.toLowerCase()}_${slug(s.route) || 'root'}`; // two routes can share a slug: /a-b and /a/b
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    const at = { where: container, file: s.evidence.file, line: s.evidence.line, text: s.evidence.text };
    const bad = what => { unresolved.push({ ...at, what }); return null; };
    if (s.method == null) unresolved.push({ ...at, what: `the HTTP method of ${s.route} could not be read (any verb or several), so it is listed as ANY` });
    const comps = components.filter(c => c.container === container && c.files.includes(s.evidence.file));
    let handler = null;
    if (s.via === 'type') {
      const c = s.type ? typeNamed(container, s.type) : [];
      if (c.length === 1) handler = named(container, c[0]);
      else bad(`handler of ${verb} ${s.route}: ${s.type ? `type "${s.type}" is ${c.length ? 'declared more than once' : 'not a code type'} in this container` : 'no enclosing type was found'}, so no handler node was made`);
    } else {
      handler = await callHandler(s, container, node, bad);
    }
    endpoints.push({
      id, node, container, component: comps.length === 1 ? comps[0].id : null, method: s.method || null, route: s.route,
      evidence: { file: s.evidence.file, line: s.evidence.line }, handler,
    });
  }

  async function callHandler(s, container, node, bad) {
    const d = await doc(s.evidence.file);
    const isCs = /\.(cs|fs)$/i.test(s.evidence.file), isFs = /\.fs$/i.test(s.evidence.file);
    const from = d.starts[s.evidence.line - 1] ?? 0, to = d.starts[s.evidence.line] ?? d.code.length;
    const m = (isCs ? CALL_CS : CALL_JS).exec(d.code.slice(from, to));
    if (!m) return bad(`handler of ${s.method || 'ANY'} ${s.route}: the route call was not found at this line, so no handler node was made`);
    const open = from + m.index + m[0].length - 1, close = matchClose(d.code, open, '(', ')');
    if (close < 0) return bad(`handler of ${s.method || 'ANY'} ${s.route}: the call has no closing parenthesis, so no handler node was made`);
    const inner = d.code.slice(open + 1, close);
    const rest = topArgs(inner).slice(1);
    const lambda = isFs ? /=>|->|\bfun\b|\bfunction\b|\bdelegate\b/ : /=>|\bfunction\b|\bdelegate\b/;
    if (rest.some(a => lambda.test(a))) {
      const uses = new Set();
      for (const im of inner.matchAll(/(?<![.\w$@])([A-Za-z_$][\w$]*)/g)) {
        const c = typeNamed(container, im[1]);
        if (c.length === 1) uses.add(c[0].id);
        else if (c.length > 1) {
          const w = `${container}|${im[1]}`;
          if (!warned.has(w)) { warned.add(w); unresolved.push({ where: container, what: `handler of ${s.method || 'ANY'} ${s.route} uses "${im[1]}", which is declared ${c.length} times in this container, so it was not linked`, file: s.evidence.file, line: s.evidence.line, text: s.evidence.text }); }
        }
      }
      return { kind: 'inline', node: `${node}#handler`, file: s.evidence.file, line: s.evidence.line, endLine: d.lineOf(close), uses: [...uses].sort() };
    }
    const last = (rest[rest.length - 1] || '').trim();
    if (!NAME_CHAIN.test(last)) return bad(`handler of ${s.method || 'ANY'} ${s.route} is neither a lambda nor a plain name, so no handler node was made`);
    const parts = last.split('.'), method = parts.pop(), qual = parts.pop();
    const holders = (byContainer.get(container) || []).filter(t => t.methods.some(x => x.name === method) && (!qual || keyOf(t.name) === keyOf(qual)));
    if (holders.length !== 1) return bad(`handler of ${s.method || 'ANY'} ${s.route} is "${last}", which is ${holders.length ? `a method of ${holders.length} types` : 'a method of no code type'} in this container, so no handler node was made`);
    return named(container, holders[0]);
  }

  return { endpoints, unresolved };
}

module.exports = { build };
