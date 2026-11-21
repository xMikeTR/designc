// L2 slice 1: Core.parse records positions in m.symbols and changes nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Core = require('../renderer/core.js');
const Headless = require('../headless/index.js');
const { snapshot } = require('./helpers/l2-invariance.js');

const ROOT = path.join(__dirname, '..');
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const parse = (src, files = {}) => Core.parse(src, { path: 'w.dsl', resolve: p => files[p] ?? null });

test('findings, fingerprints, verdict hashes and parse errors are as at 8886021', () => {
  const want = JSON.parse(rd('test/data/l2-invariance.json'));
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot())), want);
});

test('parse gains exactly one key: symbols', () => {
  const m = Core.parse('model { a = person "A" }');
  assert.deepEqual(Object.keys(m), ['name', 'elements', 'rels', 'errors', 'relById', 'label', 'isAncestor', 'locEl', 'locRel', 'symbols', 'sources', 'deployment']);
  assert.deepEqual(Object.keys(m.symbols), ['defs', 'refs', 'includes']);
  const el = [...m.elements.values()][0];
  assert.deepEqual(Object.keys(el), ['id', 'ident', 'name', 'kind', 'tags', 'technology', 'description', 'parent', 'props', 'line', 'file']);
});

test('sample-registry: bookings has its identifier and name positions, and two rel-dst refs', () => {
  const m = Core.parse(rd('sample-registry/model/workspace.dsl'));
  const d = m.symbols.defs.find(x => x.ident === 'bookings');
  assert.deepEqual(d.identAt, { file: null, line: 53, c: 6, n: 8 });
  assert.deepEqual(d.nameAt, { file: null, line: 53, c: 27, n: 13 });
  const lines = rd('sample-registry/model/workspace.dsl').split('\n');
  assert.equal(lines[52].substr(27, 13), '"Bookings DB"');
  const refs = m.symbols.refs.filter(r => r.ident === 'bookings');
  assert.deepEqual(refs.map(r => [r.role, r.at.line, r.id]), [['rel-dst', 76, 'bookings'], ['rel-dst', 103, 'bookings']]);
  for (const r of refs) assert.equal(lines[r.at.line - 1].substr(r.at.c, r.at.n), 'bookings');
});

test('an implicit -> inside an element block has no rel-src ref; an unknown destination has id null', () => {
  const m = Core.parse('model {\n a = softwareSystem "A" {\n  -> b "x"\n  -> zz\n }\n b = softwareSystem "B"\n a -> b\n}');
  const src = m.symbols.refs.filter(r => r.role === 'rel-src');
  assert.deepEqual(src.map(r => [r.ident, r.at.line, r.id]), [['a', 7, 'a']]);
  assert.deepEqual(m.symbols.refs.filter(r => r.role === 'rel-dst').map(r => [r.ident, r.id]), [['b', 'b'], ['zz', null], ['b', 'b']]);
});

test('include-model: the def is in the included file, the refs are in relationships.dsl', () => {
  const dir = path.join(ROOT, 'fixtures/include-model');
  const m = Core.parse(rd('fixtures/include-model/workspace.dsl'), { path: 'model/workspace.dsl', resolve: p => { try { return fs.readFileSync(path.join(dir, p.replace(/^model\//, '')), 'utf8'); } catch { return null; } } });
  const d = m.symbols.defs.find(x => x.ident === 'bookings');
  assert.equal(d.identAt.file, 'model/fares/workers.dsl');
  const refs = m.symbols.refs.filter(r => r.ident === 'bookings');
  assert.ok(refs.length === 2 && refs.every(r => r.at.file === 'model/relationships.dsl'));
  const text = rd('fixtures/include-model/relationships.dsl').split('\n');
  for (const r of refs) assert.equal(text[r.at.line - 1].substr(r.at.c, r.at.n), 'bookings');
  assert.deepEqual(m.symbols.includes.map(i => [i.at.file, i.at.line, i.path]), [['model/workspace.dsl', 16, 'model/fares.dsl'], ['model/fares.dsl', 33, 'model/fares/workers.dsl'], ['model/workspace.dsl', 17, 'model/relationships.dsl']]);
});

test('views: one view ref and one view-scope ref; deployment identifiers are not refs', () => {
  const src = `model {
  fares = softwareSystem "Fares" { api = container "API" }
  deploymentEnvironment "Live" {
    n = deploymentNode "N" { ci = containerInstance api }
    n -> n
  }
}
views {
  systemContext fares { include api }
  deployment fares "Live" "k" { include * }
}`;
  const m = Core.parse(src);
  assert.deepEqual(m.errors, []);
  const refs = m.symbols.refs;
  assert.deepEqual(refs.filter(r => r.role === 'view').map(r => [r.ident, r.at.line, r.at.c]).sort(), [['api', 9, 32], ['fares', 9, 16]]);
  assert.deepEqual(refs.filter(r => r.role === 'view-scope').map(r => [r.ident, r.at.line, r.at.c, r.id]), [['fares', 10, 13, 'fares']]);
  assert.deepEqual(refs.filter(r => r.role === 'instance').map(r => [r.ident, r.at.line, r.id]), [['api', 4, 'api']]);
  assert.ok(!refs.some(r => r.ident === 'n' || r.ident === 'ci'));
});

test('include positions carry the resolved path (null on error)', () => {
  const m = parse('!include b.dsl\n!include ../x.dsl\n!include nope.dsl\n', { 'b.dsl': 'x = person "X"\n' });
  assert.deepEqual(m.symbols.includes.map(i => [i.at.line, i.at.c, i.at.n, i.path]), [[1, 0, 14, 'b.dsl'], [2, 0, 17, null], [3, 0, 17, null]]);
});

test('a string with a newline and a block comment keep later columns right; a tab is one column', () => {
  const src = 'model {\n  /* a\n  comment */ a = person "x\ny" b = person "B"\n\tc = person "C"\n}';
  const m = Core.parse(src);
  const d = id => m.symbols.defs.find(x => x.ident === id);
  assert.deepEqual(d('a').identAt, { file: null, line: 3, c: 13, n: 1 });
  assert.deepEqual([d('a').nameAt.line, d('a').nameAt.c], [3, 24]);
  assert.equal(d('a').nameAt.n, 5);
  assert.deepEqual(d('b').identAt, { file: null, line: 4, c: 3, n: 1 });
  assert.deepEqual(d('c').identAt, { file: null, line: 5, c: 1, n: 1 });
  assert.equal(d('b').nameAt.n, 3);
});
