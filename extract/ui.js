// The UI graph (phase 7, slice 7a): the controls of each screen named in designc.json `ui.screens`, read from
// source with the TypeScript compiler API. Display only, like facts.code: never a gate input, finding, DSL line or
// fingerprint input. One program per screen over its roots (and, through the compiler, their in-repo imports);
// 7a reads controls in the root files only. Nothing is guessed: a control whose role the source cannot show gets
// role null and an unresolved entry. TypeScript is required lazily, here and only here (Node, main process).
const path = require('path');
const glob = require('./glob');
const roles = require('./ui-roles');

const SCHEMA = 'designc.ui.graph/1';
const SOURCE_RE = /\.(tsx|ts|jsx|js|mjs|cjs)$/i;
const isSource = f => SOURCE_RE.test(f) && !/\.d\.ts$/i.test(f);

let TS = null;
function loadTs() { if (!TS) TS = require('typescript'); return TS; }

const issue = (what, file, line, text, screen) => ({ where: 'ui', what, file, line, text, ...(screen ? { screen } : {}) });
const squash = s => s.replace(/\s+/g, ' ').trim();
const capital = n => /^[A-Z]/.test(n || '');

// Compiler options from the configured tsconfig (paths, baseUrl, jsx), with what a read-only scan needs on top.
function compilerOptions(ts, repo, tsconfigRel, out) {
  let options = {};
  if (tsconfigRel) {
    const abs = path.resolve(repo, tsconfigRel);
    if (abs !== repo && !abs.startsWith(repo + path.sep)) out.push(issue(`ui.tsconfig "${tsconfigRel}" is outside the codebase, so it was not read`, 'designc.json', 1, 'ui.tsconfig'));
    else {
      const read = ts.readConfigFile(abs, ts.sys.readFile);
      if (read.error) out.push(issue(`ui.tsconfig could not be read: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`, 'designc.json', 1, 'ui.tsconfig'));
      else options = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(abs), undefined, abs).options;
    }
  }
  return { ...options, allowJs: true, noEmit: true, noLib: true, types: [], skipLibCheck: true, jsx: options.jsx || ts.JsxEmit.Preserve };
}

// Attributes of a JSX opening element: {name: {literal, expr?, node}}; a spread is kept as `spreads`.
function attrsOf(ts, sf, opening) {
  const attrs = {}; let spreads = 0;
  for (const a of opening.attributes.properties) {
    if (ts.isJsxSpreadAttribute(a)) { spreads++; continue; }
    const name = a.name.getText(sf), init = a.initializer;
    if (!init) { attrs[name] = { literal: 'true' }; continue; }
    if (ts.isStringLiteral(init)) { attrs[name] = { literal: init.text }; continue; }
    const ex = ts.isJsxExpression(init) ? init.expression : null;
    if (ex && (ts.isStringLiteral(ex) || ts.isNoSubstitutionTemplateLiteral(ex))) attrs[name] = { literal: ex.text };
    else attrs[name] = { literal: null, expr: ex ? ex.getText(sf) : init.getText(sf) };
  }
  return { attrs, spreads };
}

const tagOf = (sf, el) => el.tagName.getText(sf);
const openingOf = (ts, n) => (ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null);
const i18nKey = (ts, sf, ex) => (ex && ts.isCallExpression(ex) && /^(t|i18n\.t|intl\.formatMessage)$/.test(ex.expression.getText(sf)) && ex.arguments[0]
  && (ts.isStringLiteral(ex.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(ex.arguments[0])) ? ex.arguments[0].text : null);

// The content of an element as name parts, in order: literal text, t('key'), other expressions. `skip` leaves a node out.
function contentOf(ts, sf, node, skip) {
  const parts = [];
  const visit = n => {
    if (n === skip) return;
    if (ts.isJsxText(n)) { const s = squash(n.text); if (s) parts.push({ kind: 'text', value: s }); return; }
    if (ts.isJsxExpression(n)) {
      const ex = n.expression; if (!ex) return;
      if (ts.isStringLiteral(ex) || ts.isNoSubstitutionTemplateLiteral(ex)) { const s = squash(ex.text); if (s) parts.push({ kind: 'text', value: s }); return; }
      const k = i18nKey(ts, sf, ex);
      parts.push(k != null ? { kind: 't()', value: k } : { kind: 'expr', expr: ex.getText(sf) });
      return;
    }
    if (ts.isJsxElement(n)) { for (const c of n.children) visit(c); return; }
    if (ts.isJsxFragment(n)) for (const c of n.children) visit(c);
  };
  if (ts.isJsxElement(node) || ts.isJsxFragment(node)) for (const c of node.children) visit(c);
  return parts;
}
// Parts to names: all literal text becomes one entry; t() and expressions are kept, never as the name.
function partsToNames(from, parts) {
  const out = [], text = parts.filter(p => p.kind === 'text').map(p => p.value);
  if (text.length && parts.every(p => p.kind === 'text')) out.push({ from, value: text.join(' ') });
  else if (text.length) out.push({ from, value: null, expr: parts.map(p => p.kind === 'text' ? p.value : p.kind === 't()' ? `t('${p.value}')` : `{${p.expr}}`).join(' ') });
  for (const p of parts) if (p.kind === 't()') out.push({ from: 't()', value: p.value });
  if (!text.length) for (const p of parts) if (p.kind === 'expr') out.push({ from, value: null, expr: p.expr });
  return out;
}

// The component a node sits in: the nearest capitalised function, arrow const or class; else the file's module name.
function componentAt(ts, node, file) {
  for (let n = node.parent; n; n = n.parent) {
    let name = null;
    if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) name = n.name ? n.name.text : (n.modifiers || []).some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ? moduleName(file) : null;
    else if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) name = n.parent.name.text;
    if (capital(name)) return { name, node: n };
  }
  return { name: moduleName(file), node: null };
}
const moduleName = file => { const b = path.basename(file).replace(/\.[^.]+$/, ''); return b === 'index' ? path.basename(path.dirname(file)) : b; };

function scanFile(ts, sf, file, screen, out) {
  const lineOf = n => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const where = n => { const p = sf.getLineAndCharacterOfPosition(n.getStart(sf)); return `${p.line + 1}:${p.character + 1}`; };
  // Ids and labels in this file: <x id="a">text</x> for aria-labelledby, <label htmlFor="a">text</label> for inputs.
  const byId = new Map(), labelFor = new Map();
  const comps = new Map();
  const index = n => {
    const op = openingOf(ts, n);
    if (op) {
      const { attrs } = attrsOf(ts, sf, op), tag = tagOf(sf, op);
      if (attrs.id && attrs.id.literal != null) byId.set(attrs.id.literal, n);
      if (tag === 'label' && attrs.htmlFor && attrs.htmlFor.literal != null) labelFor.set(attrs.htmlFor.literal, n);
      if (capital(tag)) { const c = componentAt(ts, n, file); if (c.node || c.name) (comps.get(c.name) || comps.set(c.name, { renders: new Set(), node: c.node }).get(c.name)).renders.add(tag); }
    }
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      const c = componentAt(ts, n, file); if (!comps.has(c.name)) comps.set(c.name, { renders: new Set(), node: c.node });
    }
    ts.forEachChild(n, index);
  };
  index(sf);
  const textNames = (from, n, skip) => (n ? partsToNames(from, contentOf(ts, sf, n, skip)) : []);

  const visit = n => {
    const op = openingOf(ts, n);
    if (op) {
      const tag = tagOf(sf, op);
      if (/^[a-z]/.test(tag) && !tag.includes('.')) control(n, op, tag);
    }
    ts.forEachChild(n, visit);
  };
  const control = (n, op, tag) => {
    const { attrs, spreads } = attrsOf(ts, sf, op);
    const r = roles.roleOf(tag, attrs);
    if (!r.control) return;
    const names = [];
    const attrName = k => { const a = attrs[k]; if (!a) return; names.push(a.literal != null ? { from: k, value: squash(a.literal) } : { from: k, value: null, expr: a.expr }); };
    if (attrs['aria-labelledby']) {
      const a = attrs['aria-labelledby'];
      if (a.literal == null) names.push({ from: 'aria-labelledby', value: null, expr: a.expr });
      else for (const id of a.literal.trim().split(/\s+/)) {
        const target = byId.get(id);
        const ns = target ? textNames('aria-labelledby', target) : [];
        names.push(...(ns.length ? ns.map(x => ({ ...x, ref: id })) : [{ from: 'aria-labelledby', value: null, ref: id }]));
      }
    }
    attrName('aria-label');
    // <label>text <input/></label> around it, or <label htmlFor=id> in the same file.
    const labelable = ['input', 'select', 'textarea', 'button'].includes(tag);
    if (labelable) {
      for (let p = n.parent; p; p = p.parent) {
        const pop = openingOf(ts, p);
        if (pop && tagOf(sf, pop) === 'label') { names.push(...textNames('label', p, n)); break; }
      }
      if (attrs.id && attrs.id.literal != null && labelFor.has(attrs.id.literal)) names.push(...textNames('label', labelFor.get(attrs.id.literal)));
    }
    const type = attrs.type && attrs.type.literal ? attrs.type.literal.toLowerCase() : null;
    if (tag === 'input' && type === 'image') attrName('alt');
    if (r.role && roles.NAME_FROM_CONTENT.has(r.role) && tag !== 'input') names.push(...textNames('text', n));
    if (tag === 'input' && ['submit', 'button', 'reset'].includes(type)) attrName('value');
    attrName('title');
    if (tag === 'input' || tag === 'textarea') attrName('placeholder');
    // The first source present decides: a literal is the name; an expression or t('key') there means the source cannot say.
    const decides = roles.NAME_ORDER.map(f => names.find(x => (x.from === 't()' ? 'text' : x.from) === f)).find(Boolean);
    const named = decides && decides.from !== 't()' && decides.value ? decides : null;
    const comp = componentAt(ts, n, file);
    const c = {
      id: `${screen}:${file}:${where(op)}`, screen, component: `${file}#${comp.name}`, file, line: lineOf(op), tag,
      role: r.role, basis: r.basis, name: named ? named.value : null, names,
      ...(spreads ? { spreads } : {}),
    };
    out.controls.push(c);
    if (!r.role) out.unresolved.push(issue(`<${tag}> has no role the source can show: ${r.reason}`, file, c.line, op.getText(sf).slice(0, 120), screen));
  };
  visit(sf);
  return [...comps.entries()].map(([name, v]) => ({
    id: `${file}#${name}`, name, file, line: v.node ? lineOf(v.node) : 1, renders: [...v.renders].sort(), basis: 'declared',
  }));
}

/* ui: designc.json `ui` ({tsconfig?: {codebase}, screens: {name: {codebase: [patterns]}}}).
   files: repo-relative source files from the walk. Returns facts.ui. */
function build({ repo, files, ui }) {
  const out = { schema: SCHEMA, repo: 'codebase', screens: [], components: [], controls: [], unresolved: [] };
  const screens = ui && ui.screens && typeof ui.screens === 'object' ? ui.screens : {};
  let ts;
  try { ts = loadTs(); } catch (e) { out.unresolved.push(issue(`The TypeScript compiler could not be loaded (${e.message}), so no screen was read`, 'designc.json', 1, 'ui.screens')); return out; }
  const tsconfig = ui && ui.tsconfig && typeof ui.tsconfig === 'object' ? ui.tsconfig.codebase : null;
  const options = compilerOptions(ts, repo, tsconfig, out.unresolved);
  const sources = files.filter(isSource);
  const seen = new Map();
  for (const [name, def] of Object.entries(screens)) {
    const pats = def && def.codebase != null ? [].concat(def.codebase) : [];
    for (const k of Object.keys(def || {})) if (k !== 'codebase') out.unresolved.push(issue(`ui.screens.${name}.${k}: reference repositories are not read yet; only "codebase" is`, 'designc.json', 1, `ui.screens.${name}`, name));
    const roots = new Set();
    for (const p of pats) {
      const bad = typeof p === 'string' ? glob.problem(p) : 'not a string';
      if (bad) { out.unresolved.push(issue(`ui.screens.${name}: pattern "${p}" is rejected: ${bad}`, 'designc.json', 1, `ui.screens.${name}`, name)); continue; }
      const hit = sources.filter(f => glob.match(p, f));
      if (!hit.length) out.unresolved.push(issue(`ui.screens.${name}: pattern "${p}" matches no source file`, 'designc.json', 1, `ui.screens.${name}`, name));
      hit.forEach(f => roots.add(f));
    }
    const rootList = [...roots].sort();
    const program = rootList.length ? ts.createProgram(rootList.map(f => path.join(repo, f)), options, ts.createCompilerHost(options, true)) : null;
    const compIds = new Set();
    for (const f of rootList) {
      const sf = program.getSourceFile(path.join(repo, f));
      if (!sf) { out.unresolved.push(issue(`${f} could not be parsed`, f, 1, '', name)); continue; }
      for (const c of scanFile(ts, sf, f, name, out)) { compIds.add(c.id); if (!seen.has(c.id)) { seen.set(c.id, c); out.components.push(c); } }
    }
    out.screens.push({ name, roots: rootList, components: [...compIds].sort() });
  }
  out.components.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

module.exports = { build, SCHEMA };
