// The UI graph (phase 7, slice 7b): following a capitalised JSX tag to the in-repo component it names, and carrying the
// usage site's props into it. Pure over TypeScript nodes; ui.js owns the scan. Nothing is guessed: a prop the usage does
// not give is absent (or its literal default), and a tag whose declaration is a library's .d.ts is never followed.
const path = require('path');

// Props an interactive library component carries; used only to decide that a library tag is worth listing as a control.
const INTERACTIVE = new Set(['onClick', 'onChange', 'onSelect', 'onSubmit', 'onPress', 'onToggle', 'href', 'to', 'checked', 'value', 'label', 'aria-label']);

// What a tag names: {kind: 'local'} (declared in a root, scanned directly), {kind: 'follow', fn, decl, file, name},
// {kind: 'library', from}, or {kind: 'unknown'}.
function resolveTag(ts, checker, repo, roots, tagNode) {
  let sym = checker.getSymbolAtLocation(tagNode);
  if (sym && sym.flags & ts.SymbolFlags.Alias) { try { sym = checker.getAliasedSymbol(sym); } catch { sym = null; } }
  const decl = sym && sym.declarations && sym.declarations[0];
  if (!decl) return { kind: 'unknown' };
  const abs = decl.getSourceFile().fileName, rel = path.relative(repo, abs).split(path.sep).join('/');
  if (rel.startsWith('..') || path.isAbsolute(rel) || /(^|\/)node_modules\//.test(rel) || decl.getSourceFile().isDeclarationFile) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(abs.split(path.sep).join('/'));
    return { kind: 'library', from: m ? m[1] : path.basename(abs) };
  }
  if (roots.has(rel)) return { kind: 'local' };
  const fn = componentFn(ts, decl);
  if (!fn) return { kind: 'unknown', file: rel };
  return { kind: 'follow', fn, decl, file: rel, name: sym.name === 'default' ? path.basename(rel).replace(/\.[^.]+$/, '') : sym.name };
}

// The function (or class) a declaration renders with: a function, an arrow or function const, memo(fn)/forwardRef(fn), a class.
function componentFn(ts, decl) {
  if (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl)) return decl;
  let init = ts.isVariableDeclaration(decl) ? decl.initializer : ts.isExportAssignment(decl) ? decl.expression : null;
  for (let i = 0; init && i < 3 && ts.isCallExpression(init); i++) init = init.arguments[0];
  return init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isClassExpression(init)) ? init : null;
}

// How the component reads its props: destructured locals (local -> prop, with literal defaults), a rest name, a props name.
function propsBinding(ts, fn) {
  const b = { locals: new Map(), defaults: new Map(), rest: null, props: null, cls: ts.isClassDeclaration(fn) || ts.isClassExpression(fn) };
  const p = !b.cls && fn.parameters && fn.parameters[0];
  if (!p) return b;
  if (ts.isIdentifier(p.name)) b.props = p.name.text;
  else if (ts.isObjectBindingPattern(p.name)) for (const el of p.name.elements) {
    if (!ts.isIdentifier(el.name)) continue;
    if (el.dotDotDotToken) { b.rest = el.name.text; continue; }
    const prop = el.propertyName ? el.propertyName.getText() : el.name.text;
    b.locals.set(el.name.text, prop);
    if (el.initializer && (ts.isStringLiteral(el.initializer) || ts.isNoSubstitutionTemplateLiteral(el.initializer))) b.defaults.set(prop, el.initializer.text);
  }
  return b;
}

/* An environment for one followed use: the usage's attrs ({name: {literal, expr?, tkey?}}), its children as content
   parts, and the binding. resolve(ex) gives the usage's value for a prop read, {absent: true} for a prop not given,
   {children} for children, or null when ex is not a prop read. spread(ex) gives the attrs a {...rest}/{...props} passes. */
function environment(ts, binding, attrs, children) {
  const propOf = ex => {
    if (ts.isIdentifier(ex) && binding.locals.has(ex.text)) return binding.locals.get(ex.text);
    if (ts.isPropertyAccessExpression(ex)) {
      const on = ex.expression.getText();
      if ((binding.props && on === binding.props) || (binding.cls && on === 'this.props')) return ex.name.text;
    }
    return null;
  };
  const resolve = ex => {
    const prop = propOf(ex);
    if (prop == null) return null;
    if (prop === 'children') return { children };
    if (attrs[prop]) return attrs[prop];
    return binding.defaults.has(prop) ? { literal: binding.defaults.get(prop) } : { absent: true };
  };
  const spread = ex => {
    const t = ex.getText();
    if (binding.rest && t === binding.rest) {
      const taken = new Set(binding.locals.values());
      return Object.fromEntries(Object.entries(attrs).filter(([k]) => !taken.has(k)));
    }
    if ((binding.props && t === binding.props) || (binding.cls && t === 'this.props')) return { ...attrs };
    return null;
  };
  return { resolve, spread };
}

module.exports = { resolveTag, propsBinding, environment, INTERACTIVE };
