'use strict';
// JS/TS code-level scanner: classes, interfaces and enums, plus one `module` type per file for its top-level functions.
// Same contract as extract/code-cs.js: scan(file, text) -> {types}. Pattern-based, so it states its limits:
// accessors (get/set) and overload signatures are not measured, regex literals are not understood, and markup text
// inside JSX that looks like a keyword counts as one. Test files (*.test.*, *.spec.*) and declaration files give nothing.
const { matchClose, lineIndex, prevChar, count } = require('./code-util.js');

const CODE_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const SKIP_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/i;
const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'else', 'do', 'try', 'finally', 'function']);
const IIFE_RE = /^\(\s*(?:async\s*)?(?:\(\s*\)\s*=>|function\s*\w*\s*\(\s*\))\s*\{/;
const RANK = { uses: 1, new: 2, inherits: 3 };

// comments and the inside of string and template literals blanked to spaces; offsets and newlines kept.
// A quote string ends at a line break, so an apostrophe in JSX text cannot swallow the rest of the file.
function blank(text) {
  let out = '', i = 0, q = null;
  const sp = c => (c === '\n' ? '\n' : ' ');
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (q) {
      if (c === '\\') { out += ' ' + sp(n || ''); i += 2; continue; }
      if (c === q) { q = null; out += c; i++; continue; }
      if (c === '\n' && q !== '`') { q = null; out += c; i++; continue; }
      out += sp(c); i++;
    } else if (c === '/' && n !== '/' && n !== '*' && /(?:^|[(,=:[!&|?{};])\s*$|\b(?:return|typeof|case)\s*$/.test(out.slice(-14))) {
      // a regex literal: its quotes must not start a string
      let j = i + 1, cls = false;
      while (j < text.length && text[j] !== '\n' && (cls || text[j] !== '/')) { if (text[j] === '\\') j++; else if (text[j] === '[') cls = true; else if (text[j] === ']') cls = false; j++; }
      if (text[j] === '/') { out += '/' + ' '.repeat(j - i - 1) + '/'; i = j + 1; } else { out += c; i++; }
    } else if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i++; } }
    else if (c === '/' && n === '*') { while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { out += sp(text[i]); i++; } out += '  '; i += 2; }
    else { if (c === '"' || c === "'" || c === '`') q = c; out += c; i++; }
  }
  return out;
}

function complexity(b) {
  return 1
    + count(b, /\b(?:if|for|while|case|catch)\b/g)
    + count(b, /&&|\|\|/g)
    + count(b, /\?\?=?/g)
    + count(b, /(?<=\s)\?(?![.?:=])/g);
}

// end of an expression that starts at `from`: a ';' or closing bracket at depth 0, or a line break that does not continue it
function exprEnd(code, from, end) {
  let depth = 0;
  for (let i = from; i < end; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') { if (--depth < 0) return i; }
    else if (ch === ';' && depth <= 0) return i;
    else if (ch === '\n' && depth <= 0) {
      let p = i - 1; while (p >= from && /\s/.test(code[p])) p--;
      let n = i + 1; while (n < end && /\s/.test(code[n])) n++;
      if (p < from) continue;
      const prevOp = '&|?:+-*/,=(.<'.includes(code[p]) || (code[p] === '>' && code[p - 1] === '=');
      const nextOp = n < end && ('.?:&|+-*/,'.includes(code[n]) || /^(?:instanceof|in|as)\b/.test(code.slice(n, n + 11)));
      if (!prevOp && !nextOp) return i;
    }
  }
  return end;
}

const TYPE_RE = /(?<![.\w$])(class|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
function typesIn(code) {
  const out = []; let m;
  TYPE_RE.lastIndex = 0;
  while ((m = TYPE_RE.exec(code))) {
    if (m[2] === 'extends' || m[2] === 'implements') continue;
    const nameEnd = m.index + m[0].length;
    let depth = 0, stop = -1;
    for (let i = nameEnd; i < code.length; i++) {
      const ch = code[i];
      if (ch === '(') depth++; else if (ch === ')') depth--;
      else if (depth === 0 && ch === '{') { stop = i; break; }
      else if (depth === 0 && ch === ';') break;
    }
    if (stop < 0) continue;
    const close = matchClose(code, stop, '{', '}');
    if (close < 0) continue;
    out.push({ name: m[2], kind: m[1], start: m.index, nameEnd, open: stop, close });
    TYPE_RE.lastIndex = close + 1;
  }
  return out;
}

// The member walk over code[from, to): class members, or (mode 'module') top-level statements.
function walk(code, from, to, mode, file, lineOf) {
  const methods = [];
  let i = from;
  const add = (name, start, bodyFrom, bodyTo, last) => {
    const line = lineOf(start), endLine = lineOf(last);
    methods.push({ name, file, line, endLine, cc: complexity(code.slice(bodyFrom, bodyTo)), lines: endLine - line + 1 });
  };
  while (i < to) {
    while (i < to && /\s/.test(code[i])) i++;
    if (i >= to) break;
    if (code[i] === ';') { i++; continue; }
    const start = i;
    let depth = 0, stop = -1, kind = '';
    for (; i < to; i++) {
      const ch = code[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (depth === 0) {
        if (ch === ';') { stop = i; kind = ';'; break; }
        if (ch === '{') {
          const pc = prevChar(code, i);
          if (':|&<,'.includes(pc) && pc !== '') { const e = matchClose(code, i, '{', '}'); if (e < 0) { i = to; break; } i = e; continue; } // an object type, part of the header
          stop = i; kind = '{'; break;
        }
        if (ch === '=') {
          const nx = code[i + 1];
          if (nx === '>') { stop = i; kind = '=>'; break; }
          if (nx !== '=' && !'=!<>'.includes(code[i - 1])) { stop = i; kind = '='; break; }
        }
      }
    }
    if (stop < 0) break;
    const header = code.slice(start, stop).replace(/^(?:\s*@[\w$.]+(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?)+/, '');
    if (kind === ';') { i = stop + 1; continue; }
    if (kind === '=>') { i = exprEnd(code, stop + 2, to) + 1; continue; }
    if (kind === '=') {
      const nm = /([A-Za-z_$][\w$]*)\s*(?::[^=]*)?$/.exec(header);
      const rest = code.slice(stop + 1, to);
      const lead = /^\s*/.exec(rest)[0].length, v = stop + 1 + lead;
      let bodyAt = -1, isFn = false;
      const iife = IIFE_RE.exec(code.slice(v, v + 80));
      if (iife) { // a module wrapped in an immediately invoked function: its functions are the module's
        const open = v + iife[0].length - 1, close = matchClose(code, open, '{', '}');
        if (close > 0) { methods.push(...walk(code, open + 1, close, 'module', file, lineOf)); i = exprEnd(code, close + 1, to) + 1; continue; }
      }
      const fn = /^(?:async\s+)?(?:function\b[^(]*)?\(/.exec(code.slice(v, v + 80));
      const single = /^(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/.exec(code.slice(v, v + 80));
      if (fn) {
        const open = v + fn[0].length - 1, close = matchClose(code, open, '(', ')');
        if (close > 0) {
          const after = /^\s*(?::[^=;{]*?)?(=>|\{)/.exec(code.slice(close + 1, close + 200));
          if (after) { isFn = true; bodyAt = close + 1 + after[0].length - (after[1] === '{' ? 1 : 0); if (after[1] === '=>') { let b = bodyAt; while (b < to && /\s/.test(code[b])) b++; bodyAt = b; } }
        }
      } else if (single) { isFn = true; bodyAt = v + single[0].length; while (bodyAt < to && /\s/.test(code[bodyAt])) bodyAt++; }
      if (isFn && nm) {
        if (code[bodyAt] === '{') {
          const close = matchClose(code, bodyAt, '{', '}');
          if (close < 0) break;
          add(nm[1], start, bodyAt + 1, close, close); i = close + 1; continue;
        }
        const e = exprEnd(code, bodyAt, to);
        add(nm[1], start, bodyAt, e, Math.max(start, e - 1)); i = e + 1; continue;
      }
      i = exprEnd(code, v, to) + 1; continue;
    }
    // kind '{': a function or method body, or a block to skip
    const close = matchClose(code, stop, '{', '}');
    if (close < 0) break;
    const fnDecl = /\bfunction\b\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\s*\(/.exec(header);
    if (fnDecl) add(fnDecl[1], start, stop + 1, close, close);
    else if (mode === 'class' && header.includes('(')) {
      const pre = header.slice(0, header.indexOf('('));
      const nm = /([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\s*$/.exec(pre);
      if (nm && !NOT_METHOD.has(nm[1]) && !/\b(?:get|set)\s+[\w$]+\s*(?:<[^()]*>)?\s*$/.test(pre)) add(nm[1], start, stop + 1, close, close);
    }
    i = close + 1;
  }
  return methods;
}

function importsOf(text, lineOf) {
  const out = []; let m;
  const re = /(?:^|\n)\s*(?:import|export)\b[^'";]*?\bfrom\s*(['"])(\.[^'"\n]*)\1|\brequire\s*\(\s*(['"])(\.[^'"\n]*)\3\s*\)|\bimport\s*\(\s*(['"])(\.[^'"\n]*)\5\s*\)|(?:^|\n)\s*import\s*(['"])(\.[^'"\n]*)\7/g;
  while ((m = re.exec(text))) {
    const spec = m[2] || m[4] || m[6] || m[8];
    const segs = spec.split('/').filter(s => s && s !== '.' && s !== '..');
    let base = segs.pop(); if (base === 'index') base = segs.pop();
    if (!base) continue;
    out.push({ name: base.replace(/\.[cm]?[jt]sx?$/i, ''), via: 'uses', module: true, line: lineOf(m.index + (m[0][0] === '\n' ? 1 : 0)) });
  }
  return out;
}

function basesOf(code, t) {
  const h = code.slice(t.nameEnd, t.open).replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, '');
  const names = list => list.split(',').map(s => s.trim().split('.').pop().replace(/[^\w$]/g, '')).filter(Boolean);
  const out = [];
  const ext = /\bextends\s+([^{]*?)(?=\bimplements\b|$)/.exec(h), imp = /\bimplements\s+(.*)$/.exec(h);
  if (ext) out.push(...names(ext[1])); if (imp) out.push(...names(imp[1]));
  return out;
}

function refsIn(code, self, via0, lineOf, offset, bases) {
  const found = new Map();
  const add = (name, via, line) => {
    if (name === self) return;
    const cur = found.get(name);
    if (!cur || RANK[via] > RANK[cur.via]) found.set(name, { name, via, line: cur && cur.line < line ? cur.line : line });
  };
  for (const b of bases || []) add(b, 'inherits', via0);
  let m;
  const reNew = /\bnew\s+(?:[\w$]+\.)*([A-Z][\w$]*)/g;
  while ((m = reNew.exec(code))) add(m[1], 'new', lineOf(offset + m.index));
  const reUse = /(?<![.\w$@])([A-Z][\w$]*)\b/g;
  while ((m = reUse.exec(code))) add(m[1], 'uses', lineOf(offset + m.index));
  return [...found.values()];
}

const moduleName = file => {
  const segs = file.split('/'); let base = segs.pop().replace(/\.[cm]?[jt]sx?$/i, '');
  if (base === 'index' && segs.length) base = segs.pop();
  return base;
};

function scan(file, text) {
  if (!CODE_RE.test(file) || SKIP_RE.test(file)) return { types: [] };
  const code = blank(text);
  const lineOf = lineIndex(code);
  const all = typesIn(code);
  const types = all.map(t => ({
    name: t.name, kind: t.kind, line: lineOf(t.start), endLine: lineOf(t.close),
    methods: t.kind === 'class' ? walk(code, t.open + 1, t.close, 'class', file, lineOf) : [],
    refs: refsIn(code.slice(t.open + 1, t.close), t.name, lineOf(t.start), lineOf, t.open + 1, basesOf(code, t)),
  }));
  // the module: everything outside the declared types
  let rest = code;
  for (const t of all) rest = rest.slice(0, t.start) + rest.slice(t.start, t.close + 1).replace(/[^\n]/g, ' ') + rest.slice(t.close + 1);
  const methods = walk(rest, 0, rest.length, 'module', file, lineOf);
  if (methods.length) types.push({ name: moduleName(file), kind: 'module', line: methods[0].line, endLine: methods[methods.length - 1].endLine, methods,
    refs: mergeRefs([...importsOf(text, lineOf), ...refsIn(rest, moduleName(file), 1, lineOf, 0, [])]) });
  return { types };
}

function mergeRefs(refs) {
  const m = new Map();
  for (const r of refs) { const k = r.name + (r.module ? '#m' : ''); const c = m.get(k); if (!c || RANK[r.via] > RANK[c.via]) m.set(k, r); }
  return [...m.values()];
}

module.exports = { id: 'js', scan, complexity };
