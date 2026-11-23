// L1 slice 2: renderer/dsl-assist.js, the d.* completion and hover shared by app.js's Monaco providers and the LSP.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../renderer/dsl-assist.js');
const Vocabulary = require('../renderer/canvas/vocabulary.js');

const PROPS = D.props(Vocabulary), PROP = D.byKey(PROPS);
const at = (line, c) => D.completeAt(line, c === undefined ? line.length : c, PROP, PROPS);

test('props is the base table then the canvas vocabulary, in order; counts as at e05d17e', () => {
  assert.equal(D.BASE.length, 26);
  assert.equal(Vocabulary.propsList().length, 30);
  assert.equal(PROPS.length, 56);
  assert.deepEqual(PROPS.slice(0, 26), D.BASE);
  assert.deepEqual(PROPS.slice(26), Vocabulary.propsList());
  assert.equal(D.props().length, 26);
});

test('value branch: after "d.retry" " lists the values with from at the value start', () => {
  const line = '        "d.retry" "';
  const r = at(line);
  assert.deepEqual(r.items.map(i => i.label), ['none', 'fixed', 'backoff']);
  assert.equal(r.from, line.length); assert.equal(r.to, line.length);
  assert.ok(r.items.every(i => i.kind === 'value' && !i.snippet));
  const part = at('  "d.retry" "ba');
  assert.equal(part.from, '  "d.retry" "'.length); assert.equal(part.to, '  "d.retry" "ba'.length);
  assert.equal(at('  "d.timeout" "'), null);
  assert.equal(at('  "d.nope" "'), null);
});

test('key branch: after ", after "d. and after "d.ret, with snippet texts', () => {
  for (const [line, typed] of [['  "', ''], ['  "d.', 'd.'], ['  "d.ret', 'd.ret']]) {
    const r = at(line);
    assert.equal(r.items.length, PROPS.length);
    assert.equal(r.from, line.length - typed.length); assert.equal(r.to, line.length);
    assert.ok(r.items.every(i => i.kind === 'property' && i.snippet));
  }
  const items = at('  "d.').items;
  assert.equal(items.find(i => i.label === 'd.retry').insertText, 'd.retry" "${1|none,fixed,backoff|}');
  assert.equal(items.find(i => i.label === 'd.timeout').insertText, 'd.timeout" "${1}');
  assert.equal(items.find(i => i.label === 'd.suppress').detail, 'element or relationship');
});

test('nothing in plain text, and the cursor position bounds the prefix', () => {
  assert.equal(at('softwareSystem x'), null);
  assert.equal(at('  "d.retry" "none"', 1), null);
  assert.equal(at('  "d.idem" "x"', 7).from, 3);
});

test('hover: opening quote, inside, closing quote and one past hit; two past misses', () => {
  const line = '   "d.idempotent" "no"';
  const s = line.indexOf('"'), len = '"d.idempotent"'.length;
  for (const c of [s, s + 5, s + len - 1, s + len]) {
    const h = D.hoverAt(line, c, PROP);
    assert.ok(h, `col ${c}`);
    assert.equal(h.from, s); assert.equal(h.to, s + len);
    assert.match(h.markdown[0], /^\*\*d\.idempotent\*\* · relationship$/);
    assert.match(h.markdown[1], /Values: `yes` \| `no`/);
  }
  assert.equal(D.hoverAt(line, s - 1, PROP), null);
  assert.equal(D.hoverAt(line, s + len + 1, PROP), null);
});

test('hover on an unknown d.zzz says it is not a design property', () => {
  const h = D.hoverAt('"d.zzz" "1"', 2, PROP);
  assert.deepEqual(h.markdown, ['**d.zzz** is not a design property']);
});
