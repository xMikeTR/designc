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

test('screen: the render tree nests by renders with a depth; followed components are listed', () => {
  const g = {
    screens: [{ name: 's', roots: ['p.tsx', 'r.tsx'], components: ['r.tsx#Row', 'p.tsx#Page'], followed: ['f.tsx#Field'] }],
    components: [
      { id: 'r.tsx#Row', name: 'Row', file: 'r.tsx', line: 1, renders: [], basis: 'declared' },
      { id: 'p.tsx#Page', name: 'Page', file: 'p.tsx', line: 1, renders: ['Field', 'Row'], basis: 'declared' },
      { id: 'f.tsx#Field', name: 'Field', file: 'f.tsx', line: 2, renders: [], basis: 'followed' },
    ],
    controls: [{ id: 's:p.tsx:3:1>f.tsx:4:1', screen: 's', component: 'p.tsx#Page', file: 'p.tsx', line: 3, tag: 'input', as: 'Field', role: 'textbox', basis: 'followed', name: 'X', names: [] }],
    unresolved: [],
  };
  const s = UiGraph.screen(g, 's');
  assert.deepEqual(s.tree.map(c => [c.name, c.depth, c.controls.length]), [['Page', 0, 1], ['Row', 1, 0]]);
  assert.deepEqual(s.followed.map(c => c.id), ['f.tsx#Field']);
});

test('screen: formats and forms of that screen, by place; format and rules text for the tags', () => {
  const g = {
    screens: [{ name: 's', roots: ['p.tsx'], components: [], followed: [] }],
    components: [], controls: [], unresolved: [],
    formats: [
      { id: 's:p.tsx:9:1', screen: 's', component: 'p.tsx#P', lib: 'Intl', call: 'Intl.NumberFormat', pattern: null, args: 'loc', file: 'p.tsx', line: 9 },
      { id: 's:p.tsx:3:1', screen: 's', component: 'p.tsx#P', lib: 'date-fns', call: 'format', pattern: 'dd/MM/yyyy', args: "d, 'dd/MM/yyyy'", file: 'p.tsx', line: 3 },
      { id: 't:p.tsx:1:1', screen: 't', component: 'p.tsx#P', lib: 'dayjs', call: 'format', pattern: 'D', args: "'D'", file: 'p.tsx', line: 1 },
    ],
    forms: [{ id: 's:p.tsx#f', screen: 's', form: 'f', lib: 'zod', file: 'p.tsx', line: 2, fields: [] }],
  };
  const s = UiGraph.screen(g, 's');
  assert.deepEqual(s.formats.map(f => f.line), [3, 9]);
  assert.deepEqual(s.forms.map(f => f.form), ['f']);
  assert.deepEqual(UiGraph.screen(ui, 's').formats, []);
  assert.equal(UiGraph.formatText(g.formats[1]), 'dd/MM/yyyy');
  assert.equal(UiGraph.formatText(g.formats[0]), 'Intl.NumberFormat(loc)');
  assert.equal(UiGraph.formatText({ lib: 'toLocale', call: 'toLocaleTimeString', pattern: "'en-GB'", args: "'en-GB'" }), "toLocaleTimeString 'en-GB'");
  assert.equal(UiGraph.rulesText([{ rule: 'type', value: 'string' }, { rule: 'min', value: 1 }, { rule: 'regex', value: '/^a$/' }, { rule: 'required', value: true, message: 'x' }]), 'min 1, regex /^a$/, required');
});
