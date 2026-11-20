// D8 slice 4: the clauses for a spec copied from ui/legacy/<screen>.json, in the app gate and the Python gate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const Ui = require('../renderer/ui.js');
const P = require('../paths.js');
const { hash, ls } = require('./helpers/ui.js');
const { CORE } = require('./helpers/parity.js');

const APP = path.resolve(__dirname, '..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const read = f => fs.readFileSync(f, 'utf8');
const clone = o => JSON.parse(JSON.stringify(o));
const SPEC = 'ui/specs/tags.json';

const legacy0 = () => JSON.parse(read(path.join(APP, 'fixtures/ui-project/ui/legacy/tags.json')));
const threeEdits = () => {
  const s = legacy0();
  s.slots['header.actions'] = s.slots['header.actions'].filter(p => p.id !== 'clear');
  s.slots['header.actions'].push({ id: 'refresh', component: 'Button', props: { label: 'Refresh', variant: 'ghost', onClick: 'refresh' }, locator: { role: 'button', name: 'Refresh' } });
  s.slots.main[0].props.density = 'compact';
  return s;
};
const removesClear = (over = {}) => ({ id: 'D-1', status: 'bound', kind: 'business', statement: 's', removes: [{ role: 'button', name: 'Clear', screen: 'tags' }], ...over });
const lookTags = (over = {}) => ({ id: 'D-2', status: 'bound', kind: 'technical', statement: 's', look: 'tags', ...over });

// Builds a scratch project, writes the spec and ledger rows, and returns what each gate says about ui/specs/tags.json.
// `rows(reg, specFile)` returns the ledger rows after the pin.
function run({ spec, decisions = [], rows = () => [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-leg-'));
  const reg = path.join(dir, 'project');
  try {
    fs.cpSync(path.join(APP, 'fixtures/ui-project'), reg, { recursive: true });
    fs.cpSync(path.join(APP, 'fixtures/ui-pack-registry'), path.join(dir, 'ui-pack-registry'), { recursive: true });
    const specFile = path.join(reg, SPEC);
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 2) + '\n');
    fs.mkdirSync(path.join(reg, 'ui/previews/tags'), { recursive: true });
    fs.writeFileSync(path.join(reg, 'ui/previews/tags/ready-chromium-linux.png'), 'ready');
    fs.mkdirSync(path.join(reg, 'decisions'), { recursive: true });
    for (const d of decisions) fs.writeFileSync(path.join(reg, `decisions/${d.id}.yaml`), yaml.dump(d));
    const pack = { components: ls(reg, 'ui/pack/components'), templates: ls(reg, 'ui/pack/templates') };
    const pin = { kind: 'ui_pinned', pack: 'acme-ui', registry: 'acme-ui', hash: Ui.packHash(Ui.packFiles(pack, 'ui/pack/'), hash) };
    const all = [pin, ...rows(reg, specFile)];
    fs.mkdirSync(path.join(reg, 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(reg, 'ledger/designc.jsonl'), all.map((r, i) => JSON.stringify({ schema_version: 1, event_id: `e${i}`, ts: 100 + i, by: 'mike', ...r })).join('\n') + '\n');
    const ledger = all.map((r, i) => ({ ...r, _ts: 100 + i }));
    const specHash = sha(fs.readFileSync(specFile));
    const js = Ui.clauses({ pack, specs: ls(reg, 'ui/specs'), legacy: ls(reg, 'ui/legacy'), holdouts: ls(reg, 'ui/holdout'), tokens: read(path.join(reg, 'design-tokens/tokens.json')), ledger, decisions,
      previews: { tags: P.previewHashes(reg, 'tags') }, specHashes: { tags: specHash }, hash }).clauses.filter(c => c.path === SPEC).map(c => c.text);
    const r = spawnSync(process.execPath, [CORE, 'check', reg, '--json', '--no-record'], { encoding: 'utf8' });
    const py = JSON.parse(r.stdout).gate.clauses.filter(c => c.kind === 'ui' && c.text.startsWith(SPEC)).map(c => c.text);
    return { js, py };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const REMOVED = `${SPEC}: button 'Clear' is removed from legacy with no bound decision that removes it`;
const LOOK = `${SPEC}: the look of tags differs from legacy with no bound decision citing its approved previews`;
const same = (name, inp, want) => test(`legacy clauses (${name}): JS and Python say ${want.length ? want.length : 'no'} clause${want.length === 1 ? '' : 's'}, the same words`, () => {
  const r = run(inp);
  assert.deepEqual(r.js, want);
  assert.deepEqual(r.py, want);
});
const render = { kind: 'ui_preview_rendered', screen: 'tags', spec_hash: 'a'.repeat(64), files: {}, image: 'ready-chromium-linux.png' };
const approve = (reg, specFile) => ({ kind: 'ui_preview_approved', screen: 'tags', spec: sha(fs.readFileSync(specFile)), files: P.previewHashes(reg, 'tags') });

same('unedited copy', { spec: legacy0() }, []);
same('three edits, no decisions', { spec: threeEdits() }, [REMOVED, LOOK]);
same('the added placement has its locator, so clause 1 is quiet', { spec: threeEdits(), decisions: [removesClear()] }, [LOOK]);
same('added and changed with no locator (a non-token prop change is not a look change)', { spec: (() => { const s = legacy0(); s.slots.aside[0].props.title = 'Changed'; s.slots['header.actions'].push({ id: 'x', component: 'Button', props: { label: 'X', variant: 'ghost', onClick: 'x' } }); return s; })() },
  [`${SPEC}: header.actions/x is new or changed from legacy, so it needs a locator`, `${SPEC}: aside/detail is new or changed from legacy, so it needs a locator`]);
same('a placement renamed to another locator is a removal and an addition', { spec: (() => { const s = legacy0(); s.slots['header.actions'][1].locator = { role: 'button', name: 'Reset' }; return s; })() }, [REMOVED]);
same('removed and look both covered by bound decisions, but the previews are not approved yet', { spec: threeEdits(), decisions: [removesClear(), lookTags()] }, [LOOK]);
same('removes with no screen counts for this screen', { spec: threeEdits(), decisions: [removesClear({ removes: [{ role: 'button', name: 'Clear' }] }), lookTags()] }, [LOOK]);
same('a removes for another screen does not cover', { spec: threeEdits(), decisions: [removesClear({ removes: [{ role: 'button', name: 'Clear', screen: 'other' }] }), lookTags()] }, [REMOVED, LOOK]);
same('a minted decision, or a bound technical one, does not remove', { spec: threeEdits(), decisions: [removesClear({ status: 'minted' }), removesClear({ id: 'D-3', kind: 'technical' })] }, [REMOVED, LOOK]);
same('everything covered and the approval current: no clause', { spec: threeEdits(), decisions: [removesClear(), lookTags()], rows: (reg, f) => [render, approve(reg, f)] }, []);
same('approval stale (rendered again after it): the look clause is back', { spec: threeEdits(), decisions: [removesClear(), lookTags()], rows: (reg, f) => [render, approve(reg, f), render] }, [LOOK]);
same('approval of another spec version: the look clause is back', { spec: threeEdits(), decisions: [removesClear(), lookTags()], rows: (reg, f) => [render, { ...approve(reg, f), spec: 'f'.repeat(64) }] }, [LOOK]);
same('a look decision for another screen does not cover', { spec: threeEdits(), decisions: [removesClear(), lookTags({ look: 'other' })], rows: (reg, f) => [render, approve(reg, f)] }, [LOOK]);
test('a spec with no legacy file is not compared (not derived)', () => {
  const root = path.join(APP, 'fixtures/ui-project');
  const pack = { components: ls(root, 'ui/pack/components'), templates: ls(root, 'ui/pack/templates') };
  const r = Ui.clauses({ pack, specs: [{ path: SPEC, text: JSON.stringify(threeEdits()) }], legacy: [], hash });
  assert.equal(r.clauses.filter(c => c.path === SPEC).length, 0);
});

test('a legacy file that does not parse is a note, never a clause', () => {
  const pack = { components: ls(path.join(APP, 'fixtures/ui-project'), 'ui/pack/components'), templates: ls(path.join(APP, 'fixtures/ui-project'), 'ui/pack/templates') };
  const specs = [{ path: SPEC, text: JSON.stringify(threeEdits()) }];
  const r = Ui.clauses({ pack, specs, legacy: [{ path: 'ui/legacy/tags.json', text: '{nope' }], hash });
  assert.equal(r.clauses.filter(c => c.path === SPEC).length, 0);
  assert.ok(r.notes.some(n => /ui\/legacy\/tags.json does not parse/.test(n)));
});
