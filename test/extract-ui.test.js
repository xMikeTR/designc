const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extract } = require('../extract/index.js');
const ui = require('../extract/ui.js');
const roles = require('../extract/ui-roles.js');

const FIX = path.join(__dirname, '..', 'fixtures', 'ui-app');
const UI = { tsconfig: { codebase: 'tsconfig.json' }, screens: { tags: { codebase: ['src/pages/Tags/**'] }, 'legacy-tags': { codebase: 'src/legacy/OldTags.jsx' } } };
const EXAMPLE = path.join(__dirname, '..', 'docs', 'ui-graph.example.json');

// A scratch repo holding one file, scanned as one screen.
function one(src, file = 'src/Page.tsx', extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-'));
  fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), src);
  try { return ui.build({ repo: dir, files: [file], ui: { screens: { s: { codebase: [file] } }, ...extra } }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const ctl = (src, i = 0) => one(`export const P = () => (<div>${src}</div>);`).controls[i];

test('facts.ui of the fixture matches the pinned example (docs/ui-graph.example.json)', async () => {
  const r = await extract(FIX, { ui: UI });
  assert.ok(!r.error, r.error);
  if (process.env.WRITE_EXAMPLE) fs.writeFileSync(EXAMPLE, JSON.stringify(r.facts.ui, null, 2) + '\n');
  assert.deepEqual(r.facts.ui, JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')));
});

test('no ui.screens means no ui key in facts', async () => {
  const r = await extract(FIX, {});
  assert.equal(r.facts.ui, undefined);
});

test('native roles: button, link only with href, input types, select, textarea; hidden is not a control', () => {
  const r = one(`export const P = () => (<form>
    <button>Go</button><a href="/x">X</a><a>plain</a><input type="number" aria-label="N" /><input type="range" aria-label="R" />
    <select multiple aria-label="M"><option>a</option></select><select aria-label="One" /><textarea aria-label="T" />
    <input type="hidden" /><input list="l" aria-label="L" /><input type="radio" aria-label="Rad" /></form>);`);
  assert.deepEqual(r.controls.map(c => [c.tag, c.role, c.basis]), [
    ['button', 'button', 'native'], ['a', 'link', 'native'], ['input', 'spinbutton', 'native'], ['input', 'slider', 'native'],
    ['select', 'listbox', 'native'], ['select', 'combobox', 'native'], ['textarea', 'textbox', 'native'], ['input', 'combobox', 'native'], ['input', 'radio', 'native'],
  ]);
});

test('aria: a literal widget role makes any element a control; presentation does not; a non-literal role is unresolved', () => {
  const r = one(`const r = 'tab'; export const P = () => (<div><span role="tab">One</span><div role="presentation">x</div><button role={r}>B</button></div>);`);
  assert.deepEqual(r.controls.map(c => [c.tag, c.role, c.basis, c.name]), [['span', 'tab', 'aria', 'One'], ['button', null, null, null]]);
  assert.match(r.unresolved[0].what, /role is not a literal/);
});

test('a non-literal input type and a type with no implicit role give role null and an unresolved entry, never a guess', () => {
  const r = one(`export const P = ({ k }) => (<div><input type={k} aria-label="A" /><input type="date" aria-label="D" /></div>);`);
  assert.deepEqual(r.controls.map(c => c.role), [null, null]);
  assert.deepEqual(r.unresolved.map(u => u.what.replace(/.*: /, '')), ['input type is not a literal', 'input type "date" has no implicit role']);
  assert.equal(r.unresolved[0].screen, 's');
});

test('names: label wrapping, label htmlFor, aria-labelledby in the same file, nested text', () => {
  assert.equal(ctl('<label>Email <input type="email" /></label>').name, 'Email');
  assert.equal(ctl('<label htmlFor="q">Query</label><input id="q" />').name, 'Query');
  assert.equal(ctl('<h2 id="h">Orders</h2><button aria-labelledby="h">x</button>').name, 'Orders');
  assert.equal(ctl('<button><span>Save</span> all</button>').name, 'Save all');
  assert.deepEqual(ctl('<button aria-labelledby="nope">x</button>').names[0], { from: 'aria-labelledby', value: null, ref: 'nope' });
});

test('names: the first source present decides; an expression or t() there leaves the name null', () => {
  assert.equal(ctl('<button aria-label="Close">X</button>').name, 'Close');
  const e = one('export const P = ({ n }) => (<button aria-label={`Edit ${n}`}>Edit</button>);').controls[0];
  assert.equal(e.name, null);
  assert.deepEqual(e.names[0], { from: 'aria-label', value: null, expr: '`Edit ${n}`' });
  const t = one(`export const P = () => (<button title="Tip">{t('a.b')}</button>);`).controls[0];
  assert.equal(t.name, null);
  assert.deepEqual(t.names, [{ from: 't()', value: 'a.b' }, { from: 'title', value: 'Tip' }]);
  assert.equal(ctl('<input placeholder="Find" />').name, 'Find');
  assert.equal(ctl('<input type="submit" value="Send" />').name, 'Send');
  assert.equal(ctl('<input type="image" alt="Go" />').name, 'Go');
});

test('component: the nearest capitalised function, arrow or class; else the module named after the file', () => {
  const r = one(`function helper() { return <button>H</button>; }
export default function () { return <button>D</button>; }
class Old extends React.Component { render() { const x = () => <a href="/">A</a>; return x(); } }`, 'src/Orders/index.jsx');
  assert.deepEqual(r.controls.map(c => c.component), ['src/Orders/index.jsx#Orders', 'src/Orders/index.jsx#Orders', 'src/Orders/index.jsx#Old']);
});

test('screens: a pattern that matches nothing, a rejected pattern, an outside tsconfig and a reference key are unresolved', () => {
  const r = ui.build({ repo: FIX, files: ['src/pages/Tags/TagsPage.tsx'], ui: { tsconfig: { codebase: '../x.json' }, screens: { a: { codebase: ['nowhere/**', '/abs/**'], legacy: ['x'] } } } });
  assert.deepEqual(r.screens, [{ name: 'a', roots: [], components: [] }]);
  const what = r.unresolved.map(u => u.what);
  assert.ok(what.some(w => /outside the codebase/.test(w)));
  assert.ok(what.some(w => /"nowhere\/\*\*" matches no source file/.test(w)));
  assert.ok(what.some(w => /"\/abs\/\*\*" is rejected/.test(w)));
  assert.ok(what.some(w => /ui.screens.a.legacy: reference repositories are not read yet/.test(w)));
});

test('roleOf is the whole native and aria table', () => {
  const L = v => ({ literal: v });
  assert.deepEqual(roles.roleOf('div', {}), { control: false });
  assert.deepEqual(roles.roleOf('input', { type: L('password') }), { control: true, role: 'textbox', basis: 'native' });
  assert.deepEqual(roles.roleOf('input', { type: L('search') }), { control: true, role: 'searchbox', basis: 'native' });
  assert.deepEqual(roles.roleOf('select', { size: L('4') }), { control: true, role: 'listbox', basis: 'native' });
  assert.deepEqual(roles.roleOf('div', { role: L('menuitem checkbox') }), { control: true, role: 'menuitem', basis: 'aria' });
});
