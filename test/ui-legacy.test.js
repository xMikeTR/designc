// D8 slice 1: Ui.legacySkeleton from the UI graph and from a parity baseline (pure).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Ui = require('../renderer/ui.js');
const UiGraph = require('../renderer/uigraph.js');

const ROOT = path.join(__dirname, '..');
const graph = () => UiGraph.screen(JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'ui-graph.example.json'), 'utf8')), 'tags');
const baseline = id => JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'parity-registry', 'parity', 'baselines', id, 'legacy.json'), 'utf8'));

test('skeleton from the tags graph: role and name with file:line; unnamed or role-less controls are notes', () => {
  const sk = Ui.legacySkeleton({ graph: graph() });
  assert.equal(sk.screen, 'tags');
  assert.deepEqual(sk.states, ['initial']);
  const find = (role, name) => sk.placements.find(p => p.role === role && p.name === name);
  assert.deepEqual(find('searchbox', 'Search tags'), { role: 'searchbox', name: 'Search tags', from: 'src/pages/Tags/TagsPage.tsx:19' });
  assert.deepEqual(find('link', 'New tag'), { role: 'link', name: 'New tag', from: 'src/pages/Tags/TagsPage.tsx:31' });
  assert.ok(find('button', 'Refresh'), 'a followed control with a name is a placement');
  assert.equal(sk.placements.some(p => !p.role || !p.name), false);
  // the role-less date input, the library Button and the button whose name is an expression are notes, never guesses
  assert.ok(sk.notes.some(n => n.startsWith('src/pages/Tags/TagsPage.tsx:36:') && /no role/.test(n)));
  assert.ok(sk.notes.some(n => n.startsWith('src/pages/Tags/TagsPage.tsx:42:')));
  assert.ok(sk.notes.some(n => n.startsWith('src/pages/Tags/TagForm.tsx:25:') && /no literal name/.test(n)));
  // 'textbox Tag name' is on the screen twice (TagForm and the followed Field): one locator, first place kept
  assert.equal(sk.placements.filter(p => p.role === 'textbox' && p.name === 'Tag name').length, 1);
  assert.equal(sk.placements.length + sk.notes.length, graph().controls.length - 1);
});

test('skeleton from the tags-list baseline: elements with an acceptance role, from scenario step n; one initial state', () => {
  const sk = Ui.legacySkeleton({ baseline: baseline('tags-list') });
  assert.equal(sk.screen, 'tags-list');
  assert.deepEqual(sk.states, ['initial']);
  assert.deepEqual(sk.placements.map(p => `${p.role}:${p.name}`), ['heading:Adhoc tags', 'textbox:Program', 'table:Programs', 'button:Bulk apply', 'button:Export']);
  assert.ok(sk.placements.every(p => p.from === 'scenario step 1'));
});

test('baseline step states become the skeleton states, in order, once each; repeats of a locator keep the first step', () => {
  const el = (role, name) => ({ role, name, children: [] });
  const sk = Ui.legacySkeleton({ baseline: { scenario: 's', steps: [
    { n: 1, state: 'list', elements: [el('button', 'Go'), { role: 'columnheader', name: 'X', children: [] }] },
    { n: 2, state: 'dialog', elements: [el('button', 'Go'), { role: 'dialog', name: 'Apply', children: [el('textbox', '')] }] },
    { n: 3, state: 'list', elements: [] }] } });
  assert.deepEqual(sk.states, ['list', 'dialog']);
  assert.deepEqual(sk.placements, [{ role: 'button', name: 'Go', from: 'scenario step 1' }, { role: 'dialog', name: 'Apply', from: 'scenario step 2' }]);
});

test('nothing given is a note, not a crash', () => {
  assert.deepEqual(Ui.legacySkeleton({}).placements, []);
  assert.ok(Ui.legacySkeleton().notes.length);
});
