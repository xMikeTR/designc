// The UI graph (phase 7, slice 7d): how values are formatted and what a form checks, read from source. Pure over
// TypeScript nodes; ui.js calls it. Imports are read from the file's own import declarations, so no library needs to be
// installed. Nothing is evaluated: a pattern is kept only when it is a literal; otherwise it is null and `args` holds the
// source text.
const squash = s => s.replace(/\s+/g, ' ').trim();

// Local name -> {module, name} from the file's imports ('default', '*' or the imported name).
function importsOf(ts, sf) {
  const out = new Map();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const module = st.moduleSpecifier.text, cl = st.importClause;
    if (cl.name) out.set(cl.name.text, { module, name: 'default' });
    const nb = cl.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) out.set(nb.name.text, { module, name: '*' });
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) out.set(el.name.text, { module, name: (el.propertyName || el.name).text });
  }
  return out;
}

const DATE_LIBS = new Set(['dayjs', 'moment']);
const TO_LOCALE = new Set(['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString']);
const literalText = (ts, e) => e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : null;
// True when an expression holds only literals (strings, numbers, booleans, arrays and objects of them).
function allLiteral(ts, e) {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e) || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isArrayLiteralExpression(e)) return e.elements.every(x => allLiteral(ts, x));
  if (ts.isObjectLiteralExpression(e)) return e.properties.every(p => ts.isPropertyAssignment(p) && allLiteral(ts, p.initializer));
  return false;
}

/* One formatting call, or null: Intl.*Format (new or called), x.toLocale*String(...), date-fns format(d, 'p'),
   dayjs(d).format('p') and moment(d).format('p'). {lib, call, pattern, args}. */
function formatCall(ts, sf, imports, n) {
  const args = n.arguments ? n.arguments : [];
  const argText = list => squash(list.map(a => a.getText(sf)).join(', '));
  if ((ts.isNewExpression(n) || ts.isCallExpression(n)) && ts.isPropertyAccessExpression(n.expression)
    && n.expression.expression.getText(sf) === 'Intl' && /Format$/.test(n.expression.name.text)) {
    return { lib: 'Intl', call: `Intl.${n.expression.name.text}`, pattern: args.length && args.every(a => allLiteral(ts, a)) ? argText(args) : null, args: argText(args) };
  }
  if (!ts.isCallExpression(n)) return null;
  const callee = n.expression;
  if (ts.isPropertyAccessExpression(callee) && TO_LOCALE.has(callee.name.text)) {
    return { lib: 'toLocale', call: callee.name.text, pattern: args.length && args.every(a => allLiteral(ts, a)) ? argText(args) : null, args: argText(args) };
  }
  if (ts.isIdentifier(callee)) {
    const im = imports.get(callee.text);
    if (im && im.module === 'date-fns' && im.name === 'format') return { lib: 'date-fns', call: 'format', pattern: literalText(ts, args[1]), args: argText(args) };
  }
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'format' && ts.isCallExpression(callee.expression) && ts.isIdentifier(callee.expression.expression)) {
    const im = imports.get(callee.expression.expression.text);
    if (im && DATE_LIBS.has(im.module) && im.name === 'default') return { lib: im.module, call: 'format', pattern: literalText(ts, args[0]), args: argText(args) };
  }
  return null;
}

// Every formatting call under `node` (inclusive), with its line. Nested calls are each listed.
function formatsIn(ts, sf, file, imports, node) {
  const out = [];
  const walk = n => {
    const f = formatCall(ts, sf, imports, n);
    if (f) out.push({ ...f, file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, node: n });
    ts.forEachChild(n, walk);
  };
  walk(node);
  return out;
}

// A rule's value: a literal (number, string, boolean, regex source), {value} of an RHF rule object, else source text.
function ruleValue(ts, sf, e) {
  if (!e) return true;
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isRegularExpressionLiteral(e)) return e.text;
  if (ts.isObjectLiteralExpression(e)) {
    const v = e.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'value');
    if (v) return ruleValue(ts, sf, v.initializer);
  }
  return squash(e.getText(sf));
}
const lineOf = (sf, n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

// A zod or yup chain such as z.string().min(1).max(40).optional(): the base as {rule: 'type'} then each call, in order.
function chainRules(ts, sf, file, e) {
  const calls = [];
  for (let x = e; x && ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression); x = x.expression.expression) calls.unshift(x);
  if (!calls.length) return null;
  return calls.map((c, i) => i === 0
    ? { rule: 'type', value: c.expression.name.text, file, line: lineOf(sf, c) }
    : { rule: c.expression.name.text, value: ruleValue(ts, sf, c.arguments[0]), file, line: lineOf(sf, c) });
}

/* Form schemas declared in a file: const x = z.object({...}) (zod) or yup.object({...}) / yup.object().shape({...}).
   Each is {form, lib, file, line, fields: [{name, rules}]}; a field whose value is not a chain has rules []. */
function formsIn(ts, sf, file, imports) {
  const out = [];
  const libOf = id => { const im = imports.get(id); return im && (im.module === 'zod' || im.module === 'yup') ? im.module : null; };
  const objectOf = init => {
    if (!init || !ts.isCallExpression(init) || !ts.isPropertyAccessExpression(init.expression)) return null;
    const pa = init.expression;
    if (pa.name.text === 'object' && ts.isIdentifier(pa.expression) && libOf(pa.expression.text)) return { lib: libOf(pa.expression.text), arg: init.arguments[0] };
    if (pa.name.text === 'shape' && ts.isCallExpression(pa.expression)) { const inner = objectOf(pa.expression); return inner && { lib: inner.lib, arg: init.arguments[0] }; }
    return null;
  };
  const walk = n => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const o = objectOf(n.initializer);
      if (o && o.arg && ts.isObjectLiteralExpression(o.arg)) {
        const fields = o.arg.properties.filter(p => ts.isPropertyAssignment(p)).map(p => ({ name: literalText(ts, p.name) || p.name.getText(sf), rules: chainRules(ts, sf, file, p.initializer) || [] }));
        out.push({ form: n.name.text, lib: o.lib, file, line: lineOf(sf, n), fields });
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

// One react-hook-form rule: `required: 'msg'` is required with a message; `{value, message}` keeps both.
function rhfRule(ts, sf, file, p) {
  const rule = p.name.getText(sf), init = p.initializer;
  const msgProp = ts.isObjectLiteralExpression(init) && init.properties.find(x => ts.isPropertyAssignment(x) && x.name.getText(sf) === 'message');
  const message = msgProp ? ruleValue(ts, sf, msgProp.initializer) : rule === 'required' && literalText(ts, init) != null ? literalText(ts, init) : null;
  const value = rule === 'required' && literalText(ts, init) != null ? true : ruleValue(ts, sf, init);
  return { rule, value, ...(message != null ? { message } : {}), file, line: lineOf(sf, p) };
}

// A react-hook-form register spread on an element: {...register('name', {required: true, maxLength: 40})}
// (register or x.register). {name, rules, expr?}; name is null when not a literal.
function registerOf(ts, sf, file, opening) {
  for (const a of opening.attributes.properties) {
    if (!ts.isJsxSpreadAttribute(a) || !ts.isCallExpression(a.expression)) continue;
    const call = a.expression, callee = call.expression;
    const fn = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
    if (fn !== 'register') continue;
    const name = literalText(ts, call.arguments[0]);
    const opts = call.arguments[1];
    const rules = opts && ts.isObjectLiteralExpression(opts)
      ? opts.properties.filter(p => ts.isPropertyAssignment(p)).map(p => rhfRule(ts, sf, file, p))
      : [];
    return { name, rules, ...(name == null && call.arguments[0] ? { expr: squash(call.arguments[0].getText(sf)) } : {}) };
  }
  return null;
}

module.exports = { importsOf, formatsIn, formsIn, registerOf };
