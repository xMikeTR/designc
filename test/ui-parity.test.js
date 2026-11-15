// The Python gate and the app gate say the same words about UI packs, specs and holdouts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const Core = require('../renderer/core.js');
const Ui = require('../renderer/ui.js');
const { BROKEN, hash } = require('./helpers/ui.js');

const APP = path.resolve(__dirname, '..');
const skip = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';
const read = f => fs.readFileSync(f, 'utf8');
const spec0 = JSON.parse(read(path.join(APP, 'fixtures/ui-project/ui/specs/bordereaux.json')));

// A project folder next to its pack registry, both in a scratch folder. `edit(root, registryRoot)` changes the files.
function setup({ pin = true, edit } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-ui-'));
  const reg = path.join(dir, 'project');
  fs.cpSync(path.join(APP, 'fixtures/ui-project'), reg, { recursive: true });
  fs.cpSync(path.join(APP, 'fixtures/ui-pack-registry'), path.join(dir, 'ui-pack-registry'), { recursive: true });
  fs.mkdirSync(path.join(reg, 'ledger'));
  const files = Ui.packFiles(loadPack(reg), 'ui/pack/');
  if (pin) fs.writeFileSync(path.join(reg, 'ledger/designc.jsonl'), JSON.stringify({ schema_version: 1, event_id: 'pin-1', ts: 1, kind: 'ui_pinned', by: 'mike', pack: 'acme-ui', registry: 'acme-ui', hash: Ui.packHash(files, hash) }) + '\n');
  if (edit) edit(reg, path.join(dir, 'ui-pack-registry'));
  return reg;
}
const ls = (root, d) => (fs.existsSync(path.join(root, d)) ? fs.readdirSync(path.join(root, d)).filter(f => f.endsWith('.json')).sort().map(f => ({ path: `${d}/${f}`, text: read(path.join(root, d, f)) })) : []);
const loadPack = reg => ({ components: ls(reg, 'ui/pack/components'), templates: ls(reg, 'ui/pack/templates') });

function python(reg) {
  const r = spawnSync('python3', ['-m', 'designc', 'check', reg, '--json', '--no-record'], { cwd: path.join(APP, 'python'), encoding: 'utf8' });
  const out = JSON.parse(r.stdout);
  return { clauses: out.gate.clauses.filter(c => c.kind === 'ui').map(c => c.text), notes: out.gate.notes || [], coverage: out.gate.coverage || [] };
}
function js(reg) {
  const cfg = JSON.parse(read(path.join(reg, 'designc.json')));
  const model = Core.parse(read(path.join(reg, 'model/workspace.dsl')));
  const lf = path.join(reg, 'ledger/designc.jsonl');
  const ledger = (fs.existsSync(lf) ? read(lf) : '').split('\n').filter(Boolean).map(l => ({ ...JSON.parse(l), _ts: 1 }));
  const pin = Ui.latestPin(ledger);
  const sources = {};
  if (pin) {
    const base = path.join(reg, cfg.registries[pin.registry]);
    sources[pin.pack] = fs.existsSync(path.join(base, 'ui')) ? { components: ls(base, 'ui/components'), templates: ls(base, 'ui/templates') } : null;
  }
  const tp = path.join(reg, 'design-tokens/tokens.json');
  const yl = d => (fs.existsSync(path.join(reg, d)) ? fs.readdirSync(path.join(reg, d)).filter(f => /\.ya?ml$/.test(f)).sort().map(f => yaml.load(read(path.join(reg, d, f)))) : []);
  const ui = { pack: loadPack(reg), specs: ls(reg, 'ui/specs'), holdouts: ls(reg, 'ui/holdout'), sources, scenarios: yl('parity/scenarios') };
  const g = Core.gate({ model, diags: [], decisions: [], requirements: [], ledger, tokens: fs.existsSync(tp) ? read(tp) : null, ui, acceptance: yl('acceptance') });
  return { clauses: g.clauses.filter(c => c.kind === 'ui').map(c => c.text), notes: g.notes, coverage: g.coverage };
}
const withList = reg => wr(path.join(reg, 'model/workspace.dsl'), t => t.replace('app = softwareSystem "Bordereaux app"', 'app = softwareSystem "Bordereaux app" {\n      list = container "BordereauxList"\n    }'));
const acc = (states) => reg => {
  withList(reg);
  fs.mkdirSync(path.join(reg, 'acceptance'), { recursive: true });
  fs.writeFileSync(path.join(reg, 'acceptance/AC-1.yaml'), `id: AC-1\nrequirement: R-1\nelement: BordereauxList\nstates: [${states.join(', ')}]\ncases:\n${states.map(s => `  - { state: ${s}, given: g, then: t }`).join('\n')}\n`);
};
const sc = steps => reg => fs.writeFileSync(path.join(reg, 'parity/scenarios/bordereaux.yaml'), `id: bordereaux-list\nscreen: bordereaux\nsteps:\n${steps.map(s => `  - { state: ${s} }`).join('\n')}\n`);
const wr = (p, f) => fs.writeFileSync(p, f(read(p)));
const cases = {
  'pinned and current': {},
  'not pinned': { pin: false },
  'edited after the pin': { edit: reg => wr(path.join(reg, 'ui/pack/components/Button.json'), t => t + ' ') },
  'newer pack in its registry': { edit: (reg, r) => wr(path.join(r, 'ui/components/Button.json'), t => t + '\n') },
  'registry cannot be read': { edit: (reg, r) => fs.rmSync(path.join(r, 'ui'), { recursive: true }) },
  'broken spec': { edit: reg => fs.writeFileSync(path.join(reg, 'ui/specs/broken.json'), BROKEN) },
  'spec that does not parse': { edit: reg => fs.writeFileSync(path.join(reg, 'ui/specs/broken.json'), '{nope') },
  'holdout equal to the sample': { edit: reg => fs.writeFileSync(path.join(reg, 'ui/holdout/bordereaux.json'), JSON.stringify({ [Object.keys(spec0.data)[0]]: Object.values(spec0.data)[0].sample })) },
  'holdout with an unknown key': { edit: reg => fs.writeFileSync(path.join(reg, 'ui/holdout/bordereaux.json'), '{"nope": 1}') },
  'holdout that does not parse': { edit: reg => fs.writeFileSync(path.join(reg, 'ui/holdout/bordereaux.json'), '[') },
  'holdout for no spec': { edit: reg => fs.writeFileSync(path.join(reg, 'ui/holdout/ghost.json'), '{"a": 1}') },
  'no holdout for a screen': { edit: reg => fs.rmSync(path.join(reg, 'ui/holdout/bordereaux.json')) },
  'no tokens file': { edit: reg => fs.rmSync(path.join(reg, 'design-tokens'), { recursive: true }) },
  'component with a bad manifest': { edit: reg => wr(path.join(reg, 'ui/pack/components/Button.json'), t => t.replace('"name"', '"nom"')) },
  'criterion in states the spec has': { edit: acc(['ready', 'loading', 'empty', 'error']) },
  'criterion in a state the spec lacks (R1)': { edit: acc(['ready', 'loading', 'empty', 'error', 'forbidden']) },
  'criterion on another component': { edit: reg => { acc(['forbidden'])(reg); wr(path.join(reg, 'acceptance/AC-1.yaml'), t => t.replace('BordereauxList', 'Elsewhere')); } },
  'scenario step in a state the spec lacks (R2)': { edit: sc(['loading', 'ready', 'apply-dialog']) },
  'scenario that records some states (R4)': { edit: sc(['loading', 'ready']) },
  'scenario with no screen': { edit: reg => wr(path.join(reg, 'parity/scenarios/bordereaux.yaml'), t => t.replace('screen: bordereaux\n', '')) },
  'a transition that commits (R5)': { edit: reg => wr(path.join(reg, 'ui/specs/bordereaux.json'), t => { const s = JSON.parse(t); s.transitions[2].commits = true; return JSON.stringify(s, null, 2); }) },
  'spec file named other than its screen': { edit: reg => fs.renameSync(path.join(reg, 'ui/specs/bordereaux.json'), path.join(reg, 'ui/specs/other.json')) },
};
for (const [name, opts] of Object.entries(cases)) {
  test(`ui parity: ${name}`, { skip }, () => {
    const reg = setup(opts);
    try { assert.deepEqual(python(reg), js(reg)); } finally { fs.rmSync(path.dirname(reg), { recursive: true, force: true }); }
  });
}
test('ui parity: the pinned, current case says nothing at all', { skip }, () => {
  const reg = setup();
  try { assert.deepEqual(js(reg), { clauses: [], notes: [], coverage: [] }); } finally { fs.rmSync(path.dirname(reg), { recursive: true, force: true }); }
});
test('ui parity: the cases say something, so the comparison is not vacuous', { skip }, () => {
  const reg = setup({ edit: r => fs.writeFileSync(path.join(r, 'ui/specs/broken.json'), BROKEN) });
  try { const a = js(reg); assert.ok(a.clauses.length >= 13); assert.ok(a.notes.length >= 4); assert.deepEqual(python(reg), a); } finally { fs.rmSync(path.dirname(reg), { recursive: true, force: true }); }
});
test('ui parity: the state rules say something in both gates', { skip }, () => {
  for (const [name, re, where] of [['criterion in a state the spec lacks (R1)', /acceptance\/AC-1\/states\/4: State 'forbidden' is not in spec bordereaux/, 'clauses'], ['scenario step in a state the spec lacks (R2)', /steps\/2\/state: State 'apply-dialog'/, 'clauses'], ['scenario that records some states (R4)', /State 'error' is recorded by no parity step/, 'coverage'], ['a transition that commits (R5)', /ready → filtered commits/, 'coverage']]) {
    const reg = setup(cases[name]);
    try { const a = js(reg); assert.ok(a[where].some(t => re.test(t)), name); assert.deepEqual(python(reg), a); } finally { fs.rmSync(path.dirname(reg), { recursive: true, force: true }); }
  }
});
