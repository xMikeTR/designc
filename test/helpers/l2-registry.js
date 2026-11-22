// L2: temp registries and the Refactor state, shared by the refactor and LSP tests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Headless = require('../../headless/index.js');

const ROOT = path.join(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'designc-l2-'));
function sampleCopy() { const dir = tmp(); fs.cpSync(path.join(ROOT, 'sample-registry'), dir, { recursive: true }); return dir; }
function includeCopy() {
  const dir = sampleCopy();
  fs.rmSync(path.join(dir, 'model'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'fixtures/include-model'), path.join(dir, 'model'), { recursive: true });
  return dir;
}
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
// {files, cfgModel, model} from a registry folder on disk (what checkState hands the language server).
function stateOf(dir, overlay = {}) {
  const s = Headless.checkState(dir, { overlay });
  if (s.error) throw new Error(s.error);
  return { files: s.files, cfgModel: s.cfg.model, model: s.model, s };
}
// Apply {path, range: {line0, c, n}, newText} edits (single-line ranges) to a files map; returns a new map.
function applyEdits(files, edits) {
  const out = { ...files };
  const byPath = new Map();
  for (const e of edits) { if (!byPath.has(e.path)) byPath.set(e.path, []); byPath.get(e.path).push(e); }
  for (const [p, list] of byPath) {
    const lines = out[p].split('\n');
    for (const e of list.slice().sort((a, b) => b.range.line0 - a.range.line0 || b.range.c - a.range.c)) {
      const l = lines[e.range.line0];
      lines[e.range.line0] = l.slice(0, e.range.c) + e.newText + l.slice(e.range.c + e.range.n);
    }
    out[p] = lines.join('\n');
  }
  return out;
}
module.exports = { ROOT, tmp, sampleCopy, includeCopy, write, read, stateOf, applyEdits };

// sample-registry plus bound decisions, a work item and a scenario that name Bookings DB / Fares API (L2 slice 3).
function renameRegistry({ includes = false } = {}) {
  const Core = require('../../renderer/core.js');
  const dir = includes ? includeCopy() : sampleCopy();
  const s = Headless.checkState(dir), m = s.model;
  const el = n => [...m.elements.values()].find(e => e.name === n);
  const entry = (n, hash) => ({ element: el(n).ident || '', name: n, hash: hash || Core.fingerprint(m, el(n).id).hash });
  const bound = (id, extra, against) => `id: ${id}\nstatus: bound\nkind: technical\neffect: fix\nbinds: [${extra.binds}]\nresolves: [${extra.resolves || 'DC002'}]\nstatement: s\nchecks: [true]\nrationale: ""\npromoted_by: mike\npromoted_at: 2026-11-01\npromoted_against: ${JSON.stringify(against)}\n`;
  write(dir, 'decisions/accept-escalations.yaml', `id: accept-escalations\nstatus: bound\nkind: technical\neffect: accept\nrelies_on: [biz-ok]\nbinds: [Bookings DB]\nresolves: [DC002]\nstatement: accepted\nchecks: []\nrationale: ""\npromoted_by: mike\npromoted_at: 2026-11-01\npromoted_against: ${JSON.stringify([entry('Bookings DB')])}\n`);
  write(dir, 'decisions/biz-ok.yaml', `id: biz-ok\nstatus: bound\nkind: business\nrequirement: DEMO-1234\nbinds: []\nresolves: []\nstatement: ok\nrationale: ""\npromoted_by: mike\npromoted_at: 2026-11-01\npromoted_against: ${JSON.stringify([{ requirement: 'DEMO-1234', version: 7 }])}\n`);
  write(dir, 'decisions/fix-api.yaml', bound('fix-api', { binds: 'Fares API', resolves: 'DC001' }, [entry('Fares API')]));
  write(dir, 'decisions/old.yaml', bound('old', { binds: 'Fares API', resolves: 'DC001' }, [entry('Fares API', '0000000000000000')]));
  write(dir, 'work/W-1.yaml', 'id: W-1\nrequirement: DEMO-1234\nelements: [Bookings DB]\nrepo: ../r\nwrites: ["src/**"]\ndone_when:\n  - gate: npm test\n');
  write(dir, 'scenarios/s1.yaml', 'id: s1\ntitle: t\nattribute: availability\nartifact: Bookings DB\n');
  write(dir, 'handovers/h1/decisions/frozen.yaml', 'id: frozen\nbinds: [Bookings DB]\n');
  return dir;
}
module.exports.renameRegistry = renameRegistry;
