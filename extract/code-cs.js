'use strict';
// C# code-level scanner: types, their methods (with cyclomatic complexity and size) and the type names each type refers to.
// Pure: scan(file, text) -> {types}. Pattern-based like csharp.js, so it states its limits instead of guessing:
// property accessors and operators are not measured, and a reference is only a name (extract/code.js resolves it).
const { blankComments } = require('./csharp.js');

const TYPE_RE = /\b(record\s+(?:class|struct)|class|record|struct|interface|enum)\s+([A-Za-z_]\w*)/g;

function matchClose(code, open, o, c) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === o) depth++;
    else if (code[i] === c && --depth === 0) return i;
  }
  return -1;
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return idx => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

const prevChar = (code, idx) => { let i = idx - 1; while (i >= 0 && /\s/.test(code[i])) i--; return i >= 0 ? code[i] : ''; };

// index of the ';' that ends the member starting at `from`, ignoring ones inside brackets
function skipTo(code, from, end) {
  let depth = 0;
  for (let i = from; i < end; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ';' && depth <= 0) return i;
  }
  return end;
}

const count = (s, re) => (s.match(re) || []).length;

// arms of switch expressions, excluding the discard arm `_`
function switchArms(b) {
  let n = 0;
  const re = /\bswitch\s*\{/g;
  let m;
  while ((m = re.exec(b))) {
    const open = m.index + m[0].length - 1, close = matchClose(b, open, '{', '}');
    if (close < 0) continue;
    let depth = 0, armStart = open + 1, inExpr = false;
    for (let i = open + 1; i < close; i++) {
      const ch = b[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (depth === 0) {
        if (ch === ',') { if (inExpr) { inExpr = false; armStart = i + 1; } }
        else if (ch === '=' && b[i + 1] === '>' && !inExpr) {
          if (b.slice(armStart, i).trim() !== '_') n++;
          inExpr = true; i++;
        }
      }
    }
  }
  return n;
}

function complexity(b) {
  return 1
    + count(b, /\b(?:if|for|foreach|while|case|catch|when)\b/g)
    + count(b, /&&|\|\|/g)
    + count(b, /\?\?=?/g)
    + count(b, /(?<=[\s)\]])\?(?=\s)/g)
    + switchArms(b);
}

function typesIn(code) {
  const out = [];
  let m;
  TYPE_RE.lastIndex = 0;
  while ((m = TYPE_RE.exec(code))) {
    const pc = prevChar(code, m.index);
    if (pc === ':' || pc === ',') continue; // a generic constraint, not a declaration
    const nameEnd = m.index + m[0].length;
    let depth = 0, stop = -1;
    for (let i = nameEnd; i < code.length; i++) {
      const ch = code[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (depth === 0 && (ch === '{' || ch === ';')) { stop = i; break; }
    }
    if (stop < 0) continue;
    out.push({
      name: m[2], kind: m[1].startsWith('record') ? 'record' : m[1],
      start: m.index, nameEnd, stop,
      open: code[stop] === '{' ? stop : -1,
      close: code[stop] === '{' ? matchClose(code, stop, '{', '}') : stop,
    });
  }
  return out.filter(t => t.close >= 0);
}

// the member walk: methods and constructors directly in one type body
function methodsOf(code, t, file, lineOf) {
  const methods = [];
  const end = t.close;
  let i = t.open + 1;
  while (i < end) {
    while (i < end && /\s/.test(code[i])) i++;
    if (i >= end) break;
    if (code[i] === '[') { const e = matchClose(code, i, '[', ']'); if (e < 0) break; i = e + 1; continue; }
    if (code[i] === ';') { i++; continue; }
    const start = i;
    let depth = 0, stop = -1, kind = '';
    for (; i < end; i++) {
      const ch = code[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (depth === 0) {
        if (ch === ';' || ch === '{') { stop = i; kind = ch; break; }
        if (ch === '=') {
          const nx = code[i + 1];
          if (nx === '>') { stop = i; kind = '=>'; break; }
          if (nx !== '=' && !'=!<>'.includes(code[i - 1])) { stop = i; kind = '='; break; }
        }
      }
    }
    if (stop < 0) break;
    const header = code.slice(start, stop);
    const add = (bodyFrom, bodyTo, last) => {
      const pre = header.slice(0, header.indexOf('('));
      if (/\boperator\b/.test(pre)) return;
      const nm = /([A-Za-z_]\w*)\s*(?:<[^()]*>)?\s*$/.exec(pre);
      if (!nm) return;
      const line = lineOf(start), endLine = lineOf(last);
      methods.push({ name: nm[1], file, line, endLine, cc: complexity(code.slice(bodyFrom, bodyTo)), lines: endLine - line + 1 });
    };
    if (kind === ';') { i = stop + 1; continue; }
    if (kind === '=') { i = skipTo(code, stop, end) + 1; continue; }
    if (kind === '=>') {
      const semi = skipTo(code, stop + 2, end);
      if (header.includes('(')) add(stop + 2, semi, semi);
      i = semi + 1; continue;
    }
    const close = matchClose(code, stop, '{', '}');
    if (close < 0) break;
    const nested = typesIn(header + ' {').some(x => x.start >= 0);
    if (!nested && header.includes('(')) add(stop + 1, close, close);
    i = close + 1;
    if (!nested && !header.includes('(')) { // a property, possibly with an initializer after its accessors
      let j = i; while (j < end && /\s/.test(code[j])) j++;
      if (code[j] === '=' && code[j + 1] !== '>') i = skipTo(code, j, end) + 1;
    }
  }
  return methods;
}

function bases(code, t) {
  if (t.kind === 'enum') return [];
  let h = code.slice(t.nameEnd, t.stop).trim();
  if (h[0] === '<') { const e = matchClose(h, 0, '<', '>'); h = e < 0 ? '' : h.slice(e + 1).trim(); }
  if (h[0] === '(') { const e = matchClose(h, 0, '(', ')'); h = e < 0 ? '' : h.slice(e + 1).trim(); }
  if (h[0] !== ':') return [];
  h = h.slice(1).split(/\bwhere\b/)[0];
  const items = []; let depth = 0, cur = '';
  for (const ch of h) {
    if (ch === '<' || ch === '(') depth++;
    else if (ch === '>' || ch === ')') depth--;
    if (ch === ',' && depth === 0) { items.push(cur); cur = ''; } else cur += ch;
  }
  items.push(cur);
  return items.map(s => { let x = s.trim(), p; while ((p = x.replace(/<[^<>]*>|\([^()]*\)/g, '')) !== x) x = p; return x.trim().split('.').pop(); }).filter(s => /^\w+$/.test(s));
}

const RANK = { uses: 1, new: 2, inherits: 3 };

function refsOf(code, t, all, lineOf) {
  const found = new Map();
  const add = (name, via, line) => {
    if (name === t.name) return;
    const cur = found.get(name);
    if (!cur || RANK[via] > RANK[cur.via]) found.set(name, { name, via, line: cur && cur.line < line ? cur.line : line });
  };
  for (const b of bases(code, t)) add(b, 'inherits', lineOf(t.start));
  if (t.open >= 0) {
    const from = t.open + 1;
    let body = code.slice(from, t.close), shift = 0;
    for (const n of all) {
      if (n === t || n.start <= t.open || n.close >= t.close) continue;
      const a = n.start - from - shift, z = n.close - from - shift + 1;
      if (a < 0 || z > body.length) continue;
      body = body.slice(0, a) + body.slice(a, z).replace(/[^\n]/g, ' ') + body.slice(z);
    }
    let m;
    const reNew = /\bnew\s+(?:\w+\.)*([A-Z]\w*)/g;
    while ((m = reNew.exec(body))) add(m[1], 'new', lineOf(from + m.index));
    const reUse = /(?<![.\w@$])([A-Z]\w*)\b/g;
    while ((m = reUse.exec(body))) add(m[1], 'uses', lineOf(from + m.index));
  }
  return [...found.values()];
}

function scan(file, text) {
  const code = blankComments(text, true);
  const lineOf = lineIndex(code);
  const all = typesIn(code);
  const types = all.map(t => ({
    name: t.name, kind: t.kind, line: lineOf(t.start), endLine: lineOf(t.close),
    methods: t.open >= 0 && t.kind !== 'enum' ? methodsOf(code, t, file, lineOf) : [],
    refs: refsOf(code, t, all, lineOf),
  }));
  return { types };
}

module.exports = { id: 'csharp', scan, complexity };
