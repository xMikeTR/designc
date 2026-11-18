// Check 4 (D3): a UI element cannot freeze without a bound spec and approved previews for every acceptance state.
// Pure rule in Ui.clauses (renderer/ui.js), mirrored in python/designc/ui.py; the same cases run through both.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const Ui = require('../renderer/ui.js');
const { load, hash } = require('./helpers/ui.js');

const skip = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const H = sha('png');
const STATES = ['ready', 'loading', 'empty', 'error', 'filtered'];
const picture = (s, h = H) => [`${s}-chromium-linux.png`, h];
const files = (states = STATES, extra = {}) => ({ ...Object.fromEntries(states.map(s => picture(s))), [`${states[0]}.aria.yml`]: H, [`placements/${states[0]}__header-chromium-linux.png`]: H, ...extra });

function input({ status = 'bound', rows = [], disk = files(), specText, uiElements = ['BordereauxList'], acceptance = [], mutate } = {}) {
  const base = load();
  const t = specText || JSON.stringify({ ...JSON.parse(base.specs[0].text), status }, null, 2);
  const specs = [{ path: base.specs[0].path, text: t }];
  const out = { ...base, specs, ledger: [...base.ledger, ...rows], previews: { bordereaux: disk }, specHashes: { bordereaux: sha(t) }, uiElements, acceptance };
  return mutate ? mutate(out) : out;
}
const rendered = (ts, over = {}) => ({ kind: 'ui_preview_rendered', screen: 'bordereaux', spec_hash: H, files: files(), image: 'ready-chromium-linux.png', _ts: ts, ...over });
const approvedFor = (inp, ts, over = {}) => ({ kind: 'ui_preview_approved', screen: 'bordereaux', spec: inp.specHashes.bordereaux, files: files(), _ts: ts, ...over });
const check4 = inp => Ui.clauses({ ...inp, hash }).clauses.filter(c => c.about && c.about[0] === 'BordereauxList').map(c => c.text);
const P = 'ui/specs/bordereaux.json';

const CASES = {
  'unbound': () => input({ status: 'minted' }),
  'never rendered': () => input(),
  'rendered, not approved': () => input({ rows: [rendered(10)] }),
  'approved': () => { const i = input({ rows: [rendered(10)] }); i.ledger.push(approvedFor(i, 20)); return i; },
  're-rendered after approval': () => { const i = input({ rows: [rendered(10)] }); i.ledger.push(approvedFor(i, 20), rendered(30)); return i; },
  'file edited after approval': () => { const i = input({ rows: [rendered(10)] }); i.ledger.push(approvedFor(i, 20)); i.previews.bordereaux = { ...i.previews.bordereaux, 'ready-chromium-linux.png': sha('edited') }; return i; },
  'a placement added after approval': () => { const i = input({ rows: [rendered(10)] }); i.ledger.push(approvedFor(i, 20)); i.previews.bordereaux = { ...i.previews.bordereaux, 'placements/x-chromium-linux.png': H }; return i; },
  'spec edited after approval': () => { const i = input({ rows: [rendered(10)] }); i.ledger.push(approvedFor(i, 20)); i.specHashes.bordereaux = sha('other'); return i; },
  'missing state picture': () => { const d = files(STATES.slice(0, 4)); const i = input({ rows: [rendered(10)], disk: d }); i.ledger.push(approvedFor(i, 20, { files: d })); return i; },
  'UI element with no spec': () => input({ uiElements: ['Other'] }),
  'criterion limits the states': () => { const d = files(['ready', 'error']); const i = input({ rows: [rendered(10)], disk: d, acceptance: [{ id: 'AC-1', component: 'BordereauxList', states: ['ready', 'error'], cases: [] }] }); i.ledger.push(approvedFor(i, 20, { files: d })); return i; },
  'no UI element': () => input({ status: 'minted', uiElements: [] }),
};
const EXPECT = {
  'unbound': [`${P}: spec not bound. Check the previews, then press Approve and bind`],
  'never rendered': [`${P}: previews not rendered. Run factory-s2 preview for bordereaux`],
  'rendered, not approved': [`${P}: previews not approved. Look at the page pictures, then press Approve previews`],
  'approved': [],
  're-rendered after approval': [`${P}: approval is stale: rendered again since. Look at the new previews, then approve again`],
  'file edited after approval': [`${P}: approval is stale: files changed since. Render again, then approve`],
  'a placement added after approval': [`${P}: approval is stale: files changed since. Render again, then approve`],
  'spec edited after approval': [`${P}: approval is stale: the spec changed since. Render again, then approve`],
  'missing state picture': [`${P}: no approved preview for state filtered. Render the spec again, then approve`],
  'UI element with no spec': ['no screen spec for component Other. Add ui/specs/<screen>.json with component "Other"'],
  'criterion limits the states': [],
  'no UI element': [],
};

for (const [name, make] of Object.entries(CASES)) {
  test(`check 4 (JS): ${name}`, () => {
    const inp = make();
    const all = Ui.clauses({ ...inp, hash }).clauses.filter(c => /preview|bound|stale|no screen spec/.test(c.text)).map(c => c.text);
    assert.deepEqual(all, EXPECT[name]);
  });
}

test('check 4: a clause names its element, its screen and its spec file, so a work item scopes it', () => {
  const [c] = Ui.clauses({ ...CASES.unbound(), hash }).clauses.filter(x => /not bound/.test(x.text));
  assert.deepEqual([c.kind, c.about, c.screen, c.path], ['ui', ['BordereauxList'], 'bordereaux', P]);
});
test('check 4: a deprecated spec is not bound either', () => {
  assert.ok(check4(input({ status: 'deprecated' })).some(t => /not bound/.test(t)));
});
test('check 4: the latest render and the latest approval decide, not the first', () => {
  const i = input({ rows: [rendered(10), rendered(30)] }); i.ledger.push(approvedFor(i, 20), approvedFor(i, 40));
  assert.deepEqual(check4(i), []);
});
test('check 4: rendering again blocks even when the bytes are the same', () => {
  const i = input({ rows: [rendered(10)] }); i.ledger.push(approvedFor(i, 20));
  assert.deepEqual(check4(i), []);
  i.ledger.push(rendered(25));
  assert.deepEqual(check4(i).length, 1);
});
test('check 4: binding does not break an approval, which is compared with the current file, never with the render', () => {
  const i = input({ rows: [rendered(10, { spec_hash: sha('the minted file') })] }); i.ledger.push(approvedFor(i, 20));
  assert.deepEqual(check4(i), []);
});
test('check 4 does not run when UI is not opted in', () => {
  assert.deepEqual(Ui.clauses({ uiElements: ['BordereauxList'], hash }), { clauses: [], notes: [], coverage: [] });
});

test('check 4: the python mirror says the same words for every case', { skip }, () => {
  const cases = Object.fromEntries(Object.entries(CASES).map(([k, f]) => [k, f()]));
  const code = `
import json, sys
from designc import ui
cases = json.load(sys.stdin)
out = {}
for k, c in cases.items():
    r = ui.clauses(c['pack'], c['specs'], c['holdouts'], c['tokens'], c['ledger'], {}, c['acceptance'], c['scenarios'], c['previews'], c['specHashes'], c['uiElements'])
    out[k] = r['clauses']
print(json.dumps(out))`;
  const r = spawnSync('python3', ['-c', code], { cwd: path.join(__dirname, '..', 'python'), input: JSON.stringify(cases), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const py = JSON.parse(r.stdout);
  for (const [k, c] of Object.entries(cases)) assert.deepEqual(py[k], Ui.clauses({ ...c, hash }).clauses, k);
  assert.ok(Object.entries(cases).some(([k]) => EXPECT[k].length));
});

test('check 4 is in Core.gate, scoped to the work item that names the UI element', () => {
  const Core = require('../renderer/core.js');
  const model = Core.parse('workspace "W" {\n model {\n  app = softwareSystem "App" {\n   list = container "BordereauxList" "" "" "UI"\n   other = container "Other"\n  }\n }\n}\n');
  const ui = input({ status: 'minted' });
  const g = Core.gate({ model, diags: [], decisions: [], requirements: [], ledger: ui.ledger, tokens: ui.tokens, ui: { pack: ui.pack, specs: ui.specs, holdouts: ui.holdouts, scenarios: ui.scenarios, previews: ui.previews, specHashes: ui.specHashes } });
  assert.ok(g.clauses.some(c => /spec not bound/.test(c.text)), 'whole-model gate blocks');
  assert.equal(Core.scopedGate(g, { model, elements: ['BordereauxList'] }).clauses.filter(c => /spec not bound/.test(c.text)).length, 1);
  assert.equal(Core.scopedGate(g, { model, elements: ['Other'] }).clauses.filter(c => /spec not bound/.test(c.text)).length, 0);
});

// ---- the buttons: what Approve and bind may do (Ui.approveState) and the command Render previews types (Dispatch.uiPreview) ----
const Dispatch = require('../renderer/dispatch.js');
function state(over = {}) {
  const inp = input({ status: 'minted', rows: [rendered(10)] });
  const spec = JSON.parse(inp.specs[0].text);
  const ctx = { spec, path: P, ledger: inp.ledger, clauses: Ui.clauses({ ...inp, hash }).clauses, previews: inp.previews, specHashes: inp.specHashes };
  ctx.ledger = ctx.ledger.map(e => (e.kind === 'ui_preview_rendered' ? { ...e, spec_hash: inp.specHashes.bordereaux, files: files() } : e));
  return Ui.approveState({ ...ctx, ...over });
}
test('approveState: a minted spec with a current render offers Approve and bind', () => {
  assert.deepEqual(state(), { label: 'Approve and bind', enabled: true, why: '' });
});
test('approveState: a bound spec offers Approve previews', () => {
  const inp = input({ status: 'bound', rows: [rendered(10, { spec_hash: sha(input({ status: 'bound' }).specs[0].text), files: files() })] });
  const r = Ui.approveState({ spec: JSON.parse(inp.specs[0].text), path: P, ledger: inp.ledger, clauses: Ui.clauses({ ...inp, hash }).clauses, previews: inp.previews, specHashes: inp.specHashes });
  assert.equal(r.label, 'Approve previews'); assert.equal(r.enabled, true);
});
test('approveState: disabled, and says why, with no render, another spec version, other files, or another UI clause', () => {
  assert.match(state({ ledger: [] }).why, /not rendered/);
  assert.match(state({ specHashes: { bordereaux: sha('else') } }).why, /another version of the spec/);
  assert.match(state({ previews: { bordereaux: { ...files(), 'ready-chromium-linux.png': sha('x') } } }).why, /files on disk are not the ones rendered/);
  assert.match(state({ clauses: [{ kind: 'ui', text: 'ui/specs/bordereaux.json /template: broken', path: P, screen: 'bordereaux' }] }).why, /Another UI clause/);
  assert.equal(state({ ledger: [] }).enabled, false);
});
test('approveState: only check 4 clauses (they name an element) do not block it', () => {
  assert.equal(state({ clauses: [{ kind: 'ui', text: 'spec not bound', about: ['BordereauxList'], path: P, screen: 'bordereaux' }] }).enabled, true);
});
test('approveState: no button for another status', () => {
  assert.equal(state({ spec: { screen: 'bordereaux', status: 'deprecated' } }), null);
});

test('uiPreview: the line for the Terminal names the registry, the screen and the codebase, each quoted', () => {
  assert.equal(Dispatch.uiPreview({ factory: null, registry: '/r/my reg', screen: 'bordereaux', repo: '/r/app' }, 'linux'), "factory-s2 preview --registry '/r/my reg' --screen 'bordereaux' --repo '/r/app'");
  assert.equal(Dispatch.uiPreview({ factory: '/opt/f/factory-s2', registry: '/r', screen: 'a-b', repo: "/r/o'k" }, 'linux'), "'/opt/f/factory-s2' preview --registry '/r' --screen 'a-b' --repo '/r/o'\\''k'");
  assert.equal(Dispatch.uiPreview({ registry: 'C:\\r', screen: 'a', repo: 'C:\\app' }, 'win32'), "factory-s2 preview --registry 'C:\\r' --screen 'a' --repo 'C:\\app'");
});
test('uiPreview: a missing value, a bad screen or a multi-line value is an error, never a line', () => {
  for (const bad of [{ registry: '/r', screen: 'a' }, { registry: '/r', screen: 'A b', repo: '/x' }, { registry: '/r', screen: 'a', repo: '/x\n/y' }, { registry: '', screen: 'a', repo: '/x' }]) assert.ok(Dispatch.uiPreview(bad, 'linux').error, JSON.stringify(bad));
});
