// Component assignment for C#/F# units.
//   rule 2  anchors: a class with a [Function] method, a controller, or a static class calling
//           Map(Get|Post|...). The component is named after the class and holds its file.
//   rule 3  output-binding types: the T a [Function] method returns joins that method's class,
//           but only when T is declared exactly once in the project (never guessed).
//   rule 5  files directly in the project root are 'App shell'.
//   rule 8  otherwise the first folder under the root names the component.
// F# units only get rules 5 and 8. Anchor detection runs on comment-blanked code, so a
// commented-out attribute or class is not an anchor.
const { blankComments } = require('./csharp');

const DECL_RE = /\b(class|record|struct|interface)\s+(\w+)/g;
const MAP_RE = /\bMap(?:Get|Post|Put|Patch|Delete|Methods|Group)\s*\(/;
const FUNCTION_ATTR_RE = /\[\s*Function\s*\(/g;
const CONTROLLER_BASE_RE = /:\s*[^{]*\b(?:ControllerBase|Controller)\b/;
const projectKey = u => `${u.project}|${u.root}`;

// index of the matching closer for the opener at code[open], on string-blanked code
function matchClose(code, open, o, c) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === o) depth++;
    else if (code[i] === c && --depth === 0) return i;
  }
  return -1;
}
const lineAt = (text, idx) => text.slice(0, idx).split('\n').length;

// the T of the signature that follows the attribute ending at `from`: Task<T>, ValueTask<T> or T
function returnTypeAfter(code, from) {
  let i = from;
  for (;;) {
    while (/\s/.test(code[i] || '')) i++;
    if (code[i] !== '[') break;
    const end = matchClose(code, i, '[', ']');
    if (end < 0) return null;
    i = end + 1;
  }
  const sig = /^((?:(?:public|private|protected|internal|static|async|virtual|override|sealed|new)\s+)*)([\w.<>?,\s]+?)\s+\w+\s*\(/.exec(code.slice(i, i + 400));
  if (!sig) return null;
  let t = sig[2].trim();
  const wrapped = /^(?:[\w.]*\.)?(?:Task|ValueTask)\s*<\s*(.+)\s*>$/.exec(t);
  if (wrapped) t = wrapped[1].trim();
  t = t.replace(/\?$/, '').replace(/^[\w.]*\./, '');
  return /^\w+$/.test(t) ? t : null;
}

function analyseFile(text) {
  const code = blankComments(text);
  const solid = blankComments(text, true);
  const lines = text.split(/\r?\n/);
  const decls = [];
  for (const m of code.matchAll(DECL_RE)) {
    const open = solid.indexOf('{', m.index);
    const semi = solid.indexOf(';', m.index);
    const end = open >= 0 && (semi < 0 || open < semi) ? matchClose(solid, open, '{', '}') : -1;
    decls.push({ kind: m[1], name: m[2], start: m.index, end, header: open >= 0 ? solid.slice(m.index, open) : '' });
  }
  const anchors = [], binds = [];
  for (const d of decls) {
    if (d.kind !== 'class' || d.end < 0) continue;
    const body = code.slice(d.start, d.end);
    const fnAttrs = [...body.matchAll(FUNCTION_ATTR_RE)];
    const isController = /Controller$/.test(d.name) || CONTROLLER_BASE_RE.test(d.header);
    const isEndpoints = /\bstatic\b/.test(code.slice(Math.max(0, d.start - 40), d.start)) && MAP_RE.test(body);
    if (!(fnAttrs.length || isController || isEndpoints)) continue;
    const line = lineAt(text, d.start);
    anchors.push({ name: d.name, line, text: lines[line - 1].trim().slice(0, 200) });
    for (const a of fnAttrs) {
      const open = d.start + a.index;
      const close = matchClose(code, open, '[', ']');
      const t = close < 0 ? null : returnTypeAfter(code, close + 1);
      if (t) binds.push({ cls: d.name, type: t });
    }
  }
  return { decls: decls.map(d => d.name), anchors, binds };
}

// Per project: which file belongs to which anchor class. One analysis per source file.
async function prepare(units, read) {
  const byProject = new Map();
  for (const u of units) {
    if (!/\.cs$/i.test(u.file)) continue;
    if (!byProject.has(projectKey(u))) byProject.set(projectKey(u), new Map());
    byProject.get(projectKey(u)).set(u.file, null);
  }
  const index = new Map(); // project key -> Map(file -> { name, line, text, basis })
  for (const [pk, files] of byProject) {
    for (const f of files.keys()) files.set(f, analyseFile(await read(f)));
    const declCount = new Map();
    for (const a of files.values()) for (const n of a.decls) declCount.set(n, (declCount.get(n) || 0) + 1);
    const declaredIn = new Map(); // type name -> file, only for names declared exactly once
    for (const [f, a] of files) for (const n of a.decls) if (declCount.get(n) === 1) declaredIn.set(n, f);
    const assigned = new Map();
    for (const [f, a] of files) if (a.anchors.length) assigned.set(f, { ...a.anchors[0], basis: 'anchor' });
    const claims = new Map(); // file -> Set of class names claiming it by output binding
    for (const a of files.values()) for (const b of a.binds) {
      const f = declaredIn.get(b.type);
      if (f && !assigned.has(f)) { if (!claims.has(f)) claims.set(f, new Set()); claims.get(f).add(b.cls); }
    }
    for (const [f, who] of claims) {
      if (who.size !== 1) continue; // two function classes claim it: attribute to neither
      assigned.set(f, { name: [...who][0], line: 1, text: f.split('/').pop(), basis: 'output-binding' });
    }
    index.set(pk, assigned);
  }
  return index;
}

function assign(unit, index) {
  const files = index && index.get(projectKey(unit));
  const hit = files && files.get(unit.file);
  if (hit) return { name: hit.name, basis: hit.basis, evidence: { file: unit.file, line: hit.line, text: hit.text } };
  const segs = unit.relFromRoot.split('/').filter(Boolean);
  if (segs.length <= 1) return { name: 'App shell', basis: 'app-shell', evidence: unit.evidence };
  return { name: segs[0], basis: 'first-folder', evidence: unit.evidence };
}
function edges(ctx) { return []; }

module.exports = { prepare, assign, edges };
