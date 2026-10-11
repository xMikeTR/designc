// Shared by the Python parity tests: the app's loadRegistry/loadLedger/gate for a folder on disk, and `designc check --json`.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const Core = require('../../renderer/core.js');
const Ledger = require('../../renderer/ledger.js');
const V = require('../../renderer/canvas/vocabulary.js');
Core.registerProperties(V.coreSpecs());

const ROOT = path.join(__dirname, '..', '..');
const PY = path.join(ROOT, 'python');

function listDir(root, dir, exts) {
  let names = []; try { names = fs.readdirSync(path.join(root, dir)); } catch { return []; }
  return names.filter(n => exts.some(x => n.endsWith(x))).sort().map(n => ({ path: `${dir}/${n}`, text: fs.readFileSync(path.join(root, dir, n), 'utf8') }));
}

// The renderer's loadRegistry and loadLedger, for a folder on disk.
function nodeState(root) {
  const cfg = { model: 'model/workspace.dsl', chainHops: 4, ...(fs.existsSync(path.join(root, 'designc.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'designc.json'), 'utf8')) : {}) };
  const yamlErrors = [];
  const load = (dir, keepText = false) => {
    const out = [];
    for (const f of listDir(root, dir, ['.yaml', '.yml'])) {
      try {
        const o = yaml.load(f.text) || {};
        if (typeof o !== 'object' || Array.isArray(o)) throw new Error('expected a mapping');
        for (const k of ['binds', 'resolves', 'checks', 'elements']) if (o[k] != null && !Array.isArray(o[k])) o[k] = [o[k]];
        out.push({ ...o, id: o.id || f.path.split('/').pop().replace(/\.ya?ml$/, ''), ...(keepText ? { _text: f.text } : {}) });
      } catch (e) { yamlErrors.push({ path: f.path }); }
    }
    return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  };
  const decisions = load('decisions'), requirements = load('requirements'), scenarios = load('scenarios'), evals = load('evals', true);
  load('proposals'); load('handovers');
  const hv = path.join(root, 'handovers');
  if (fs.existsSync(hv)) for (const n of fs.readdirSync(hv).sort()) if (fs.statSync(path.join(hv, n)).isDirectory()) load(`handovers/${n}`);
  decisions.forEach(d => { d.status = d.status || 'minted'; d.effect = d.effect || 'fix'; });
  let raw = [];
  for (const f of listDir(root, 'ledger', ['.jsonl'])) raw.push(...Ledger.parse(f.text, f.path).events);
  const ledger = Ledger.derive(Ledger.order(raw));
  const model = Core.parse(fs.readFileSync(path.join(root, cfg.model), 'utf8'));
  const diags = Core.check(model, { chainHops: cfg.chainHops || 4 });
  const gate = Core.gate({ model, diags, decisions, requirements, ledger, registryErrors: yamlErrors, evidenceHosts: cfg.evidenceHosts || [], businessOwners: cfg.businessOwners || [], scenarios, evals });
  return { model, diags, gate, modelText: fs.readFileSync(path.join(root, cfg.model), 'utf8') };
}
function nodeReport(root) {
  const { model, diags, gate } = nodeState(root);
  return {
    errors: model.errors.map(e => ({ line: e.line, msg: e.msg })),
    findings: diags.map(d => ({ code: d.code, sev: d.sev, msg: d.msg, label: d.loc.label, line: d.loc.line, unknown: !!d.unknown, suppressed: d.suppressed || null })),
    gate: { ready: gate.ready, clauses: gate.clauses.map(c => ({ kind: c.kind, text: c.text })) },
  };
}

function pyReport(root) {
  const r = spawnSync('python3', ['-m', 'designc', 'check', root, '--json', '--no-record'], { cwd: PY, encoding: 'utf8' });
  assert.ok(r.stdout, `designc printed nothing. stderr: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function tmpRegistry(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-cli-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

module.exports = { ROOT, PY, listDir, nodeState, nodeReport, pyReport, tmpRegistry };
