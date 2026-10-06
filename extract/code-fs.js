'use strict';
// F# code-level scanner: modules, records, unions, classes and interfaces, their let functions and members with
// cyclomatic complexity and size, and the type and module names each one refers to.
// Pure: scan(file, text) -> {types}. Pattern-based and offside-rule aware (a block ends at the next line that is
// indented no further than its header), so it states its limits instead of guessing: functions nested inside
// another function are part of it, a `let` bound to a lambda is a value, not a function, a type header must keep its
// `=` on the first line, and a reference is only a name (extract/code.js resolves it).
const { count } = require('./code-util.js');

// comments (// and nested (* *)) and the contents of strings become spaces; newlines and length are kept
function blank(text) {
  let out = '', i = 0, depth = 0;
  const pad = c => (c === '\n' ? '\n' : ' ');
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (depth > 0) {
      if (c === '(' && n === '*') { depth++; out += '  '; i += 2; }
      else if (c === '*' && n === ')') { depth--; out += '  '; i += 2; }
      else { out += pad(c); i++; }
    } else if (c === '(' && n === '*' && text[i + 2] !== ')') { depth = 1; out += '  '; i += 2; }
    else if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i++; } }
    else if (c === '"') {
      const triple = text.startsWith('"""', i), verbatim = !triple && text[i - 1] === '@';
      const close = triple ? '"""' : '"';
      out += triple ? '   ' : ' '; i += close.length;
      while (i < text.length && !text.startsWith(close, i)) {
        if (verbatim && text[i] === '"' && text[i + 1] === '"') { out += '  '; i += 2; continue; }
        if (!triple && !verbatim && text[i] === '\\') { out += ' '; i++; }
        out += pad(text[i]); i++;
      }
      out += ' '.repeat(Math.min(close.length, text.length - i)); i += close.length;
    } else { out += c; i++; }
  }
  return out;
}

function complexity(b) {
  return 1
    + count(b, /\b(?:if|elif|while|for|when)\b/g)
    + count(b, /&&|\|\|/g)
    + count(b, /(?<![|<\[])\|(?![|>\]])/g)
    - count(b, /(?<![|<\[])\|\s*_\s*->/g);
}

const RANK = { uses: 1, new: 2, inherits: 3 };
const LET = /^let\s+(?:(?:rec|inline|private|internal|public)\s+)*([A-Za-z_]\w*)(?![\w'])\s*(?:<[^<>=]*>)?\s*(?=[(_a-z'])/;
const MEMBER = /^(?:static\s+)?(?:member|override|default)\s+(?:(?:inline|private|internal|public)\s+)*(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)(?![\w'])\s*(?:<[^<>=]*>)?\s*(?=[(_a-z'])(?!with\b)/;
const TYPE = /^type\s+(?:(?:private|internal|public)\s+)?([A-Za-z_]\w*)/;
const MODULE = /^module\s+(?:(?:private|internal|public|rec)\s+)*([\w.]+)\s*(=)?\s*$/;

function scan(file, text) {
  if (!/\.fsi?$/i.test(file) || /\.fsi$/i.test(file)) return { types: [] };
  const code = blank(text);
  const lines = code.split('\n').map((t, k) => ({ n: k + 1, t, ind: t.length - t.trimStart().length, s: t.trim() }));
  const types = [];
  const lastNonBlank = (a, z) => { let j = z; while (j > a && !lines[j].s) j--; return j; };
  // end index (inclusive) of the block headed by line i
  const extent = (i, limit) => {
    let j = i + 1;
    while (j < limit && (!lines[j].s || lines[j].ind > lines[i].ind)) j++;
    return lastNonBlank(i, j - 1);
  };
  const measure = (name, a, z) => ({ name, file, line: lines[a].n, endLine: lines[z].n, cc: complexity(lines.slice(a, z + 1).map(l => l.t).join('\n')), lines: lines[z].n - lines[a].n + 1 });
  const kindOf = (i, z) => {
    const eq = lines[i].s.indexOf('=');
    let rest = eq < 0 ? '' : lines[i].s.slice(eq + 1).trim();
    let j = i;
    if (!rest) { j = i + 1; while (j <= z && !lines[j].s) j++; rest = j <= z ? lines[j].s : ''; }
    const body = lines.slice(i + 1, z + 1).filter(l => l.s);
    if (rest.startsWith('{')) return 'record';
    if (rest.startsWith('|') || /^[A-Z]\w*\s+of\b/.test(rest)) return 'union';
    if (/^interface\b/.test(rest) || (body.length && body.every(l => /^abstract\b/.test(l.s)))) return 'interface';
    if (/^(?:abstract|inherit|member|static|new|let|override|interface|default)\b/.test(rest) || /\(/.test(lines[i].s.split('=')[0]) || body.some(l => /^(?:member|static member|new|inherit|override)\b/.test(l.s))) return 'class';
    if (!body.length && !/^\w+\s*[=<(]/.test(rest) && /^[A-Za-z_][\w.<>,'\s\[\]*->]*$/.test(rest)) return null; // an abbreviation: type Id = string
    return body.length ? 'class' : null;
  };

  // Walks the declarations directly inside lines [a, z] at the first content indent; collects the let functions of
  // the surrounding module into `own` and returns the ranges of the nested declarations (their lines belong to them).
  const region = (a, z, own, ownerName) => {
    const nested = [];
    let first = a; while (first <= z && !lines[first].s) first++;
    if (first > z) return nested;
    const ind = lines[first].ind;
    for (let i = first; i <= z; i++) {
      const l = lines[i];
      if (!l.s || l.ind !== ind) continue;
      let m;
      if ((m = MODULE.exec(l.s)) && m[2]) {
        const e = extent(i, z + 1), mine = [];
        const inner = region(i + 1, e, mine, m[1]);
        types.push({ name: m[1], kind: 'module', a: i, z: e, methods: mine, nested: inner });
        nested.push([i, e]); i = e;
      } else if ((m = TYPE.exec(l.s)) && l.s.includes('=')) {
        const e = extent(i, z + 1), kind = kindOf(i, e);
        if (kind) {
          const methods = [];
          const memberRegion = (from, to) => {
            let f = from; while (f <= to && !lines[f].s) f++;
            if (f > to) return;
            for (let k = f; k <= to; k++) {
              const ml = lines[k];
              if (!ml.s || ml.ind !== lines[f].ind) continue;
              let mm;
              if (/^new\b/.test(ml.s) && /^new\s*\(/.test(ml.s)) { methods.push(measure('new', k, extent(k, to + 1))); k = extent(k, to + 1); }
              else if ((mm = MEMBER.exec(ml.s))) { const x = extent(k, to + 1); methods.push(measure(mm[1], k, x)); k = x; }
              else if (/^interface\b.*\bwith\s*$/.test(ml.s)) { const x = extent(k, to + 1); memberRegion(k + 1, x); k = x; }
            }
          };
          memberRegion(i + 1, e);
          types.push({ name: m[1], kind, a: i, z: e, methods, nested: [] });
        }
        nested.push([i, e]); i = e;
      } else if (ownerName != null && (m = LET.exec(l.s))) {
        const e = extent(i, z + 1); own.push(measure(m[1], i, e)); i = e;
      } else if (ownerName != null && /^let\b/.test(l.s)) i = extent(i, z + 1);
    }
    return nested;
  };

  // top level: an optional `module A.B` header, then declarations at column of the first line after it
  const last = lastNonBlank(0, lines.length - 1);
  let headerIdx = lines.findIndex(l => l.s && !/^(?:namespace|open|#|\[<)/.test(l.s));
  let fileName = null;
  if (headerIdx >= 0) { const h = MODULE.exec(lines[headerIdx].s); if (h && !h[2]) fileName = { name: h[1].split('.').pop(), line: headerIdx }; }
  const loose = [];
  const topNested = region(0, last, loose, '');
  if (fileName || loose.length) {
    const name = fileName ? fileName.name : (file.split(/[\\/]/).pop().replace(/\.fsx?$/i, '') || 'Module');
    const a = fileName ? fileName.line : loose[0].line - 1;
    const endLine = loose.length ? loose[loose.length - 1].endLine : lines[a].n;
    types.unshift({ name, kind: 'module', a: Math.min(a, loose.length ? loose[0].line - 1 : a), z: lines.findIndex(l => l.n === endLine), methods: loose, nested: topNested, file: true });
  }

  // references: from each declaration's own lines (nested declarations excluded)
  const out = types.map(t => {
    const own = [];
    const skip = new Set();
    for (const [x, y] of t.nested) for (let k = x; k <= y; k++) skip.add(k);
    for (let k = t.a; k <= t.z; k++) if (!skip.has(k)) own.push({ k, s: lines[k].t });
    const refs = new Map();
    const add = (name, via, k, module) => {
      if (name === t.name && !module) return;
      if (name === t.name) return;
      const key = name + (module ? '#m' : '');
      const cur = refs.get(key);
      if (!cur || RANK[via] > RANK[cur.via]) refs.set(key, { name, via, line: cur && cur.line < lines[k].n ? cur.line : lines[k].n, ...(module ? { module: true } : {}) });
    };
    for (const { k, s } of own) {
      let m;
      const open = /^\s*open\s+([\w.]+)/.exec(s);
      if (open) { if (t.file) add(open[1].split('.').pop(), 'uses', k, true); continue; }
      if (/^\s*(?:namespace|module\s+[\w.]+\s*$)/.test(s)) continue;
      const inh = /\binherit\s+(?:[\w]+\.)*([A-Z]\w*)/g; while ((m = inh.exec(s))) add(m[1], 'inherits', k);
      const itf = /\binterface\s+(?:[\w]+\.)*([A-Z]\w*)/g; while ((m = itf.exec(s))) add(m[1], 'inherits', k);
      const nw = /\bnew\s+(?:[\w]+\.)*([A-Z]\w*)/g; while ((m = nw.exec(s))) add(m[1], 'new', k);
      const ctor = /(?<![.\w'])([A-Z]\w*)\s*\(/g; while ((m = ctor.exec(s))) add(m[1], 'new', k);
      const qual = /(?<![.\w'])([A-Z]\w*)\./g; while ((m = qual.exec(s))) { add(m[1], 'uses', k, true); add(m[1], 'uses', k); }
      const use = /(?<![.\w'])([A-Z]\w*)\b/g; while ((m = use.exec(s))) add(m[1], 'uses', k);
    }
    return { name: t.name, kind: t.kind, line: lines[t.a].n, endLine: lines[t.z].n, methods: t.methods, refs: [...refs.values()] };
  });
  return { types: out };
}

module.exports = { id: 'fsharp', scan, complexity };
