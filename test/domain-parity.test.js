// The Python gate and the app gate say the same words about domain packs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const Core = require('../renderer/core.js');
const Domain = require('../renderer/domain.js');

const APP = path.resolve(__dirname, '..');
const PACK = fs.readFileSync(path.join(APP, 'fixtures/domain-registry/domain/pricing.yaml'), 'utf8');
const hash = text => Core.evalHash({ _text: text });

// A project folder next to a domain registry, both in a scratch folder.
function setup({ pin = true, copy = PACK, source = PACK, owns = 'Quote', p } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-domain-'));
  const reg = path.join(dir, 'project');
  fs.cpSync(path.join(APP, 'fixtures/domain-project'), reg, { recursive: true });
  fs.mkdirSync(path.join(reg, 'domain'));
  fs.mkdirSync(path.join(reg, 'ledger'));
  fs.writeFileSync(path.join(reg, 'domain/pricing.yaml'), copy);
  fs.writeFileSync(path.join(reg, 'model/workspace.dsl'), fs.readFileSync(path.join(reg, 'model/workspace.dsl'), 'utf8').replace('"d.owns" "Quote"', `"d.owns" "${owns}"`));
  if (p != null) fs.writeFileSync(path.join(reg, 'behaviour/quotes.p'), p);
  if (source == null) fs.rmSync(path.join(dir, 'domain-registry'), { recursive: true, force: true });
  else { fs.mkdirSync(path.join(dir, 'domain-registry/domain'), { recursive: true }); fs.writeFileSync(path.join(dir, 'domain-registry/domain/pricing.yaml'), source); }
  if (pin) fs.writeFileSync(path.join(reg, 'ledger/designc.jsonl'), JSON.stringify({ schema_version: 1, event_id: 'pin-1', ts: 1, kind: 'domain_pinned', by: 'mike', pack: 'pricing', registry: 'pricing', hash: hash(PACK) }) + '\n');
  return reg;
}

function python(reg) {
  const r = spawnSync('python3', ['-m', 'designc', 'check', reg, '--json', '--no-record'], { cwd: path.join(APP, 'python'), encoding: 'utf8' });
  const out = JSON.parse(r.stdout);
  return { clauses: out.gate.clauses.filter(c => c.kind === 'domain').map(c => c.text), notes: out.gate.notes || [] };
}

function js(reg) {
  const cfg = JSON.parse(fs.readFileSync(path.join(reg, 'designc.json'), 'utf8'));
  const read = f => fs.readFileSync(f, 'utf8');
  const model = Core.parse(read(path.join(reg, 'model/workspace.dsl')));
  const packs = fs.readdirSync(path.join(reg, 'domain')).map(n => ({ key: n.replace(/\.ya?ml$/, ''), path: `domain/${n}`, text: read(path.join(reg, 'domain', n)) }));
  const lf = path.join(reg, 'ledger/designc.jsonl');
  const ledger = (fs.existsSync(lf) ? read(lf) : '').split('\n').filter(Boolean).map(l => ({ ...JSON.parse(l), _ts: 1 }));
  const pins = Domain.pins(ledger);
  const sources = {};
  for (const p of packs) if (pins.has(p.key)) {
    const f = path.join(reg, cfg.registries[pins.get(p.key).registry], 'domain', `${p.key}.yaml`);
    sources[p.key] = fs.existsSync(f) ? read(f) : null;
  }
  const behaviour = fs.readdirSync(path.join(reg, 'behaviour')).map(n => ({ path: `behaviour/${n}`, text: read(path.join(reg, 'behaviour', n)) }));
  const g = Core.gate({ model, diags: [], decisions: [], requirements: [], ledger, domains: { listed: cfg.domains, packs, sources, behaviour } });
  return { clauses: g.clauses.filter(c => c.kind === 'domain').map(c => c.text), notes: g.notes };
}

const cases = {
  'pinned and current': {},
  'not pinned': { pin: false },
  'edited after the pin': { copy: PACK + '# local edit\n' },
  'newer pack in its registry': { source: PACK + '# v4\n' },
  'registry cannot be read': { source: null },
  'owns a misspelt aggregate': { owns: 'Qoute' },
  'owns a field, not an aggregate': { owns: 'pricing/Money' },
  'P event with another payload': { p: 'event eQuoteBound: (quote: int);\n' },
  'P event with a non-tuple payload': { p: 'event eQuoteBound: int;\n' },
  'pack with DDD problems': (() => { const bad = PACK.replace('    id: CedantId\n', '').replace('cedant: { ref: Cedant }', 'cedant: Cedant'); return { copy: bad, source: bad }; })(),
};
for (const [name, opts] of Object.entries(cases)) {
  test(`domain parity: ${name}`, () => {
    const reg = setup(opts);
    try {
      const a = js(reg), b = python(reg);
      assert.deepEqual(b, a);
    } finally { fs.rmSync(path.dirname(reg), { recursive: true, force: true }); }
  });
}

test('domain parity: the pinned, current case says nothing; the others say something', () => {
  const reg = setup();
  try { assert.deepEqual(js(reg), { clauses: [], notes: [] }); } finally { fs.rmSync(path.dirname(reg), { recursive: true, force: true }); }
});

test('domain registry: designc check validates its packs and exits 0 or 1', () => {
  const run = r => spawnSync('python3', ['-m', 'designc', 'check', r], { cwd: path.join(APP, 'python'), encoding: 'utf8' });
  assert.equal(run(path.join(APP, 'fixtures/domain-registry')).status, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-domain-'));
  try {
    fs.cpSync(path.join(APP, 'fixtures/domain-registry'), dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'domain/pricing.yaml'), PACK.replace('    id: CedantId\n', ''));
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /aggregate Cedant needs an id/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
