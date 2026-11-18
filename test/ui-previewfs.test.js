// Slice 3 (D3): the main process hashes and shows previews for one screen, read-only, and the Python gate reads the same disk.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../paths.js');

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const scratch = fn => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-pv-')); try { fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); } };
const put = (root, rel, b) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, b); };

test('previewHashes: every file under ui/previews/<screen>/, placements included, forward slashes, by sha256', () => scratch(root => {
  put(root, 'ui/previews/bordereaux/ready-chromium-linux.png', PNG);
  put(root, 'ui/previews/bordereaux/ready.aria.yml', 'a: 1\n');
  put(root, 'ui/previews/bordereaux/placements/ready__header-chromium-linux.png', PNG);
  put(root, 'ui/previews/other/ready-chromium-linux.png', 'other');
  assert.deepEqual(P.previewHashes(root, 'bordereaux'), {
    'placements/ready__header-chromium-linux.png': sha(PNG),
    'ready-chromium-linux.png': sha(PNG),
    'ready.aria.yml': sha('a: 1\n'),
  });
  assert.deepEqual(P.previewHashes(root, 'nothing-here'), {});
}));
test('previewHashes and specHash refuse a screen that is not [a-z0-9-]+', () => scratch(root => {
  put(root, 'secret.txt', 'x');
  for (const bad of ['..', '../x', 'a/b', 'A', 'a b', '', null, undefined, 5, 'a\n']) {
    assert.throws(() => P.previewHashes(root, bad), /screen/, String(bad));
    assert.throws(() => P.specHash(root, bad), /screen/, String(bad));
    assert.throws(() => P.previewImage(root, bad, 'x.png'), /screen/, String(bad));
  }
}));
test('previewHashes does not follow a symlink out of the folder', () => scratch(root => {
  put(root, 'outside/leak.png', 'secret');
  fs.mkdirSync(path.join(root, 'ui/previews/bordereaux'), { recursive: true });
  try { fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'ui/previews/bordereaux/link')); } catch { return; }
  assert.deepEqual(P.previewHashes(root, 'bordereaux'), {});
}));
test('specHash is the sha256 of the spec file bytes, null when there is none', () => scratch(root => {
  put(root, 'ui/specs/bordereaux.json', '{"a": 1}\r\n');
  assert.equal(P.specHash(root, 'bordereaux'), sha('{"a": 1}\r\n'));
  assert.equal(P.specHash(root, 'ghost'), null);
}));
test('previewImage returns a data URL for a page picture only, never a placement, a path or a non-picture', () => scratch(root => {
  put(root, 'ui/previews/bordereaux/ready-chromium-linux.png', PNG);
  put(root, 'ui/previews/bordereaux/ready.aria.yml', 'a');
  put(root, 'ui/previews/bordereaux/placements/ready__h-chromium-linux.png', PNG);
  assert.equal(P.previewImage(root, 'bordereaux', 'ready-chromium-linux.png'), `data:image/png;base64,${PNG.toString('base64')}`);
  for (const rel of ['ready.aria.yml', 'placements/ready__h-chromium-linux.png', '../ready-chromium-linux.png', '../../../specs/x.png', 'nope-chromium-linux.png', '']) assert.equal(P.previewImage(root, 'bordereaux', rel), null, rel);
}));

// The Python gate reads the same disk: previews and the spec's hash, and says the same as the JS rule.
const skip = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';
const APP = path.resolve(__dirname, '..');
const STATES = ['ready', 'loading', 'empty', 'error', 'filtered'];
function project(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-pvp-'));
  const reg = path.join(dir, 'project');
  try {
    fs.cpSync(path.join(APP, 'fixtures/ui-project'), reg, { recursive: true });
    fs.cpSync(path.join(APP, 'fixtures/ui-pack-registry'), path.join(dir, 'ui-pack-registry'), { recursive: true });
    const dsl = path.join(reg, 'model/workspace.dsl');
    fs.writeFileSync(dsl, fs.readFileSync(dsl, 'utf8').replace('app = softwareSystem "Bordereaux app"', 'app = softwareSystem "Bordereaux app" {\n      list = container "BordereauxList" "" "" "UI"\n    }'));
    const Ui = require('../renderer/ui.js'), { hash, ls } = require('./helpers/ui.js');
    const pack = { components: ls(reg, 'ui/pack/components'), templates: ls(reg, 'ui/pack/templates') };
    const specFile = path.join(reg, 'ui/specs/bordereaux.json');
    fs.writeFileSync(specFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(specFile, 'utf8')), status: 'bound' }, null, 2));
    for (const s of STATES) put(reg, `ui/previews/bordereaux/${s}-chromium-linux.png`, `${s}`);
    const rows = [{ kind: 'ui_pinned', pack: 'acme-ui', registry: 'acme-ui', hash: Ui.packHash(Ui.packFiles(pack, 'ui/pack/'), hash) }];
    fn(reg, rows, specFile);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const writeLedger = (reg, rows) => { fs.mkdirSync(path.join(reg, 'ledger'), { recursive: true }); fs.writeFileSync(path.join(reg, 'ledger/designc.jsonl'), rows.map((r, i) => JSON.stringify({ schema_version: 1, event_id: `e${i}`, ts: 100 + i, by: 'mike', ...r })).join('\n') + '\n'); };
const py = reg => { const r = spawnSync('python3', ['-m', 'designc', 'check', reg, '--json', '--no-record'], { cwd: path.join(APP, 'python'), encoding: 'utf8' }); return JSON.parse(r.stdout).gate.clauses.filter(c => c.kind === 'ui').map(c => c.text); };
const approval = (reg, specFile) => ({ kind: 'ui_preview_approved', screen: 'bordereaux', spec: sha(fs.readFileSync(specFile)), files: P.previewHashes(reg, 'bordereaux') });
const RENDER = { kind: 'ui_preview_rendered', screen: 'bordereaux', spec_hash: 'a'.repeat(64), files: { 'ready-chromium-linux.png': 'a'.repeat(64) }, image: 'ready-chromium-linux.png' };

test('python gate: rendered and approved from the disk it reads clears check 4, an edited picture brings it back', { skip }, () => project((reg, rows, specFile) => {
  writeLedger(reg, [...rows, RENDER, approval(reg, specFile)]);
  assert.deepEqual(py(reg), []);
  fs.writeFileSync(path.join(reg, 'ui/previews/bordereaux/ready-chromium-linux.png'), 'edited');
  assert.deepEqual(py(reg), ['ui/specs/bordereaux.json: approval is stale: files changed since. Render again, then approve']);
}));
test('python gate: a spec edited after approval, and a render after approval', { skip }, () => project((reg, rows, specFile) => {
  const a = approval(reg, specFile);
  writeLedger(reg, [...rows, RENDER, a, RENDER]);
  assert.deepEqual(py(reg), ['ui/specs/bordereaux.json: approval is stale: rendered again since. Look at the new previews, then approve again']);
  writeLedger(reg, [...rows, RENDER, a]);
  fs.writeFileSync(specFile, fs.readFileSync(specFile, 'utf8') + '\n');
  assert.deepEqual(py(reg), ['ui/specs/bordereaux.json: approval is stale: the spec changed since. Render again, then approve']);
}));
test('python gate: a UI element with no preview folder at all is not rendered', { skip }, () => project((reg, rows) => {
  writeLedger(reg, rows);
  assert.deepEqual(py(reg), ['ui/specs/bordereaux.json: previews not rendered. Run factory-s2 preview for bordereaux']);
}));
