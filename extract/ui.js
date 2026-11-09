// The UI graph (phase 7, slices 7a-7e): the controls of each screen named in designc.json `ui.screens`, read from
// source with the TypeScript compiler API. Display only, like facts.code: never a gate input, finding, DSL line or
// fingerprint input. One program per screen over its roots and, through the compiler, their imports. Controls in the
// roots are read directly; an in-repo component a root renders is followed (ui-follow.js) with the usage's props, and its
// controls are listed at the usage site with basis `followed` and `via`. A library's (.d.ts) component is never followed. Nothing is guessed: a control whose role the source cannot show gets
// role null and an unresolved entry, unless designc.json `ui.roles` names its tag (basis `mapped`). One repo is read per
// build: the codebase, or a `references` key (`key`). TypeScript is required lazily, here and only here (Node, main process).
const path = require('path');
const glob = require('./glob');
const roles = require('./ui-roles');
const { resolveTag, propsBinding, environment, INTERACTIVE } = require('./ui-follow');
const behaviour = require('./ui-behaviour');
const formats = require('./ui-formats');

const SCHEMA = 'designc.ui.graph/1';
const SOURCE_RE = /\.(tsx|ts|jsx|js|mjs|cjs)$/i;
const isSource = f => SOURCE_RE.test(f) && !/\.d\.ts$/i.test(f);

let TS = null;
function loadTs() { if (!TS) TS = require('typescript'); return TS; }

const issue = (what, file, line, text, screen) => ({ where: 'ui', what, file, line, text, ...(screen ? { screen } : {}) });
const squash = s => s.replace(/\s+/g, ' ').trim();
const capital = n => /^[A-Z]/.test(n || '');

// Compiler options from the configured tsconfig (paths, baseUrl, jsx), with what a read-only scan needs on top.
function compilerOptions(ts, repo, tsconfigRel, out, repoLabel = 'codebase') {
  let options = {};
  if (tsconfigRel) {
    const abs = path.resolve(repo, tsconfigRel);
    if (abs !== repo && !abs.startsWith(repo + path.sep)) out.push(issue(`ui.tsconfig "${tsconfigRel}" is outside the ${repoLabel}, so it was not read`, 'designc.json', 1, 'ui.tsconfig'));
    else {
      const read = ts.readConfigFile(abs, ts.sys.readFile);
      if (read.error) out.push(issue(`ui.tsconfig could not be read: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`, 'designc.json', 1, 'ui.tsconfig'));
      else options = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(abs), undefined, abs).options;
    }
  }
  return { ...options, allowJs: true, noEmit: true, noLib: true, types: [], skipLibCheck: true, jsx: options.jsx || ts.JsxEmit.Preserve };
}

// The value an expression gives: a literal, a prop the usage passed (inside a followed component), a t('key'), or
// source text. {absent: true} is a prop the usage did not give; {children} is the usage's children.
function valueOf(ts, ctx, ex) {
  if (!ex) return { literal: 'true' };
  if (ts.isStringLiteral(ex) || ts.isNoSubstitutionTemplateLiteral(ex)) return { literal: ex.text };
  if (ctx.env) { const r = ctx.env.resolve(ex); if (r) return r; }
  const k = i18nKey(ts, ctx.sf, ex);
  return { literal: null, expr: ex.getText(ctx.sf), ...(k != null ? { tkey: k } : {}) };
}

// Attributes of a JSX opening element: {name: {literal, expr?, tkey?}}, later ones winning as in JSX. A spread is merged
// when it passes a followed component's props on, else counted in `spreads`.
function attrsOf(ts, ctx, opening) {
  const attrs = {}; let spreads = 0;
  for (const a of opening.attributes.properties) {
    if (ts.isJsxSpreadAttribute(a)) {
      const passed = ctx.env && ctx.env.spread(a.expression);
      if (passed) Object.assign(attrs, passed); else spreads++;
      continue;
    }
    const name = a.name.getText(ctx.sf), init = a.initializer;
    const v = !init ? { literal: 'true' } : ts.isStringLiteral(init) ? { literal: init.text } : valueOf(ts, ctx, ts.isJsxExpression(init) ? init.expression : init);
    if (v.absent) { delete attrs[name]; continue; }
    attrs[name] = v.children ? { literal: null, expr: 'children' } : v;
  }
  return { attrs, spreads };
}

const tagOf = (sf, el) => el.tagName.getText(sf);
const openingOf = (ts, n) => (ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null);
const i18nKey = (ts, sf, ex) => (ex && ts.isCallExpression(ex) && /^(t|i18n\.t|intl\.formatMessage)$/.test(ex.expression.getText(sf)) && ex.arguments[0]
  && (ts.isStringLiteral(ex.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(ex.arguments[0])) ? ex.arguments[0].text : null);

// The content of an element as name parts, in order: literal text, t('key'), other expressions. `skip` leaves a node out.
function contentOf(ts, ctx, node, skip) {
  const parts = [];
  const visit = n => {
    if (n === skip) return;
    if (ts.isJsxText(n)) { const s = squash(n.text); if (s) parts.push({ kind: 'text', value: s }); return; }
    if (ts.isJsxExpression(n)) {
      if (!n.expression) return;
      const v = valueOf(ts, ctx, n.expression);
      if (v.absent) return;
      if (v.children) { parts.push(...v.children); return; }
      if (v.literal != null) { const s = squash(v.literal); if (s) parts.push({ kind: 'text', value: s }); return; }
      parts.push(v.tkey != null ? { kind: 't()', value: v.tkey } : { kind: 'expr', expr: v.expr });
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

const MAX_DEPTH = 8;

/* One screen's scan. A context is {sf, file, env, site, hops, stack}: a root file has no env and no site; a followed
   component has the usage's env, the outermost usage site in a root (where its controls are listed) and the hops. */
function screenScanner(ts, program, repo, roots, screen, out, roleMap = new Map()) {
  const checker = program.getTypeChecker();
  const indexes = new Map();
  const followed = new Set();
  const importsCache = new Map(), formatIds = new Set(), formIds = new Set();
  const importsOf = sf => importsCache.get(sf) || importsCache.set(sf, formats.importsOf(ts, sf)).get(sf);
  // Formatting calls (each listed once per screen) and form schemas (once per file and form) under a node.
  const formatAt = f => ({ lib: f.lib, call: f.call, pattern: f.pattern, args: f.args, file: f.file, line: f.line });
  function scanFormats(sf, file, node, component) {
    for (const f of formats.formatsIn(ts, sf, file, importsOf(sf), node)) {
      const id = `${screen}:${file}:${where(sf, f.node)}`;
      if (formatIds.has(id)) continue;
      formatIds.add(id);
      out.formats.push({ id, screen, component: component || `${file}#${componentAt(ts, f.node, file).name}`, ...formatAt(f) });
    }
  }
  function scanForms(sf, file) {
    for (const f of formats.formsIn(ts, sf, file, importsOf(sf))) {
      const id = `${screen}:${file}#${f.form}`;
      if (formIds.has(id)) continue;
      formIds.add(id);
      out.forms.push({ id, screen, ...f });
    }
  }
  const pos = (sf, n) => sf.getLineAndCharacterOfPosition(n.getStart(sf));
  const lineOf = (sf, n) => pos(sf, n).line + 1;
  const where = (sf, n) => { const p = pos(sf, n); return `${p.line + 1}:${p.character + 1}`; };

  // Ids and labels in a file: <x id="a">text</x> for aria-labelledby, <label htmlFor="a">text</label> for inputs.
  function indexOf(sf) {
    if (indexes.has(sf)) return indexes.get(sf);
    const ix = { byId: new Map(), labelFor: new Map() };
    const walk = n => {
      const op = openingOf(ts, n);
      if (op) {
        const lit = k => { const a = op.attributes.properties.find(x => ts.isJsxAttribute(x) && x.name.getText(sf) === k); return a && a.initializer && ts.isStringLiteral(a.initializer) ? a.initializer.text : null; };
        const id = lit('id'); if (id != null) ix.byId.set(id, n);
        const hf = lit('htmlFor'); if (tagOf(sf, op) === 'label' && hf != null) ix.labelFor.set(hf, n);
      }
      ts.forEachChild(n, walk);
    };
    walk(sf); indexes.set(sf, ix); return ix;
  }

  // The components a root file declares, each with the capitalised tags it renders.
  function componentsOf(sf, file) {
    const comps = new Map();
    const add = (n, tag) => { const c = componentAt(ts, n, file); const e = comps.get(c.name) || comps.set(c.name, { renders: new Set(), node: c.node }).get(c.name); if (tag) e.renders.add(tag); };
    const walk = n => {
      const op = openingOf(ts, n);
      if (op && capital(tagOf(sf, op))) add(n, tagOf(sf, op));
      else if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) add(n);
      ts.forEachChild(n, walk);
    };
    walk(sf);
    return [...comps.entries()].map(([name, v]) => ({ id: `${file}#${name}`, name, file, line: v.node ? lineOf(sf, v.node) : 1, renders: [...v.renders].sort(), basis: 'declared' }));
  }

  function visit(ctx, n) {
    const op = openingOf(ts, n);
    if (op) {
      const tag = tagOf(ctx.sf, op);
      if (/^[a-z]/.test(tag) && !tag.includes('.')) control(ctx, n, op, tag);
      else if (capital(tag) || tag.includes('.')) use(ctx, n, op, tag);
    }
    ts.forEachChild(n, c => visit(ctx, c));
  }

  // Where a control is listed: the outermost usage in a root, else the element itself.
  const placeOf = (ctx, n) => ctx.site || { file: ctx.file, line: lineOf(ctx.sf, n), where: where(ctx.sf, n), component: `${ctx.file}#${componentAt(ts, n, ctx.file).name}` };
  const idOf = (ctx, n) => `${screen}:${ctx.site ? ctx.site.chain + '>' : ''}${ctx.file}:${where(ctx.sf, n)}`;

  // A capitalised tag: follow an in-repo component; list an interactive library or unresolvable one as a control with no role.
  function use(ctx, n, op, tag) {
    const r = resolveTag(ts, checker, repo, roots, op.tagName);
    if (r.kind === 'local') return;
    const { attrs, spreads } = attrsOf(ts, ctx, op);
    if (r.kind === 'follow') {
      const place = placeOf(ctx, n), chain = `${ctx.site ? ctx.site.chain + '>' : ''}${ctx.file}:${where(ctx.sf, n)}`;
      if (ctx.stack.includes(r.fn) || ctx.stack.length >= MAX_DEPTH) {
        out.unresolved.push(issue(`<${tag}> was not followed further: ${ctx.stack.includes(r.fn) ? 'it renders itself' : `more than ${MAX_DEPTH} components deep`}`, place.file, place.line, op.getText(ctx.sf).slice(0, 120), screen));
        return;
      }
      const id = `${r.file}#${r.name}`, fsf = r.fn.getSourceFile();
      if (!followed.has(id)) { followed.add(id); if (!out.components.some(c => c.id === id)) out.components.push({ id, name: r.name, file: r.file, line: lineOf(fsf, r.fn), renders: [], basis: 'followed' }); }
      const env = environment(ts, propsBinding(ts, r.fn), attrs, contentOf(ts, ctx, n));
      const next = { sf: fsf, file: r.file, env, site: { ...place, chain, as: ctx.site ? ctx.site.as : tag }, hops: ctx.hops.concat({ component: id, file: r.file, line: lineOf(fsf, r.fn) }), stack: ctx.stack.concat(r.fn), when: ctx.when.concat(behaviour.whenOf(ts, ctx.sf, ctx.file, n)) };
      ts.forEachChild(r.fn, c => visit(next, c));
      scanFormats(fsf, r.file, r.fn, id); scanForms(fsf, r.file);
      return;
    }
    // ui.roles names the tag: a person said what it is, so it is a control even with no interactive prop.
    const mapped = roleMap.get(tag);
    if (!mapped && !Object.keys(attrs).some(k => INTERACTIVE.has(k))) return;
    const place = placeOf(ctx, n);
    const own = mapped && mapped.name && attrs[mapped.name] ? attrNames(attrs, [mapped.name]) : [];
    const names = own.concat(attrNames(attrs, ['aria-label', 'label', 'title']).concat(partsToNames('text', contentOf(ts, ctx, n))).filter(x => !own.length || x.from !== mapped.name));
    const c = { id: idOf(ctx, n), screen, component: place.component, file: place.file, line: place.line, tag, role: mapped ? mapped.role : null, basis: mapped ? 'mapped' : null, name: firstLiteral(names), names,
      ...(r.kind === 'library' ? { library: r.from } : {}), ...(ctx.site ? { as: ctx.site.as } : {}), ...(ctx.hops.length ? { via: ctx.hops, at: { file: ctx.file, line: lineOf(ctx.sf, n) } } : {}), ...(spreads ? { spreads } : {}) };
    finish(ctx, n, op, attrs, c);
    if (mapped && r.kind === 'library') return;
    out.unresolved.push(issue(r.kind === 'library'
      ? `<${tag}> comes from ${r.from}, a library whose source is not read; its role is not in source (name it in designc.json ui.roles)`
      : `<${tag}> could not be resolved to a declaration`, place.file, place.line, op.getText(ctx.sf).slice(0, 120), screen));
  }

  const attrNames = (attrs, keys) => keys.filter(k => attrs[k]).map(k => attrs[k].literal != null ? { from: k, value: squash(attrs[k].literal) } : { from: k, value: null, expr: attrs[k].expr });
  const firstLiteral = names => { const f = names[0]; return f && f.from !== 't()' && f.value ? f.value : null; };

  function control(ctx, n, op, tag) {
    const { attrs, spreads } = attrsOf(ts, ctx, op);
    const r = roles.roleOf(tag, attrs);
    if (!r.control) return;
    const sf = ctx.sf, ix = indexOf(sf), textNames = (from, x, skip) => (x ? partsToNames(from, contentOf(ts, ctx, x, skip)) : []);
    const names = [];
    if (attrs['aria-labelledby']) {
      const a = attrs['aria-labelledby'];
      if (a.literal == null) names.push({ from: 'aria-labelledby', value: null, expr: a.expr });
      else for (const id of a.literal.trim().split(/\s+/)) {
        const target = ix.byId.get(id);
        const ns = target ? textNames('aria-labelledby', target) : [];
        names.push(...(ns.length ? ns.map(x => ({ ...x, ref: id })) : [{ from: 'aria-labelledby', value: null, ref: id }]));
      }
    }
    names.push(...attrNames(attrs, ['aria-label']));
    // <label>text <input/></label> around it, or <label htmlFor=id> in the same file.
    if (['input', 'select', 'textarea', 'button'].includes(tag)) {
      for (let p = n.parent; p; p = p.parent) {
        const pop = openingOf(ts, p);
        if (pop && tagOf(sf, pop) === 'label') { names.push(...textNames('label', p, n)); break; }
      }
      if (attrs.id && attrs.id.literal != null && ix.labelFor.has(attrs.id.literal)) names.push(...textNames('label', ix.labelFor.get(attrs.id.literal)));
    }
    const type = attrs.type && attrs.type.literal ? attrs.type.literal.toLowerCase() : null;
    if (tag === 'input' && type === 'image') names.push(...attrNames(attrs, ['alt']));
    if (r.role && roles.NAME_FROM_CONTENT.has(r.role) && tag !== 'input') names.push(...textNames('text', n));
    if (tag === 'input' && ['submit', 'button', 'reset'].includes(type)) names.push(...attrNames(attrs, ['value']));
    names.push(...attrNames(attrs, ['title']));
    if (tag === 'input' || tag === 'textarea') names.push(...attrNames(attrs, ['placeholder']));
    // The first source present decides: a literal is the name; an expression or t('key') there means the source cannot say.
    const decides = roles.NAME_ORDER.map(f => names.find(x => (x.from === 't()' ? 'text' : x.from) === f)).find(Boolean);
    const named = decides && decides.from !== 't()' && decides.value ? decides : null;
    const place = placeOf(ctx, n);
    const c = {
      id: idOf(ctx, n), screen, component: place.component, file: place.file, line: place.line, tag,
      role: r.role, basis: r.role && ctx.site ? 'followed' : r.basis, name: named ? named.value : null, names,
      ...(ctx.site ? { as: ctx.site.as } : {}),
      ...(ctx.hops.length ? { via: ctx.hops, at: { file: ctx.file, line: lineOf(sf, op) } } : {}),
      ...(spreads ? { spreads } : {}),
    };
    finish(ctx, n, op, attrs, c);
    if (!r.role) out.unresolved.push(issue(`<${tag}> has no role the source can show: ${r.reason}`, place.file, place.line, op.getText(sf).slice(0, 120), screen));
  }

  // When the control is on screen (the usage chain's conditions, then its own; outermost first) and its state props.
  // A format: the first formatting call inside the element. A field: a react-hook-form register spread on it (its form
  // and the schema's rules are joined per screen in build).
  function finish(ctx, n, op, attrs, c) {
    const when = ctx.when.concat(behaviour.whenOf(ts, ctx.sf, ctx.file, n)), props = behaviour.propsOf(attrs);
    if (when.length) c.when = when;
    if (Object.keys(props).length) c.props = props;
    const fm = formats.formatsIn(ts, ctx.sf, ctx.file, importsOf(ctx.sf), n)[0];
    if (fm) c.format = formatAt(fm);
    const reg = formats.registerOf(ts, ctx.sf, ctx.file, op);
    if (reg) c.field = { form: null, ...reg };
    out.controls.push(c);
  }

  return {
    root(sf, file) { visit({ sf, file, env: null, site: null, hops: [], stack: [], when: [] }, sf); scanFormats(sf, file, sf); scanForms(sf, file); return componentsOf(sf, file); },
    followed: () => [...followed].sort(),
  };
}

// A registered field takes the one form schema of its screen that names it (its rules first, then the register's own).
// None: form stays null. Several: form null and an unresolved entry, never a pick.
function joinFields(out, screen) {
  const forms = out.forms.filter(f => f.screen === screen);
  for (const c of out.controls) {
    if (c.screen !== screen || !c.field || c.field.name == null) continue;
    const hits = forms.filter(f => f.fields.some(x => x.name === c.field.name));
    if (hits.length === 1) {
      const field = hits[0].fields.find(x => x.name === c.field.name);
      c.field = { ...c.field, form: hits[0].form, rules: field.rules.concat(c.field.rules) };
    } else if (hits.length > 1) {
      out.unresolved.push(issue(`Field "${c.field.name}" is named by ${hits.length} forms (${hits.map(f => f.form).join(', ')}), so its form rules were not joined`, c.file, c.line, c.field.name, screen));
    }
  }
}

// designc.json ui.roles ({Tag: {role, name?}}): a widget role for a tag the source cannot show, and the prop naming it.
// A bad entry is unresolved and not applied.
function roleMapOf(map, out) {
  const res = new Map();
  if (map == null) return res;
  if (typeof map !== 'object' || Array.isArray(map)) { out.push(issue('ui.roles must be an object of {role, name?} by tag', 'designc.json', 1, 'ui.roles')); return res; }
  for (const [tag, v] of Object.entries(map)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) { out.push(issue(`ui.roles.${tag}: must be {role, name?}`, 'designc.json', 1, 'ui.roles')); continue; }
    if (!roles.WIDGET_ROLES.has(v.role)) { out.push(issue(`ui.roles.${tag}: role "${v.role}" is not a widget role`, 'designc.json', 1, 'ui.roles')); continue; }
    if (v.name != null && (typeof v.name !== 'string' || !v.name)) { out.push(issue(`ui.roles.${tag}: name must be the prop that names it`, 'designc.json', 1, 'ui.roles')); continue; }
    res.set(tag, { role: v.role, ...(v.name ? { name: v.name } : {}) });
  }
  return res;
}

/* ui: designc.json `ui` ({tsconfig?: {<repo key>: path}, screens: {name: {<repo key>: [patterns]}}, roles?}).
   key: the repo read, `codebase` or a designc.json `references` key; keys: the references keys there are (another key on a
   screen is unresolved). files: repo-relative source files from the walk. Returns facts.ui. */
function build({ repo, files, ui, key = 'codebase', keys = [] }) {
  const out = { schema: SCHEMA, repo: key, screens: [], components: [], controls: [], formats: [], forms: [], unresolved: [] };
  const screens = ui && ui.screens && typeof ui.screens === 'object' ? ui.screens : {};
  let ts;
  try { ts = loadTs(); } catch (e) { out.unresolved.push(issue(`The TypeScript compiler could not be loaded (${e.message}), so no screen was read`, 'designc.json', 1, 'ui.screens')); return out; }
  const tsconfig = ui && ui.tsconfig && typeof ui.tsconfig === 'object' ? ui.tsconfig[key] : null;
  const options = compilerOptions(ts, repo, tsconfig, out.unresolved, key === 'codebase' ? 'codebase' : `${key} repository`);
  const roleMap = roleMapOf(ui && ui.roles, out.unresolved);
  const known = new Set(['codebase', ...keys]);
  const sources = files.filter(isSource);
  const seen = new Map();
  for (const [name, def] of Object.entries(screens)) {
    for (const k of Object.keys(def || {})) if (!known.has(k)) out.unresolved.push(issue(`ui.screens.${name}.${k}: "${k}" is not a designc.json references key`, 'designc.json', 1, `ui.screens.${name}`, name));
    // A screen with no patterns for this repo is not part of its graph (it may live only in another repo).
    if (!def || def[key] == null) continue;
    const pats = [].concat(def[key]);
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
    if (program) {
      const scan = screenScanner(ts, program, repo, roots, name, out, roleMap);
      for (const f of rootList) {
        const sf = program.getSourceFile(path.join(repo, f));
        if (!sf) { out.unresolved.push(issue(`${f} could not be parsed`, f, 1, '', name)); continue; }
        for (const c of scan.root(sf, f)) { compIds.add(c.id); if (!seen.has(c.id)) { seen.set(c.id, c); out.components.push(c); } }
      }
      out.screens.push({ name, roots: rootList, components: [...compIds].sort(), followed: scan.followed() });
      joinFields(out, name);
    } else out.screens.push({ name, roots: rootList, components: [], followed: [] });
  }
  out.components.sort((a, b) => a.id.localeCompare(b.id));
  const byPlace = (a, b) => a.screen.localeCompare(b.screen) || a.file.localeCompare(b.file) || a.line - b.line;
  out.formats.sort(byPlace);
  out.forms.sort(byPlace);
  return out;
}

module.exports = { build, SCHEMA };
