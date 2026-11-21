// B2: the popover-form template and the TextField / Select manifests (fixtures/ui-project/ui/pack), and a hosted spec that uses them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const Ui = require('../renderer/ui.js');
const { load, ROOT } = require('./helpers/ui.js');

const base = load();
const G = Ui.tokenGroups(base.tokens);
const read = rel => JSON.parse(fs.readFileSync(path.join(ROOT, 'ui/pack', rel), 'utf8'));
const field = (id, component, props, extra = {}) => ({ id, component, props, locator: { role: 'textbox', name: id }, ...extra });
const btn = (id, variant) => ({ id, component: 'Button', props: { label: id, variant, onClick: id }, locator: { role: 'button', name: id } });
const hosted = (edit = () => {}) => {
  const s = {
    screen: 'orders-tag', component: 'OrdersTagPopover', intent: 'Add one tag to every order whose reference matches.', template: 'popover-form', ticket: 'ORD-1',
    host: { screen: 'orders', state: 'tag-popover', anchor: 'tag' },
    data: { tags: { shape: 'list', source: 'GET /api/tags', sample: ['Priority', 'Review'] } },
    slots: {
      fields: [field('match', 'TextField', { label: 'Match', required: true, maxLength: 40 }), field('tag', 'Select', { label: 'Tag', required: true }, { bind: { options: 'tags' }, locator: { role: 'combobox', name: 'Tag' } })],
      actions: [btn('apply', 'primary'), btn('cancel', 'secondary')],
    },
    states: { editing: { initial: true }, invalid: { description: 'A required field is empty' } },
    transitions: [{ from: 'editing', to: 'invalid', on: { event: 'required field empty' } }],
    status: 'minted',
  };
  edit(s); return s;
};
const check = s => Ui.checkSpec('ui/specs/orders-tag.json', JSON.stringify(s), { pack: Ui.readPack({ components: [...base.pack.components].sort((a, b) => (a.path < b.path ? -1 : 1)), templates: base.pack.templates }, G), groups: G });
const texts = s => check(s).problems;

test('popover-form, TextField and Select validate against their schemas', () => {
  const r = Ui.readPack(base.pack, G);
  assert.deepEqual(r.problems, []);
  assert.equal(read('templates/popover-form.json').slots.fields.max, 5);
  assert.deepEqual(read('components/Select.json').data.options, { shape: 'list', required: true });
  for (const n of ['popover-form']) assert.ok(r.templates.has(n));
  for (const n of ['TextField', 'Select']) assert.ok(r.components.has(n));
});
test('a hosted spec using them passes checkSpec', () => {
  assert.deepEqual(texts(hosted()), []);
});
test('an unknown prop on TextField is refused', () => {
  const p = texts(hosted(s => { s.slots.fields[0].props.placeholder = 'x'; }));
  assert.ok(p.some(t => /props\/placeholder: 'TextField' has no prop 'placeholder'/.test(t)), p.join('\n'));
});
test('options given under props gets the data prop hint', () => {
  const p = texts(hosted(s => { s.slots.fields[1].props.options = 'tags'; }));
  assert.ok(p.some(t => /'Select' has no prop 'options'.*'options' is a data prop: put it under bind/.test(t)), p.join('\n'));
});
test('a wrong type on a TextField prop is refused', () => {
  const p = texts(hosted(s => { s.slots.fields[0].props.maxLength = '40'; s.slots.fields[0].props.required = 'yes'; }));
  assert.ok(p.some(t => /maxLength: Expected a number/.test(t)) && p.some(t => /required: Expected a boolean/.test(t)), p.join('\n'));
});
test('fields with 0 or 6 placements is refused', () => {
  const none = texts(hosted(s => { s.slots.fields = []; }));
  assert.ok(none.some(t => /fields/.test(t) && /at least 1|min|requires/i.test(t)), none.join('\n'));
  const six = texts(hosted(s => { s.slots.fields = Array.from({ length: 6 }, (_, i) => field(`f${i}`, 'TextField', { label: `F${i}` })); }));
  assert.ok(six.some(t => /fields/.test(t) && /at most 5|max/i.test(t)), six.join('\n'));
});
test('a table in fields is refused: the slot accepts form-field only', () => {
  const p = texts(hosted(s => { s.slots.fields.push({ id: 'tbl', component: 'DataTable', props: { density: 'compact', rowAction: 'x' }, bind: { rows: 'tags' } }); }));
  assert.ok(p.some(t => /'DataTable' is a table; slot 'fields' accepts form-field/.test(t)), p.join('\n'));
});
