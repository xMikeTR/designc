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
const CALL_CS = /\b(\w+)\.(?:MapGet|MapPost|MapPut|MapPatch|MapDelete|MapMethods)\s*\(/y;
const CALL_JS = /\b([\w$]+)\.(?:get|post|put|patch|delete|all)\s*\(/y;
const EXPRESS_INIT = `(?:require\\(\\s*['"]express['"]\\s*\\)\\.)?(?:Router\\s*\\(\\s*\\)|express\\s*\\(\\s*\\))|require\\(\\s*['"]express['"]\\s*\\)\\s*\\(\\s*\\)|express\\.Router\\s*\\(\\s*\\)`;
const ROUTER_NAME = /^(?:app|router|\w*App|\w*Router)$/;
const esc = n => String(n).replace(/\$/g, '\\$');
// a name that holds an Express app or router: bound to express()/Router() in this file, or named like one
const isRouter = (text, name) => ROUTER_NAME.test(name) || new RegExp(`\\b(?:const|let|var)\\s+${esc(name)}\\b[^=;]*=\\s*(?:${EXPRESS_INIT})`).test(text);
// a name declared locally in a scope: variables, local functions, patterns; `header` is the member signature (parameters)
const declared = (region, header, name) => new RegExp(`\\b(?:var|let|const|val|function)\\s+${esc(name)}(?![\\w$])|\\b(?:Func|Action|Delegate|RequestDelegate)\\b[^;=(){}]*?\\s${esc(name)}\\s*=|\\b(?:string|int|bool|void|object|double|long|decimal|dynamic|[A-Z]\\w*)(?:<[^;=(){}]*>)?(?:\\[\\])?\\??\\s+${esc(name)}\\s*[=;(,)]`).test(region)
  || new RegExp(`[(,]\\s*(?:[\\w.]+(?:<[^>]*>)?\\s+)?${esc(name)}\\s*[,)=:]`).test(header);
const NAME_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

// JS/TS text with comments and the inside of string and template literals blanked; offsets and newlines kept.
function blankJs(text) {
  let out = '', i = 0;
  const sp = c => (c === '\n' ? '\n' : ' ');
  // the last two significant (non-blank) chars of `out`, and the word of word chars that ends the last one: kept as we go, never rescanned
  let p1 = '', p2 = '', word = '', last = '';
  const REGEX_AFTER = /^[(,=:[!&|?{};+\-*%<>~^]$/, KEYWORD = /^(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/;
  // record a char appended to `out` (blanked content is whitespace and never significant)
  const note = ch => {
    const prev = last; last = ch;
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') return;
    word = /\w/.test(ch) ? (/\w/.test(prev) ? word + ch : ch).slice(-8) : '';
    p2 = p1; p1 = ch;
  };
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i++; note(' '); } }
    else if (c === '/' && n === '*') { while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { out += sp(text[i]); i++; } out += '  '; i += 2; note(' '); }
    else if (c === '/' && (p1 === '' || (REGEX_AFTER.test(p1) && !(p1 === '<' && last === '<') && !((p1 === '+' || p1 === '-') && p2 === p1)) || KEYWORD.test(word))) {
      // a regex literal: blank it, keeping '/' and flags, and never run past the line
      let j = i + 1, cls = false;
      while (j < text.length && text[j] !== '\n' && (cls || text[j] !== '/')) { if (text[j] === '\\') j++; else if (text[j] === '[') cls = true; else if (text[j] === ']') cls = false; j++; }
      if (text[j] === '/') { out += '/' + ' '.repeat(j - i - 1) + '/'; i = j + 1; note('/'); note(' '); note('/'); } else { out += c; i++; note(c); }
    } else if (c === '"' || c === "'" || c === '`') {
      out += c; i++; note(c);
      while (i < text.length && text[i] !== c && (text[i] !== '\n' || c === '`')) {
        if (text[i] === '\\') { out += ' ' + sp(text[i + 1] || ''); i += 2; note(' '); } else { out += sp(text[i]); i++; note(' '); }
      }
      if (text[i] === c) { out += c; i++; note(c); }
    } else { out += c; i++; note(c); }
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

// The argument list of the call whose '(' is at `open` in a blanked text: { close, inner, args } (close -1 when unclosed).
function callArgs(code, open) {
  const close = matchClose(code, open, '(', ')');
  if (close < 0) return { close, inner: '', args: [] };
  const inner = code.slice(open + 1, close);
  return { close, inner, args: topArgs(inner).filter((a, k, all) => all.length > 1 || a.trim()) };
}

// sites, elements (key -> {name}), components [{id, container, files}], types and typeEdges (extract/code.js), read(file).
// -> { endpoints, unresolved }
async function build({ sites, elements, components, types, typeEdges, read }) {
  const unresolved = [];
  const nameOf = k => (elements.get(k) || { name: String(k) }).name;
  const docs = new Map();
  const doc = async file => {
    if (docs.has(file)) return docs.get(file);
    const text = await read(file);
    const code = /\.(cs|fs)$/i.test(file) ? blankComments(text, true, /\.fs$/i.test(file)) : blankJs(text);
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    const d = { text, code, starts, lineOf: idx => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; } return lo + 1; } };
    docs.set(file, d);
    return d;
  };

  const byContainer = new Map(); // container name -> [type]
  for (const t of types) (byContainer.get(t.container) || byContainer.set(t.container, []).get(t.container)).push(t);
  const typeById = new Map(types.map(t => [t.id, t]));
  const edgesFrom = new Map();
  for (const e of typeEdges) (edgesFrom.get(e.from) || edgesFrom.set(e.from, []).get(e.from)).push(e.to);

  // What each site is, read from the blanked text. A route in a comment or a call that is no route (no handler argument)
  // is not an endpoint: no node and no row. A call on a receiver that is not an Express app or router, with a handler
  // argument, might be a real route, so it is one row and no node. Nothing is lost silently.
  const info = new Map();
  const live = [];
  for (const s of sites) {
    const container = nameOf(s.owner), verb = s.method || 'ANY';
    const at = { where: container, file: s.evidence.file, line: s.evidence.line, text: s.evidence.text };
    const d = await doc(s.evidence.file);
    const from = d.starts[s.evidence.line - 1] ?? 0, to = d.starts[s.evidence.line] ?? d.code.length;
    if (s.via === 'type') { if (/\[Http/.test(d.code.slice(from, to))) live.push(s); continue; }
    const isCs = /\.(cs|fs)$/i.test(s.evidence.file);
    const re = isCs ? CALL_CS : CALL_JS;
    let m = null;
    if (s.col != null) { re.lastIndex = from + s.col; m = re.exec(d.code); }
    else { const g = new RegExp(re.source); const f = g.exec(d.code.slice(from, to)); if (f) { re.lastIndex = from + f.index; m = re.exec(d.code); } }
    if (!m) continue; // in a comment or a string
    const open = m.index + m[0].length - 1;
    const call = callArgs(d.code, open);
    if (!isCs) {
      if (call.close >= 0 && call.args.length < 2) continue; // cache.get('/key'), request(app).get('/x'): no handler argument
      if (!isRouter(d.text, m[1])) {
        unresolved.push({ ...at, what: `${m[1]}.${m[0].match(/\.(\w+)/)[1]}(${s.route}, ...) has a handler argument but "${m[1]}" is not bound to express()/Router() and is not named like an app or router, so it was not made an endpoint` });
        continue;
      }
    }
    info.set(s, { d, open, call, recv: m[1] });
    live.push(s);
  }

  // the same method and route twice in one container: reported, and neither is a node
  const groups = new Map();
  for (const s of live) {
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

  // a type holds the call when it spans the line; a module holds the whole file (its span ends at its last function)
  const holds = (t, x, s) => x.file === s.evidence.file && (t.kind === 'module' || (x.line <= s.evidence.line && s.evidence.line <= x.endLine));
  const spanOf = (t, s) => { const x = t.files.find(f => holds(t, f, s)); return t.kind === 'module' ? Infinity : x.endLine - x.line; };

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
      handler = callHandler(s, info.get(s), container, node, bad);
    }
    endpoints.push({
      id, node, container, component: comps.length === 1 ? comps[0].id : null, method: s.method || null, route: s.route,
      evidence: { file: s.evidence.file, line: s.evidence.line }, handler,
    });
  }

  // Is `name` a local (variable, local function, parameter) in the member that holds the call? Top-level statements: anywhere in the file.
  // F# scopes are indentation, not braces, so they are not checked.
  function isLocal(name, s, i, encl) {
    if (/\.fs$/i.test(s.evidence.file)) return false;
    const { d } = i;
    if (!encl) return declared(d.code, '', name);
    const f = encl.files.find(x => holds(encl, x, s));
    const stack = [];
    for (let k = encl.kind === 'module' ? 0 : (d.starts[f.line - 1] ?? 0); k < i.open; k++) { if (d.code[k] === '{') stack.push(k); else if (d.code[k] === '}') stack.pop(); }
    const body = stack[encl.kind === 'module' ? 0 : 1]; // a class body holds the member body; a module's own braces are the first scope
    if (body == null) return false;
    const close = matchClose(d.code, body, '{', '}');
    const hdr = Math.max(d.code.lastIndexOf(';', body - 1), d.code.lastIndexOf('}', body - 1), d.code.lastIndexOf('{', body - 1)) + 1;
    return declared(d.code.slice(body, close < 0 ? d.code.length : close + 1), d.code.slice(hdr, body), name);
  }

  function callHandler(s, i, container, node, bad) {
    const { d, call } = i, isFs = /\.fs$/i.test(s.evidence.file);
    const what = `handler of ${s.method || 'ANY'} ${s.route}`;
    if (call.close < 0) return bad(`${what}: the call has no closing parenthesis, so no handler node was made`);
    const rest = call.args.slice(1);
    const lambda = isFs ? /=>|->|\bfun\b|\bfunction\b|\bdelegate\b/ : /=>|\bfunction\b|\bdelegate\b/;
    if (rest.some(a => lambda.test(a))) {
      const uses = new Set();
      for (const im of call.inner.matchAll(/(?<![.\w$@])([A-Za-z_$][\w$]*)/g)) {
        const c = typeNamed(container, im[1]);
        if (c.length === 1) uses.add(c[0].id);
        else if (c.length > 1) {
          const w = `${container}|${im[1]}`;
          if (!warned.has(w)) { warned.add(w); unresolved.push({ where: container, what: `${what} uses "${im[1]}", which is declared ${c.length} times in this container, so it was not linked`, file: s.evidence.file, line: s.evidence.line, text: s.evidence.text }); }
        }
      }
      return { kind: 'inline', node: `${node}#handler`, file: s.evidence.file, line: s.evidence.line, endLine: d.lineOf(call.close), uses: [...uses].sort() };
    }
    const last = (rest[rest.length - 1] || '').trim();
    if (!NAME_CHAIN.test(last)) return bad(`${what} is neither a lambda nor a plain name, so no handler node was made`);
    const parts = last.split('.'), method = parts.pop(), qual = parts.pop();
    const all = byContainer.get(container) || [];
    const encl = all.filter(t => t.files.some(x => holds(t, x, s))).sort((a, b) => spanOf(a, s) - spanOf(b, s))[0] || null;
    // a qualifier names a type by the exact, case-sensitive rule of extract/code.js; a bare name is a method of the enclosing type only
    const subject = qual || method;
    if (isLocal(subject, s, i, encl)) return bad(`${what} is "${last}", but "${subject}" is also a local name here, so no handler node was made`);
    const has = t => t.methods.some(x => x.name === method);
    const holders = qual ? all.filter(t => has(t) && exact(t.name) === exact(qual)) : (encl && has(encl) ? [encl] : []);
    if (holders.length !== 1) return bad(`${what} is "${last}", which is ${qual ? (holders.length ? `a method of ${holders.length} types named so` : 'a method of no code type of that name') : 'not a method of the type or module that holds the call'} in this container, so no handler node was made`);
    return named(container, holders[0]);
  }

  return { endpoints, unresolved };
}

module.exports = { build, blankJs, callArgs, isRouter };
