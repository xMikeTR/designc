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
    const clsFile = new Map(); // anchor class name -> its file
    for (const [f, a] of files) for (const x of a.anchors) if (!clsFile.has(x.name)) clsFile.set(x.name, f);
    const claims = new Map(); // file -> Set of class names claiming it by output binding
    for (const a of files.values()) for (const b of a.binds) {
      const f = declaredIn.get(b.type);
      if (f && !assigned.has(f)) { if (!claims.has(f)) claims.set(f, new Set()); claims.get(f).add(b.cls); }
    }
    for (const [f, who] of claims) {
      if (who.size !== 1) continue; // two function classes claim it: attribute to neither
      assigned.set(f, { name: [...who][0], line: 1, text: f.split('/').pop(), basis: 'output-binding', anchorFile: clsFile.get([...who][0]) });
    }
    index.set(pk, assigned);
  }
  return index;
}

function assign(unit, index) {
  const files = index && index.get(projectKey(unit));
  const hit = files && files.get(unit.file);
  if (hit) return { name: hit.name, basis: hit.basis, anchorFile: hit.anchorFile, evidence: { file: unit.file, line: hit.line, text: hit.text } };
  const segs = unit.relFromRoot.split('/').filter(Boolean);
  if (segs.length <= 1) return { name: 'App shell', basis: 'app-shell', evidence: unit.evidence };
  return { name: segs[0], basis: 'first-folder', evidence: unit.evidence };
}
// ---- layer (c): type and DI references between the files of one deployable's closure ----
// Per deployable, a type name resolves only when exactly one declaration in the closure has it. A reference is
// a type in a type position (parameter, field, property, generic argument, new T(, typeof(T)); extension-method
// calls are not type references. Registrations (Add*<I, Impl>) tie an interface to its implementations.
const ID = '(?:[\\w.]+\\.)?(\\w+)';
const TYPE_ARGS = '(?:\\s*<[^<>;(){}]*(?:<[^<>;(){}]*>[^<>;(){}]*)*>)?';
const REF_PATTERNS = [
  new RegExp(`\\bnew\\s+${ID}\\s*[(<{\\[]`, 'g'),
  new RegExp(`\\btypeof\\s*\\(\\s*${ID}`, 'g'),
  new RegExp(`[<,]\\s*${ID}\\s*(?=[>,<?\\[])`, 'g'),
  new RegExp(`(?<![\\w.])(?:\\w+\\.)*(\\w+)${TYPE_ARGS}\\??(?:\\[\\])*\\s+\\w+\\s*(?=[,)=;{(])`, 'g'),
];
const ADD = '\\bAdd(?:Singleton|Scoped|Transient|HttpClient)';
const REG_PATTERNS = [
  new RegExp(`${ADD}\\s*<\\s*${ID}\\s*,\\s*${ID}\\s*>`, 'g'),
  new RegExp(`${ADD}\\s*\\(\\s*typeof\\s*\\(\\s*${ID}\\s*\\)\\s*,\\s*typeof\\s*\\(\\s*${ID}\\s*\\)`, 'g'),
  new RegExp(`${ADD}\\s*<\\s*${ID}\\s*>\\s*\\([^;]*?\\bnew\\s+${ID}\\s*\\(`, 'g'),
];

const EXT_DECL = /\bstatic\s+[\w<>\[\]?.]+\s+(\w+)\s*(?:<[^<>()]*>)?\s*\(\s*this\s+(?:IServiceCollection|IHostBuilder|IHostApplicationBuilder|WebApplicationBuilder|IFunctionsWorkerApplicationBuilder)\b/g;

// ctx: { units, read, elements }. Returns { refs: [{ owner, from: file, to: file, via, evidence: [..] }], unresolved }
async function edges(ctx) {
  const refs = [], unresolved = [];
  const owners = new Map(); // owner key -> [unit]
  for (const u of ctx.units) {
    if (!/\.cs$/i.test(u.file)) continue;
    for (const o of u.owners) { if (!owners.has(o)) owners.set(o, []); owners.get(o).push(u); }
  }
  for (const [owner, units] of owners) {
    const files = [...new Set(units.map(u => u.file))].sort();
    const texts = new Map(), codes = new Map(), decls = new Map();
    for (const f of files) {
      const text = await ctx.read(f);
      texts.set(f, text); codes.set(f, blankComments(text, true));
      for (const n of analyseFile(text).decls) { if (!decls.has(n)) decls.set(n, []); decls.get(n).push(f); }
    }
    // Layering truth is the project-reference graph: a reference to a type in a project the file's own project cannot reach is no edge.
    const unitOf = new Map(units.map(u => [u.file, u]));
    const reaches = (from, to) => { const a = unitOf.get(from), b = unitOf.get(to); return !a || !b || a.project === b.project || !a.reaches || a.reaches.includes(b.project); };
    const noPath = new Set();
    const push = r => {
      if (reaches(r.from, r.to)) return refs.push(r);
      const key = `${unitOf.get(r.from).project}>${unitOf.get(r.to).project}`;
      if (noPath.has(key)) return;
      noPath.add(key);
      unresolved.push({ where: ctx.elements.get(owner).name, what: `${unitOf.get(r.from).project} refers to a type in ${unitOf.get(r.to).project}, but has no ProjectReference path to it; no edge was made`, ...r.evidence[0] });
    };
    const declared = name => { const at = decls.get(name); return at && at.length === 1 ? at[0] : null; };
    const at = (f, idx) => { const line = lineAt(texts.get(f), idx); return { file: f, line, text: texts.get(f).split(/\r?\n/)[line - 1].trim().slice(0, 200) }; };
    // registrations: interface name -> distinct implementations, in source order
    const regs = new Map();
    const regSpans = new Map(); // file -> [{start, end, impl}]: a registration's implementation is not a type reference there
    for (const f of files) for (const re of REG_PATTERNS) for (const m of codes.get(f).matchAll(re)) {
      if (!regSpans.has(f)) regSpans.set(f, []);
      regSpans.get(f).push({ start: m.index, end: m.index + m[0].length, impl: m[2] });
      if (!regs.has(m[1])) regs.set(m[1], []);
      if (!regs.get(m[1]).some(r => r.impl === m[2])) regs.get(m[1]).push({ impl: m[2], ev: at(f, m.index) });
    }
    // Several registrations for one interface are a configuration choice (stub or real adapter), not a dependency of every
    // consumer: say it once per owner.
    const multi = [...regs].filter(([, list]) => list.length > 1);
    if (multi.length) {
      const first = multi[0][1][0].ev;
      unresolved.push({ where: ctx.elements.get(owner).name, what: `${multi.length === 1 ? '1 interface has' : `${multi.length} interfaces have`} several registrations, chosen by configuration: ${multi.map(([i, list]) => `${i} has ${list.length} registrations (${list.map(r => r.impl).join(', ')})`).join('; ')}; the composition root gets DI candidate edges to them`, ...first });
    }
    // Service-registration extension methods (AddInfrastructure(this IServiceCollection ...)): a call is one edge to the file that declares it.
    const exts = new Map();
    for (const f of files) for (const m of codes.get(f).matchAll(EXT_DECL)) { if (!exts.has(m[1])) exts.set(m[1], []); exts.get(m[1]).push(f); }
    for (const f of files) {
      const code = codes.get(f);
      for (const m of code.matchAll(/\.(\w+)\s*(?:<[^<>;()]*>)?\s*\(/g)) {
        const at1 = exts.get(m[1]);
        if (at1 && at1.length === 1 && at1[0] !== f) push({ owner, from: f, to: at1[0], via: 'di', evidence: [at(f, m.index)] });
      }
    }
    for (const f of files) {
      const code = codes.get(f);
      for (const re of REF_PATTERNS) for (const m of code.matchAll(re)) {
        const target = declared(m[1]);
        if ((regSpans.get(f) || []).some(r => m.index >= r.start && m.index < r.end && r.impl === m[1])) continue;
        if (target && target !== f) push({ owner, from: f, to: target, via: 'type', evidence: [at(f, m.index)] });
      }
    }
    // A registration ties its interface to an implementation at the place that registers it, so the edge starts there.
    for (const [, list] of regs) for (const r of list) {
      const to = declared(r.impl);
      if (to && to !== r.ev.file) push({ owner, from: r.ev.file, to, via: list.length > 1 ? 'di-candidate' : 'di', evidence: [r.ev] });
    }
  }
  return { refs, unresolved };
}

module.exports = { prepare, assign, edges };
