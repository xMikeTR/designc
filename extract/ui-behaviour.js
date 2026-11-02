// The UI graph (phase 7, slice 7c): when a control is on screen, and its state props, read from source. Pure over
// TypeScript nodes; ui.js calls it. Nothing is evaluated: a condition is its source text, a prop that is not a literal
// is its source text. What the source shows for certain is kept as such (a literal true, a prop the usage did not give).

const capital = s => typeof s === 'string' && /^[A-Z]/.test(s);

// A function-like node that is a component (a capitalised function, arrow or function const, or class): the scan stops there.
function isComponent(ts, n) {
  if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n)) && n.name) return capital(n.name.text);
  if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent) {
    if (ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) return capital(n.parent.name.text);
    // memo((props) => ...), forwardRef(function (props, ref) {...}) assigned to a capitalised const
    for (let p = n.parent, i = 0; p && i < 3; p = p.parent, i++) {
      if (!ts.isCallExpression(p)) return ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && capital(p.name.text);
    }
  }
  return false;
}

// `if (c) return ...;` (or a block whose last statement is a return) with no else: an early return guarding what follows.
function earlyReturn(ts, st) {
  if (!ts.isIfStatement(st) || st.elseStatement) return false;
  const t = st.thenStatement;
  return ts.isReturnStatement(t) || (ts.isBlock(t) && t.statements.length > 0 && ts.isReturnStatement(t.statements[t.statements.length - 1]));
}

const not = s => `!(${s})`;

/* The conditions between a JSX node and the component it sits in, outermost first:
   and (`c && <x/>`), or (`c || <x/>`, as !(c)), ternary (`c ? <x/> : ...`, else branch !(c)), if (`if (c) { return <x/> }`,
   else branch !(c)) and if-return (an earlier `if (c) return ...;` in an enclosing block, as !(c)).
   Each is {kind, expr, file, line}; expr is source text. */
function whenOf(ts, sf, file, node) {
  const out = [];
  const at = n => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const add = (kind, expr, n) => out.push({ kind, expr: expr.replace(/\s+/g, ' ').trim(), file, line: at(n) });
  for (let child = node, p = node.parent; p; child = p, p = p.parent) {
    if (ts.isBinaryExpression(p) && p.right === child) {
      const op = p.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) add('and', p.left.getText(sf), p.left);
      else if (op === ts.SyntaxKind.BarBarToken) add('or', not(p.left.getText(sf)), p.left);
    } else if (ts.isConditionalExpression(p)) {
      if (p.whenTrue === child) add('ternary', p.condition.getText(sf), p.condition);
      else if (p.whenFalse === child) add('ternary', not(p.condition.getText(sf)), p.condition);
    } else if (ts.isIfStatement(p)) {
      if (p.thenStatement === child) add('if', p.expression.getText(sf), p.expression);
      else if (p.elseStatement === child) add('if', not(p.expression.getText(sf)), p.expression);
    } else if (ts.isBlock(p) || ts.isSourceFile(p)) {
      const i = p.statements.indexOf(child);
      for (let k = i - 1; k >= 0; k--) if (earlyReturn(ts, p.statements[k])) add('if-return', not(p.statements[k].expression.getText(sf)), p.statements[k].expression);
    }
    if (isComponent(ts, p)) break;
  }
  return out.reverse();
}

// State props of a control: disabled, readOnly, hidden, required (and their aria- forms). A bare or literal attribute is
// true (aria-* "false" is false and dropped); an expression is its source text. An attribute that is absent is left out.
const PROPS = { disabled: ['disabled', 'aria-disabled'], readOnly: ['readOnly', 'aria-readonly'], hidden: ['hidden', 'aria-hidden'], required: ['required', 'aria-required'] };
function propsOf(attrs) {
  const out = {};
  for (const [key, names] of Object.entries(PROPS)) {
    for (const name of names) {
      const a = attrs[name];
      if (!a) continue;
      if (a.literal != null) { if (name.startsWith('aria-') && a.literal.trim() === 'false') continue; out[key] = true; break; }
      if (a.expr === 'false') continue;
      out[key] = a.expr === 'true' ? true : a.expr; break;
    }
  }
  return out;
}

module.exports = { whenOf, propsOf, isComponent };
