// `designc-core check` (the compiler on the Node core) and `python -m designc check`, which is a shim that runs it: the same
// stdout, stderr and exit code, AG findings included. Without python3 these tests FAIL, they never skip.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Core = require('../renderer/core.js');
const Ui = require('../renderer/ui.js');
const Domain = require('../renderer/domain.js');
const Headless = require('../headless/index.js');
const { main } = require('../scripts/designc-core.js');
const { BROKEN, hash } = require('./helpers/ui.js');
const { ROOT, PY, tmpRegistry } = require('./helpers/parity.js');

const read = f => fs.readFileSync(f, 'utf8');
const wr = (p, f) => fs.writeFileSync(p, f(read(p)));
const hasPython = spawnSync('python3', ['--version']).status === 0;
test('python3 is available (the shim needs it)', () => assert.ok(hasPython, 'python3 needed for the python -m designc check shim'));

const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['CI', 'TF_BUILD', 'GITLAB_CI', 'GITHUB_ACTIONS'].includes(k)));
function js(root, args = []) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/designc-core.js'), 'check', root, '--json', '--no-record', ...args], { encoding: 'utf8', env: CLEAN_ENV });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function py(root, args = []) {
  const r = spawnSync('python3', ['-m', 'designc', 'check', root, '--json', '--no-record', ...args], { cwd: PY, encoding: 'utf8', env: CLEAN_ENV });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
// The shim must print what the Node command prints and exit the same way.
function equal(root, label) {
  const a = js(root), b = py(root);
  assert.equal(a.status === 0 || a.status === 1, true, `${label}: node ${a.stderr}`);
  assert.equal(b.stdout, a.stdout, label);
  assert.equal(b.stderr, a.stderr, `${label}: stderr`);
  assert.equal(b.status, a.status, `${label}: exit code`);
  return JSON.parse(a.stdout);
}

// ---- every registry parity-of-rules would check, plus sample-registry
test('sample-registry: the shim prints the same JSON, byte for byte', () => {
  const root = path.join(ROOT, 'sample-registry');
  const a = js(root), b = py(root);
  assert.equal(a.stdout, b.stdout);
  assert.equal(a.status, b.status);
});
test('fixtures/fullstack: the shim prints the same JSON, byte for byte', () => {
  const root = path.join(ROOT, 'fixtures/fullstack');
  const a = js(root), b = py(root);
  assert.equal(a.stdout, b.stdout);
  assert.equal(a.status, b.status);
});
for (const name of fs.readdirSync(path.join(ROOT, 'fixtures')).sort()) {
  const root = path.join(ROOT, 'fixtures', name), cfgPath = path.join(root, 'designc.json');
  if (!fs.existsSync(cfgPath)) continue;
  const cfg = JSON.parse(read(cfgPath));
  if (cfg.kind === 'study' || cfg.kind === 'domain' || cfg.domains || fs.existsSync(path.join(root, 'ui')) || !fs.existsSync(path.join(root, cfg.model || 'model/workspace.dsl'))) continue;
  test(`fixtures/${name} shim equals the core`, () => { equal(root, name); });
}
test('synthetic model with every rule: shim equals the core', () => {
  equal(tmpRegistry({ 'model/workspace.dsl': read(path.join(ROOT, 'fixtures/fullstack/model/workspace.dsl')) }), 'model only');
});

// ---- the AG rules, which only the Node front end has
const REPRO = 'workspace { model { s = softwareSystem "S" { t = container "Triage agent" { tags "Agent" properties { "d.agent.pattern" "orchestrator-workers" } } } } }';
test('the R1 repro model exits 1 with AG001, AG003, AG005 and AG011 as blocking clauses', () => {
  const r = js(tmpRegistry({ 'model/workspace.dsl': REPRO }));
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.gate.ready, false);
  assert.deepEqual(out.gate.clauses.map(c => c.text), ['AG001', 'AG003', 'AG005', 'AG011'].map(c => `${c} on Triage agent is neither fixed nor accepted`));
  assert.ok(!out.findings.some(f => f.code === 'DC000'));
});
test('fixtures/agent-registry fails headless with AG findings (and the same findings through the library)', () => {
  const root = path.join(ROOT, 'fixtures/agent-registry');
  const r = js(root);
  assert.equal(r.status, 1);
  const codes = new Set(JSON.parse(r.stdout).findings.map(f => f.code));
  assert.deepEqual([...codes], ['AG011']);
  const lib = Headless.check(root);
  assert.equal(JSON.stringify(lib.report, null, 2), r.stdout.trimEnd());
});
test('the registered rule-code set does not depend on how core is loaded', () => {
  const alone = spawnSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./renderer/core.js').RULES.map(r => r.code).sort()))"], { cwd: ROOT, encoding: 'utf8' });
  const viaHeadless = spawnSync(process.execPath, ['-e', "require('./headless'); console.log(JSON.stringify(require('./renderer/core.js').RULES.map(r => r.code).sort()))"], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(alone.stdout, viaHeadless.stdout);
  assert.match(alone.stdout, /AG011/);
});

// ---- domain and ui setups (the ones in domain-parity.test.js and ui-parity.test.js)
const PACK = read(path.join(ROOT, 'fixtures/domain-registry/domain/fares.yaml'));
function domainSetup({ pin = true, copy = PACK, source = PACK, owns = 'Booking', p } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-core-domain-'));
  const reg = path.join(dir, 'project');
  fs.cpSync(path.join(ROOT, 'fixtures/domain-project'), reg, { recursive: true });
  fs.mkdirSync(path.join(reg, 'domain')); fs.mkdirSync(path.join(reg, 'ledger'));
  fs.writeFileSync(path.join(reg, 'domain/fares.yaml'), copy);
  fs.writeFileSync(path.join(reg, 'model/workspace.dsl'), read(path.join(reg, 'model/workspace.dsl')).replace('"d.owns" "Booking"', `"d.owns" "${owns}"`));
  if (p != null) fs.writeFileSync(path.join(reg, 'behaviour/bookings.p'), p);
  if (source == null) fs.rmSync(path.join(dir, 'domain-registry'), { recursive: true, force: true });
  else { fs.mkdirSync(path.join(dir, 'domain-registry/domain'), { recursive: true }); fs.writeFileSync(path.join(dir, 'domain-registry/domain/fares.yaml'), source); }
  if (pin) fs.writeFileSync(path.join(reg, 'ledger/designc.jsonl'), JSON.stringify({ schema_version: 1, event_id: 'pin-1', ts: 1, kind: 'domain_pinned', by: 'mike', pack: 'fares', registry: 'fares', hash: Core.evalHash({ _text: PACK }) }) + '\n');
  return reg;
}
const domainCases = {
  'pinned and current': {}, 'not pinned': { pin: false }, 'edited after the pin': { copy: PACK + '# local edit\n' },
  'newer pack in its registry': { source: PACK + '# v4\n' }, 'registry cannot be read': { source: null },
  'owns a misspelt aggregate': { owns: 'Bookign' }, 'owns a field, not an aggregate': { owns: 'fares/Money' },
  'P event with another payload': { p: 'event eBookingBound: (booking: int);\n' },
  'pack with DDD problems': (() => { const bad = PACK.replace('    id: PartnerId\n', '').replace('partner: { ref: Partner }', 'partner: Partner'); return { copy: bad, source: bad }; })(),
};
for (const [name, opts] of Object.entries(domainCases)) {
  test(`domain registry setup, shim equals the core: ${name}`, () => {
    const reg = domainSetup(opts);
    try { equal(reg, name); } finally { fs.rmSync(path.dirname(reg), { recursive: true, force: true }); }
  });
}

function uiSetup({ pin = true, edit } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-core-ui-'));
  const reg = path.join(dir, 'project');
  fs.cpSync(path.join(ROOT, 'fixtures/ui-project'), reg, { recursive: true });
  fs.cpSync(path.join(ROOT, 'fixtures/ui-pack-registry'), path.join(dir, 'ui-pack-registry'), { recursive: true });
  fs.mkdirSync(path.join(reg, 'ledger'), { recursive: true });
  const ls = d => (fs.existsSync(path.join(reg, d)) ? fs.readdirSync(path.join(reg, d)).filter(f => f.endsWith('.json')).sort().map(f => ({ path: `${d}/${f}`, text: read(path.join(reg, d, f)) })) : []);
  const files = Ui.packFiles({ components: ls('ui/pack/components'), templates: ls('ui/pack/templates') }, 'ui/pack/');
  if (pin) fs.writeFileSync(path.join(reg, 'ledger/designc.jsonl'), JSON.stringify({ schema_version: 1, event_id: 'pin-1', ts: 1, kind: 'ui_pinned', by: 'mike', pack: 'acme-ui', registry: 'acme-ui', hash: Ui.packHash(files, hash) }) + '\n');
  if (edit) edit(reg, path.join(dir, 'ui-pack-registry'));
  return reg;
}
const spec0 = JSON.parse(read(path.join(ROOT, 'fixtures/ui-project/ui/specs/bordereaux.json')));
const acc = states => reg => {
  wr(path.join(reg, 'model/workspace.dsl'), t => t.replace('app = softwareSystem "Bordereaux app"', 'app = softwareSystem "Bordereaux app" {\n      list = container "BordereauxList"\n    }'));
  fs.mkdirSync(path.join(reg, 'acceptance'), { recursive: true });
  fs.writeFileSync(path.join(reg, 'acceptance/AC-1.yaml'), `id: AC-1\nrequirement: R-1\nelement: BordereauxList\nstates: [${states.join(', ')}]\ncases:\n${states.map(s => `  - { state: ${s}, given: g, then: t }`).join('\n')}\n`);
};
const uiCases = {
  'pinned and current': {}, 'not pinned': { pin: false },
  'edited after the pin': { edit: reg => wr(path.join(reg, 'ui/pack/components/Button.json'), t => t + ' ') },
  'newer pack in its registry': { edit: (reg, r) => wr(path.join(r, 'ui/components/Button.json'), t => t + '\n') },
  'registry cannot be read': { edit: (reg, r) => fs.rmSync(path.join(r, 'ui'), { recursive: true }) },
  'broken spec': { edit: reg => fs.writeFileSync(path.join(reg, 'ui/specs/broken.json'), BROKEN) },
  'spec that does not parse': { edit: reg => fs.writeFileSync(path.join(reg, 'ui/specs/broken.json'), '{nope') },
  'holdout equal to the sample': { edit: reg => fs.writeFileSync(path.join(reg, 'ui/holdout/bordereaux.json'), JSON.stringify({ [Object.keys(spec0.data)[0]]: Object.values(spec0.data)[0].sample })) },
  'holdout for no spec': { edit: reg => fs.writeFileSync(path.join(reg, 'ui/holdout/ghost.json'), '{"a": 1}') },
  'no tokens file': { edit: reg => fs.rmSync(path.join(reg, 'design-tokens'), { recursive: true }) },
  'criterion in a state the spec lacks': { edit: acc(['ready', 'loading', 'empty', 'error', 'forbidden']) },
  'a transition that commits': { edit: reg => wr(path.join(reg, 'ui/specs/bordereaux.json'), t => { const s = JSON.parse(t); s.transitions[2].commits = true; return JSON.stringify(s, null, 2); }) },
};
for (const [name, opts] of Object.entries(uiCases)) {
  test(`ui registry setup, shim equals the core: ${name}`, () => {
    const reg = uiSetup(opts);
    try { equal(reg, name); } finally { fs.rmSync(path.dirname(reg), { recursive: true, force: true }); }
  });
}

// ---- the command on its own: exit codes, text, record, item, study/domain
const run = async (argv, env = {}) => {
  const out = [], errs = [], saved = {};
  for (const k of ['CI', 'TF_BUILD', 'GITLAB_CI', 'GITHUB_ACTIONS']) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  try { const code = await main(argv, { log: s => out.push(s), err: s => errs.push(s) }); return { code, out: out.join('\n'), err: errs.join('\n') }; }
  finally { for (const k of Object.keys(env)) delete process.env[k]; for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v; }
};
const CLEAN = 'workspace { model { s = softwareSystem "S" { a = container "A" } } }';
const ledgerOf = root => (fs.existsSync(path.join(root, 'ledger')) ? fs.readdirSync(path.join(root, 'ledger')).flatMap(f => read(path.join(root, 'ledger', f)).split('\n').filter(Boolean).map(JSON.parse)) : []);

test('exit 0 ready, 1 not ready, 2 cannot run; the text report is the same through the shim', async () => {
  const ok = tmpRegistry({ 'model/workspace.dsl': CLEAN });
  const r0 = await run(['check', ok, '--no-record']);
  assert.equal(r0.code, 0); assert.match(r0.out, /Ready for handover\./);
  const bad = tmpRegistry({ 'model/workspace.dsl': REPRO });
  const r1 = await run(['check', bad, '--no-record']);
  assert.equal(r1.code, 1); assert.match(r1.out, /Not ready: 4 clauses block the gate\./);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-core-empty-'));
  const r2 = await run(['check', empty, '--no-record']);
  assert.equal(r2.code, 2); assert.match(r2.err, /cannot read model\/workspace\.dsl in .*Open a registry folder/);
  assert.equal((await run(['check', path.join(empty, 'nope')])).code, 2);
  assert.equal((await run(['check', ok, '--record', '--no-record'])).code, 2);
  assert.equal((await run(['check', ok, '--source', 'x'])).code, 2);
  assert.equal((await run(['check', ok, '--bogus'])).code, 2);
});
test('text output through the shim equals the core text output on the sample registry', async () => {
  const root = path.join(ROOT, 'sample-registry');
  const r = await run(['check', root, '--no-record']);
  const p = spawnSync('python3', ['-m', 'designc', 'check', root, '--no-record'], { cwd: PY, encoding: 'utf8', env: CLEAN_ENV });
  assert.equal(r.out + '\n', p.stdout);
  assert.equal(r.code, p.status);
});
test('--registry works like the positional folder', async () => {
  const ok = tmpRegistry({ 'model/workspace.dsl': CLEAN });
  assert.equal((await run(['check', '--registry', ok, '--no-record'])).code, 0);
});
test('records a gate event once, then says unchanged; CI does not record unless asked; --no-record never does', async () => {
  const root = tmpRegistry({ 'model/workspace.dsl': CLEAN });
  const a = await run(['check', root, '--by', 'tester']);
  assert.equal(a.code, 0); assert.match(a.out, /recorded gate event in ledger\//);
  const ev = ledgerOf(root).filter(e => e.kind === 'gate');
  assert.equal(ev.length, 1); assert.equal(ev[0].by, 'tester'); assert.equal(ev[0].source, 'local'); assert.equal(ev[0].ready, true); assert.equal(ev[0].schema_version, 1);
  assert.match((await run(['check', root])).out, /gate unchanged, not recorded/);
  assert.equal(ledgerOf(root).filter(e => e.kind === 'gate').length, 1);
  const ci = await run(['check', root], { CI: 'true' });
  assert.match(ci.out, /CI detected: not recording a gate event/);
  const forced = await run(['check', root, '--record', '--source', 'pipeline'], { CI: 'true' });
  assert.match(forced.out, /recorded gate event/);
  assert.equal(ledgerOf(root).filter(e => e.kind === 'gate').length, 2);
  assert.equal(ledgerOf(root).filter(e => e.kind === 'gate')[1].source, 'pipeline');
  const other = tmpRegistry({ 'model/workspace.dsl': CLEAN });
  await run(['check', other, '--no-record']);
  assert.deepEqual(ledgerOf(other), []);
});
test('--json keeps the notes on stderr so stdout stays JSON', async () => {
  const root = tmpRegistry({ 'model/workspace.dsl': CLEAN });
  const r = await run(['check', root, '--json']);
  assert.doesNotThrow(() => JSON.parse(r.out)); assert.match(r.err, /recorded gate event/);
});
test('--item: the gate for one work item, through the shim too, records nothing', () => {
  const files = {
    'model/workspace.dsl': 'workspace { model { s = softwareSystem "S" { a = container "A" { properties { "d.instances" "1" "d.critical" "yes" } }\n b = container "B" } } }',
    'work/W-1.yaml': 'id: W-1\nrequirement: R-1\nelements: [B]\ndone_when:\n  - gate: "true"\n',
    'work/W-2.yaml': 'id: W-2\ntarget: { document: "x" }\n',
  };
  const root = tmpRegistry(files);
  const a = js(root, ['--item', 'W-1']), b = py(root, ['--item', 'W-1']);
  assert.equal(a.stdout, b.stdout); assert.equal(a.status, b.status);
  assert.ok('outside' in JSON.parse(a.stdout));
  const bad = js(root, ['--item', 'W-2']), badPy = py(root, ['--item', 'W-2']);
  assert.equal(bad.status, 2); assert.equal(bad.stderr, badPy.stderr);
  assert.deepEqual(ledgerOf(root), []);
});
test('a study registry is nothing to check; a domain registry is checked and exits 0 or 1', async () => {
  const study = tmpRegistry({ 'designc.json': '{"kind":"study"}' });
  const s = await run(['check', study]);
  assert.equal(s.code, 0); assert.match(s.out, /study registry: nothing to check/);
  const good = path.join(ROOT, 'fixtures/domain-registry');
  const g = js(good), gp = py(good);
  assert.equal(g.stdout, gp.stdout); assert.equal(g.status, 0); assert.equal(gp.status, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-core-domreg-'));
  fs.cpSync(good, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'domain/fares.yaml'), PACK.replace('    id: PartnerId\n', ''));
  const b = js(dir), bp = py(dir);
  assert.equal(b.status, 1); assert.equal(b.stdout, bp.stdout); assert.equal(b.status, bp.status);
  const t = await run(['check', dir]);
  assert.match(t.out, /aggregate Partner needs an id/);
});

// ---- could not run: no Node, or no script, is exit 2 and never a pass
const PYBIN = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim();
test('the shim without Node on PATH reports could not run (exit 2), not a pass', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-nonode-'));
  const r = spawnSync(PYBIN, ['-m', 'designc', 'check', path.join(ROOT, 'sample-registry'), '--json', '--no-record'], { cwd: PY, encoding: 'utf8', env: { PATH: empty } });
  assert.equal(r.status, 2); assert.equal(r.stdout, ''); assert.match(r.stderr, /could not run: Node is not installed/);
});
test('the shim with DESIGNC_NODE pointing nowhere reports could not run (exit 2)', () => {
  const r = spawnSync(PYBIN, ['-m', 'designc', 'check', path.join(ROOT, 'sample-registry'), '--no-record'], { cwd: PY, encoding: 'utf8', env: { ...CLEAN_ENV, DESIGNC_NODE: '/nonexistent/node' } });
  assert.equal(r.status, 2); assert.match(r.stderr, /could not run/);
});

// ---- the agent fixtures through the shim
test('R1 repro and fixtures/agent-registry through the shim: exit 1, the AG findings', () => {
  const repro = py(tmpRegistry({ 'model/workspace.dsl': REPRO }));
  assert.equal(repro.status, 1);
  assert.deepEqual(JSON.parse(repro.stdout).gate.clauses.map(c => c.text), ['AG001', 'AG003', 'AG005', 'AG011'].map(c => `${c} on Triage agent is neither fixed nor accepted`));
  const reg = py(path.join(ROOT, 'fixtures/agent-registry'));
  assert.equal(reg.status, 1);
  assert.deepEqual([...new Set(JSON.parse(reg.stdout).findings.map(f => f.code))], ['AG011']);
});

// B2: the scenario-registry fixture's popover is a hosted spec of its own (ui/specs/orders-tag.json).
test('scenario-registry: the hosted popover spec gets no clause (no UI element in the model names it, so no approval clause either), and the orders clause set is unchanged', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/designc-core.js'), 'check', path.join(ROOT, 'fixtures/scenario-registry'), '--json', '--no-record'], { encoding: 'utf8', env: CLEAN_ENV });
  const ui = JSON.parse(r.stdout).gate.clauses.filter(c => c.kind === 'ui').map(c => c.text);
  assert.ok(!ui.some(t => /orders-tag/.test(t)), ui.join('\n'));
  assert.deepStrictEqual(ui, [
    'ui/pack/ is not pinned: pin it from its kind: ui registry',
    'ui/specs/orders.json: spec not bound. Check the previews, then press Approve and bind',
  ]);
});
