// Slice 34: design tokens and UX rules on acceptance criteria, JS and the Python mirror.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Core = require('../renderer/core.js');

const DSL = `workspace "Q" {
  model {
    s = softwareSystem "Quotes" {
      ui = container "Quote UI" {
        tags "UI"
      }
    }
  }
}
`;
const cases = ['ready', 'loading', 'empty', 'error'].map(state => ({ state, given: 'g', then: 't' }));
const ac = (ux) => ({ id: 'AC-1', requirement: 'R-1', element: 'Quotes/Quote UI', states: ['ready', 'loading', 'empty', 'error'], _path: 'acceptance/AC-1.yaml', _text: 'id: AC-1\n',
  locators: { save: { role: 'button', name: 'Save' }, title: { role: 'heading', name: 'Quote' } }, cases, ux });
const clauses = ux => Core.acceptanceClauses({ model: Core.parse(DSL), acceptance: [ac(ux)], requirements: [{ id: 'R-1', elements: ['Quote UI'] }], decisions: [] }).map(c => c.text);

test('a criterion without ux needs nothing; a sound ux block is clean', () => {
  assert.deepEqual(clauses(undefined), []);
  assert.deepEqual(clauses({ keyboard: true, focus_order: ['title', 'save'], focus_return: 'save', breakpoints: [375, 768] }), []);
});

test('ux problems name the field and what to write', () => {
  const t = clauses({ keyboard: 'yes', focus_order: ['nope'], focus_return: 'gone', breakpoints: [10] });
  assert.equal(t.length, 4, t.join('; '));
  assert.ok(t.some(m => /keyboard must be true or false/.test(m)));
  assert.ok(t.some(m => /focus_order names locator "nope"/.test(m)));
  assert.ok(t.some(m => /focus_return names locator "gone"/.test(m)));
  assert.ok(t.some(m => /breakpoints must be whole pixel widths/.test(m)));
});

test('a text size token below the minimum is a clause; other tokens are not judged', () => {
  const tokens = JSON.stringify({ font: { size: { body: { $value: '16px' }, tiny: { $value: '0.5rem' } } }, color: { size: { $value: 'red' } }, spacing: { $value: '2px' } });
  const c = Core.tokenClauses(tokens, 12);
  assert.equal(c.length, 1, JSON.stringify(c));
  assert.match(c[0].text, /font\.size\.tiny is 8px, below the minimum text size of 12px/);
  assert.equal(c[0].kind, 'tokens');
  assert.deepEqual(Core.tokenClauses(tokens, 8), []);
  assert.deepEqual(Core.tokenClauses(null), []);
  assert.match(Core.tokenClauses('{')[0].text, /does not parse as JSON/);
  assert.match(Core.tokenClauses(JSON.stringify({ text: { size: { a: { $value: 'big' } } } }))[0].text, /not px or rem/);
});

test('the skeleton adds axe, keyboard, focus and breakpoint checks only for what ux declares', () => {
  const model = Core.parse(DSL);
  const plain = Core.acceptanceSpecs({ model, criteria: [ac(undefined)] }).files[0].text;
  assert.doesNotMatch(plain, /AxeBuilder|ux:/);
  const t = Core.acceptanceSpecs({ model, criteria: [ac({ keyboard: true, focus_order: ['title', 'save'], focus_return: 'save', breakpoints: [375] })] }).files[0].text;
  assert.match(t, /import AxeBuilder from '@axe-core\/playwright'/);
  assert.match(t, /ux: no accessibility violations/);
  assert.match(t, /ux: reachable by keyboard/);
  assert.match(t, /ux: focus order[\s\S]*toBeFocused/);
  assert.match(t, /ux: focus returns/);
  assert.match(t, /no horizontal scroll at 375px/);
});

test('handoverPlan copies the tokens file, lists it and counts it in the id', () => {
  const base = { date: '2026-10-12', now: 'n', by: 'm', model: { path: 'model/workspace.dsl', text: DSL } };
  const tokens = { path: 'design-tokens/tokens.json', text: '{"font":{"size":{"body":{"$value":"16px"}}}}\n' };
  const a = Core.handoverPlan({ ...base, tokens }), b = Core.handoverPlan(base);
  assert.notEqual(a.id, b.id);
  assert.ok(a.files.some(f => f.path.endsWith('/design-tokens/tokens.json') && f.text === tokens.text));
  assert.match(a.files[0].text, /^tokens: "design-tokens\/tokens.json"$/m);
  assert.doesNotMatch(b.files[0].text, /^tokens:/m);
});

const PY = path.join(__dirname, '..', 'python');
const skip = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';
test('Python reports the same ux and token clauses', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-ux-'));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('designc.json', '{ "ux": { "minTextSize": 14 } }');
  put('model/workspace.dsl', DSL);
  put('requirements/R-1.yaml', 'id: R-1\ntitle: t\nversion: 1\nelements: [Quote UI]\n');
  const tokens = JSON.stringify({ font: { size: { body: { $value: '16px' }, small: { $value: '12px' }, odd: { $value: 'huge' } } } });
  put('design-tokens/tokens.json', tokens);
  const text = 'id: AC-1\nrequirement: R-1\nelement: Quotes/Quote UI\nstates: [ready, loading, empty, error]\nlocators:\n  save: { role: button, name: Save }\n'
    + 'ux:\n  keyboard: 1\n  focus_order: [save, nope]\n  focus_return: gone\n  breakpoints: [10, 375]\ncases:\n'
    + ['ready', 'loading', 'empty', 'error'].map(s => `  - { state: ${s}, given: g, then: t }\n`).join('');
  put('acceptance/AC-1.yaml', text);
  const yaml = require('js-yaml');
  const model = Core.parse(DSL);
  const js = Core.gate({ model, diags: Core.check(model, {}), decisions: [], requirements: [{ id: 'R-1', elements: ['Quote UI'] }], ledger: [], acceptance: [yaml.load(text)], tokens, minTextSize: 14 })
    .clauses.filter(c => c.kind === 'acceptance' || c.kind === 'tokens');
  assert.equal(js.length, 6, js.map(c => c.text).join('; '));
  const r = spawnSync('python3', ['-m', 'designc', 'check', root, '--json'], { cwd: PY, encoding: 'utf8' });
  const py = JSON.parse(r.stdout).gate.clauses.filter(c => c.kind === 'acceptance' || c.kind === 'tokens');
  assert.deepEqual(py, js.map(c => ({ kind: c.kind, text: c.text })));
});
