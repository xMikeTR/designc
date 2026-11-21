// L2 slice 1: what the position work must not change. `snapshot()` is run at 8886021 to write test/data/l2-invariance.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Core = require('../../renderer/core.js');
const Headless = require('../../headless/index.js');

const ROOT = path.join(__dirname, '..', '..');

function includeRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-l2inv-'));
  fs.cpSync(path.join(ROOT, 'sample-registry'), dir, { recursive: true });
  fs.rmSync(path.join(dir, 'model'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'fixtures/include-model'), path.join(dir, 'model'), { recursive: true });
  return dir;
}
const REGISTRIES = { 'sample-registry': () => path.join(ROOT, 'sample-registry'), 'split-registry': () => path.join(ROOT, 'fixtures/split-registry'),
  'include-registry': includeRegistry, 'core-registry': () => path.join(ROOT, 'fixtures/core-registry') };

function snapshot() {
  const out = {};
  for (const [name, mk] of Object.entries(REGISTRIES)) {
    const s = Headless.checkState(mk());
    if (s.error) { out[name] = { error: s.error }; continue; }
    const m = s.model;
    out[name] = {
      findings: s.diags.map(d => JSON.parse(JSON.stringify({ code: d.code, sev: d.sev, msg: d.msg, loc: d.loc, related: d.related, hint: d.hint, unknown: d.unknown, suppressed: d.suppressed }))),
      fingerprints: [...m.elements.keys()].map(id => [id, Core.fingerprint(m, id).hash]),
      verdict: Core.gateRecord({ modelText: s.modelText, modelIncludes: m.sources.slice(1), diags: s.diags, gate: s.gate, source: 'test' }).verdict,
      errors: m.errors,
    };
  }
  return out;
}
module.exports = { snapshot, includeRegistry, REGISTRIES };
