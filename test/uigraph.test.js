const { test } = require('node:test');
const assert = require('node:assert/strict');
const UiGraph = require('../renderer/uigraph.js');

const ui = {
  screens: [{ name: 's', roots: ['a.tsx'], components: ['a.tsx#A'] }, { name: 'empty', roots: [], components: [] }],
  components: [{ id: 'a.tsx#A', name: 'A', file: 'a.tsx', line: 1, renders: [], basis: 'declared' }],
  controls: [
    { id: 's:a.tsx:9:1', screen: 's', component: 'a.tsx#A', file: 'a.tsx', line: 9, tag: 'input', role: null, basis: null, name: null, names: [] },
    { id: 's:a.tsx:3:1', screen: 's', component: 'a.tsx#A', file: 'a.tsx', line: 3, tag: 'button', role: 'button', basis: 'native', name: 'Go', names: [] },
    { id: 's:b.tsx:1:1', screen: 's', component: 'b.tsx#B', file: 'b.tsx', line: 1, tag: 'a', role: 'link', basis: 'native', name: null, names: [] },
  ],
  unresolved: [{ where: 'ui', what: 'x', file: 'a.tsx', line: 9, text: '', screen: 's' }, { where: 'ui', what: 'y', file: 'designc.json', line: 1, text: '' }],
};

test('screen: components in file order with their controls; controls of no listed component go last', () => {
  const s = UiGraph.screen(ui, 's');
  assert.deepEqual(s.tree.map(c => [c.name, c.controls.map(x => x.line)]), [['A', [3, 9]], ['(no component)', [1]]]);
  assert.deepEqual(s.controls.map(c => c.id), ['s:a.tsx:3:1', 's:a.tsx:9:1', 's:b.tsx:1:1']);
  assert.deepEqual(s.unresolved.map(u => u.what), ['x']);
  assert.equal(UiGraph.screen(ui, 'nope'), null);
  assert.deepEqual(UiGraph.screen(ui, 'empty').tree, []);
});

test('summary counts controls, roleless and unnamed per screen', () => {
  assert.deepEqual(UiGraph.summary(ui), {
    screens: [{ name: 's', roots: 1, controls: 3, roleless: 1, unnamed: 2 }, { name: 'empty', roots: 0, controls: 0, roleless: 0, unnamed: 0 }],
    controls: 3, roleless: 1, unnamed: 2, unresolved: 2,
  });
  assert.deepEqual(UiGraph.summary(null), { screens: [], controls: 0, roleless: 0, unnamed: 0, unresolved: 0 });
});
