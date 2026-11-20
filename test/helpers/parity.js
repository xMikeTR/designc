// Shared by the gate tests: the app's loadRegistry/loadLedger/gate for a folder on disk (nodeReport), and `designc-core check --json` (coreReport).
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const Core = require('../../renderer/core.js');
const Ledger = require('../../renderer/ledger.js');

const ROOT = path.join(__dirname, '..', '..');
const PY = path.join(ROOT, 'python');
const CORE = path.join(ROOT, 'scripts', 'designc-core.js');

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
  const model = Core.parse(fs.readFileSync(path.join(root, cfg.model), 'utf8'), { path: cfg.model, resolve: p => { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return null; } } });
  const apiFiles = listDir(root, 'contracts/openapi', ['.yaml', '.yml']);
  const operations = Core.operations({ files: Object.fromEntries(apiFiles.map(f => [f.path, f.text])), yamlLoad: require('js-yaml').load });
  const diags = Core.check(model, { chainHops: cfg.chainHops || 4, repos: cfg.repos, boundary: { operations, events: [] } });
  const gate = Core.gate({ model, diags, decisions, requirements, ledger, registryErrors: yamlErrors, evidenceHosts: cfg.evidenceHosts || [], businessOwners: cfg.businessOwners || [], scenarios, evals, repos: cfg.repos, apiContracts: apiFiles.map(f => f.path), operations });
  return { model, diags, gate, modelText: fs.readFileSync(path.join(root, cfg.model), 'utf8') };
}
// Core now carries the agentic rules (AG001-AG011) in every host; Python never had them. Until A2 retires the Python
// front end, the Python-vs-Node comparisons remove the AG findings and the clauses they caused from the Node side
// (ready is recomputed). AG findings are asserted on their own in test/core-registration.test.js and test/designc-core-check.test.js.
const isAgClause = c => c.kind === 'finding' && /^AG\d{3} /.test(c.text);
function withoutAg(report) {
  const clauses = report.gate.clauses.filter(c => !isAgClause(c));
  return { ...report, findings: report.findings.filter(f => !/^AG\d{3}$/.test(f.code)), gate: { ...report.gate, ready: clauses.length === 0, clauses } };
}
function nodeReport(root, { ag = true } = {}) {
  const { model, diags, gate } = nodeState(root);
  const r = {
    errors: model.errors.map(e => ({ line: e.line, file: e.file, msg: e.msg })),
    findings: diags.map(d => ({ code: d.code, sev: d.sev, msg: d.msg, label: d.loc.label, line: d.loc.line, file: d.loc.file, unknown: !!d.unknown, suppressed: d.suppressed || null })),
    gate: { ready: gate.ready, clauses: gate.clauses.map(c => ({ kind: c.kind, text: c.text })) },
  };
  return ag ? r : withoutAg(r);
}

// The command line the Factory and pipelines run: `designc-core check --json --no-record` (the Node core; `python -m designc check` shims it).
function coreReport(root) {
  const r = spawnSync(process.execPath, [CORE, 'check', root, '--json', '--no-record'], { encoding: 'utf8' });
  assert.ok(r.stdout, `designc-core check printed nothing. stderr: ${r.stderr}`);
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

module.exports = { withoutAg, ROOT, PY, CORE, listDir, nodeState, nodeReport, coreReport, tmpRegistry };
