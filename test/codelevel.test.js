const { test } = require('node:test');
const assert = require('node:assert/strict');
const CodeLevel = require('../renderer/codelevel.js');

const code = {
  types: [
    { id: 't_c1_a', key: 'a', name: 'A', kind: 'class', component: 'c1', container: 'Api', files: [{ file: 'A.cs', line: 1, endLine: 9 }], methods: [{ name: 'Run', file: 'A.cs', line: 3, endLine: 8, cc: 4, lines: 6 }, { name: 'Stop', file: 'A.cs', line: 9, endLine: 9, cc: 1, lines: 1 }] },
    { id: 't_c1_b', key: 'b', name: 'B', kind: 'interface', component: 'c1', container: 'Api', files: [{ file: 'B.cs', line: 1, endLine: 1 }], methods: [] },
    { id: 't_c2_c', key: 'c', name: 'C', kind: 'record', component: 'c2', container: 'Api', files: [{ file: 'C.cs', line: 1, endLine: 1 }], methods: [] },
    { id: 't_c3_d', key: 'd', name: 'D', kind: 'class', component: 'c3', container: 'Api', files: [{ file: 'D.cs', line: 1, endLine: 1 }], methods: [] },
  ],
  typeEdges: [
    { from: 't_c1_a', to: 't_c1_b', via: 'inherits', evidence: { file: 'A.cs', line: 1 } },
    { from: 't_c1_a', to: 't_c2_c', via: 'uses', evidence: { file: 'A.cs', line: 5 } },
    { from: 't_c3_d', to: 't_c3_d', via: 'uses', evidence: { file: 'D.cs', line: 1 } },
  ],
};

test('a component scope has its types plus the types they touch in other components', () => {
  const m = CodeLevel.model(code, 'c1');
  assert.deepEqual([...m.elements.keys()].sort(), ['t_c1_a', 't_c1_b', 't_c2_c']);
  assert.equal(m.elements.get('t_c2_c').outside, true);
  assert.equal(m.elements.get('t_c1_a').outside, false);
  assert.equal(m.rels.length, 2);
});

test('shape is what the shared layout and drawing expect', () => {
  const m = CodeLevel.model(code, 'c1');
  const a = m.elements.get('t_c1_a');
  assert.ok(a.tags instanceof Set && a.props && a.kind === 'component');
  assert.equal(a.kindLabel, 'Class');
  assert.equal(a.technology, '2 methods');
  assert.equal(m.isAncestor('t_c1_a', 't_c1_b'), false);
  assert.equal(m.relById.get(m.rels[0].id), m.rels[0]);
  assert.equal(m.rels[0].description, 'inherits');
});

test('an unknown scope gives an empty model, not an error', () => {
  const m = CodeLevel.model(code, 'nope');
  assert.equal(m.elements.size, 0);
});

test('methodsOf lists a type\'s methods worst first', () => {
  assert.deepEqual(CodeLevel.methodsOf(code, 't_c1_a').map(x => x.name), ['Run', 'Stop']);
  assert.deepEqual(CodeLevel.methodsOf(code, 'zzz'), []);
});
