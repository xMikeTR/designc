// D5 slice 2: the pure handover for UI. Holdout content never appears in a copied file; only its hash does.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const Core = require('../renderer/core.js');
const Ui = require('../renderer/ui.js');
const { HOLDOUT_GIVEN, HOLDOUT_THEN, sha, fixture, inputs } = require('./helpers/handover-ui.js');

test('Ui.sha256 matches node crypto, including non-ASCII text', () => {
  for (const t of ['', 'abc', 'a'.repeat(1000), 'Cédant — 日本語 €', '{"a":1}\n']) assert.equal(Ui.sha256(t), crypto.createHash('sha256').update(t, 'utf8').digest('hex'), t);
});

test('acceptanceSpecs skips holdout cases, so a generated spec never carries them', () => {
  const f = fixture();
  const r = Core.acceptanceSpecs({ model: f.model, criteria: f.criteria });
  const all = r.files.map(x => x.text).join('\n');
  assert.ok(!all.includes('zebra-holdout') && !all.includes('Quillfeather'));
  const ui1 = r.files.find(x => x.path.endsWith('ac-ui-1.spec.ts') || x.path.includes('AC-UI-1')).text;
  assert.equal((ui1.match(/^  test\(/gm) || []).length, 4, 'four visible cases');
  assert.ok(!/\(2\)/.test(ui1), 'the holdout ready case does not shift numbering');
});

test('without a ui input the plan is what it was: no ui.json, no ui keys, nothing binary', () => {
  const f = fixture();
  const p = Core.handoverPlan(inputs(f, { ui: null, criteria: undefined, yamlDump: undefined }));
  assert.ok(!p.files.some(x => /ui\.json$|\/ui\//.test(x.path)));
  assert.ok(!/^ui:/m.test(p.files[0].text));
  assert.deepEqual(p.binaryCopies || [], []);
});

test('a UI handover copies the bound spec and the pack files it uses, and lists previews and holdout hashes in ui.json', () => {
  const f = fixture();
  const p = Core.handoverPlan(inputs(f));
  const at = rel => p.files.find(x => x.path === `handovers/${p.id}/${rel}`);
  assert.equal(at('ui/specs/bordereaux.json').text, f.specFile.text);
  const comps = f.specObj.slots; // every placement's component, copied at the same relative path
  const used = [...new Set(Object.values(comps).flat().map(x => x.component))].sort();
  for (const n of used) assert.ok(at(`ui/pack/components/${n}.json`), n);
  assert.ok(at('ui/pack/templates/list-detail.json'));
  assert.ok(!p.files.some(x => /\/ui\/pack\/components\/(?!(?:Button|DetailPanel|PageHeader|FilterBar|MetricCard|DataTable)\.json)/.test(x.path)));
  assert.ok(!p.files.some(x => /\/ui\/previews\/|\/ui\/holdout\//.test(x.path)), 'no preview or holdout text file');
  const doc = JSON.parse(at('ui.json').text);
  assert.equal(doc.schema, 'designc.handover.ui/1');
  assert.deepEqual(doc.pack, { name: 'acme-ui', hash: 'pinhash0123456789' });
  assert.equal(doc.screens.length, 1);
  const s = doc.screens[0];
  assert.equal(s.screen, 'bordereaux');
  assert.deepEqual(s.spec, { path: 'ui/specs/bordereaux.json', sha256: sha(f.specFile.text) });
  assert.equal(s.template.path, 'ui/pack/templates/list-detail.json');
  assert.deepEqual(s.components.map(c => c.name), used);
  assert.ok(s.components.every(c => /^[0-9a-f]{64}$/.test(c.sha256) && c.path === `ui/pack/components/${c.name}.json`));
  assert.deepEqual(s.previews, { approved_ts: 1700, files: f.files });
  assert.deepEqual(s.holdout, { path: 'ui/holdout/bordereaux.json', sha256: Ui.sha256(f.hold) });
  assert.deepEqual(s.holdout_cases, [{ criterion: 'AC-UI-1', case: 4, state: 'ready', sha256: Core.holdoutCaseHash(f.criteria[0].cases[4]) }]);
  const yml = at('handover.yaml').text;
  assert.match(yml, /^ui: "ui\.json"$/m);
  assert.match(yml, /^ui_screens: \["bordereaux"\]$/m);
  assert.deepEqual(p.binaryCopies.map(b => [b.from, b.to, b.sha256]), Object.entries(f.files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, h]) => [`ui/previews/bordereaux/${k}`, `handovers/${p.id}/ui/previews/bordereaux/${k}`, h]));
});

test('BUILD.md gets the UI rule and the ui: check in Done means, only when ui.json exists', () => {
  const f = fixture();
  const withUi = Core.handoverPlan(inputs(f)), without = Core.handoverPlan(inputs(f, { ui: null }));
  const brief = p => p.files.find(x => x.path.endsWith('/BUILD.md')).text;
  assert.match(brief(withUi), /`ui\.json`[^\n]*one library component per placement[^\n]*`data-ui-id` first[^\n]*no inline styles or raw values/);
  assert.match(brief(withUi), /- The `ui:` check passes for each screen \(bordereaux\) against the approved previews/);
  assert.ok(!/ui:` check|data-ui-id/.test(brief(without)));
});

test('the id covers preview and holdout hashes, and ignores the holdout text itself', () => {
  const f = fixture(), base = Core.handoverPlan(inputs(f)).id;
  assert.equal(Core.handoverPlan(inputs(fixture())).id, base, 'deterministic');
  const p2 = fixture(); p2.ui.previews[0].files['ready-chromium-linux.png'] = sha('other');
  assert.notEqual(Core.handoverPlan(inputs(p2)).id, base, 'a preview hash changes the id');
  const h2 = fixture(); h2.ui.holdouts.bordereaux = sha('another sample');
  assert.notEqual(Core.handoverPlan(inputs(h2)).id, base, 'a holdout hash changes the id');
  const c2 = fixture(); c2.criteria[0].cases[4] = { ...c2.criteria[0].cases[4], then: 'changed hidden case' };
  assert.notEqual(Core.handoverPlan(inputs(c2)).id, base, 'a holdout case hash changes the id');
});

test('LEAK: no holdout value and no holdout case text in any file of the plan, while both hashes are in ui.json', () => {
  const f = fixture();
  const p = Core.handoverPlan(inputs(f));
  const hold = JSON.parse(f.hold);
  const needles = [HOLDOUT_GIVEN, HOLDOUT_THEN, 'zebra-holdout', 'Quillfeather', 'Baltic Specialty', 'Meridian Agricultural Mutual', 'Cape Coastal Re', '6229550', '31 lines missing location', '$5,870,150', ...hold.bordereaux.map(r => r.Cedant)];
  for (const file of p.files) for (const n of needles) assert.ok(!file.text.includes(n), `${file.path} leaks ${n}`);
  const ui = p.files.find(x => x.path.endsWith('/ui.json')).text;
  assert.ok(ui.includes(Ui.sha256(f.hold)) && ui.includes(Core.holdoutCaseHash(f.criteria[0].cases[4])));
  const copy = p.files.find(x => x.path.endsWith('acceptance/AC-UI-1.yaml')).text;
  assert.match(copy, /^# designc: cases marked holdout are not in this copy/m);
  assert.ok(copy.includes('a slow API'), 'visible cases stay');
  assert.equal(p.files.find(x => x.path.endsWith('acceptance/AC-PLAIN.yaml')).text, f.criteria[1]._text, 'a criterion with no holdout case stays verbatim');
});

test('the planner refuses a screen that is not bound or has no approved previews', () => {
  const f = fixture();
  const unbound = fixture(); unbound.ui.specs = [{ path: f.specFile.path, text: JSON.stringify({ ...f.specObj, status: 'minted' }) }];
  assert.throws(() => Core.handoverPlan(inputs(unbound)), /handover refused: .*bordereaux.*not bound/);
  const none = fixture(); none.ui.previews = [];
  assert.throws(() => Core.handoverPlan(inputs(none)), /handover refused: .*bordereaux.*no approved previews/);
});

test('an item freeze takes only the screens of its in-scope UI elements', () => {
  const f = fixture();
  const other = Core.handoverPlan(inputs(f, { item: { id: 'W-1', requirement: ['R-1'], elements: ['Bordereaux API'] } }));
  assert.ok(!other.files.some(x => /ui\.json$/.test(x.path)), 'no UI element in scope: no ui.json');
  const mine = Core.handoverPlan(inputs(f, { item: { id: 'W-1', requirement: ['R-1'], elements: ['BordereauxList'] } }));
  assert.ok(mine.files.some(x => /ui\.json$/.test(x.path)));
});

test('holdoutCaseHash is the sha256 of the canonical JSON of the case, whatever the key order', () => {
  const c = { state: 'ready', given: 'g', then: 't', holdout: true };
  assert.equal(Core.holdoutCaseHash(c), sha(Ui.canon(c)));
  assert.equal(Core.holdoutCaseHash({ holdout: true, then: 't', given: 'g', state: 'ready' }), Core.holdoutCaseHash(c));
});
