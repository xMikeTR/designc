// A1 slice 2: renderer/gate-inputs.js assembles the gate's inputs from a path -> text map, with no fs.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');
const GateInputs = require('../renderer/gate-inputs.js');

const MODEL = 'workspace { model { s = softwareSystem "S" { a = container "A" } } }';
const base = (extra = {}, cfg = {}) => GateInputs.assemble({ cfg, files: { 'model/workspace.dsl': MODEL, ...extra } });

test('defaults, check options and an empty registry', () => {
  const a = base();
  assert.deepEqual(a.checkOptions, { chainHops: 4, retryAmplification: 4, repos: undefined });
  const g = a.gateInputs;
  assert.equal(g.minTextSize, Core.DEFAULT_MIN_TEXT);
  assert.deepEqual([g.decisions, g.requirements, g.scenarios, g.evals, g.acceptance, g.apiContracts, g.contractGaps, g.registryErrors], [[], [], [], [], [], [], [], []]);
  assert.equal(g.tokens, null); assert.equal(g.domains, null); assert.equal(g.ui, null);
  assert.equal(a.modelText, MODEL);
});

test('a missing model is reported as null text, not thrown', () => {
  const a = GateInputs.assemble({ files: {} });
  assert.equal(a.modelText, null);
});

test('records load the way loadYamlDir does: id from the file name, lists wrapped, status and effect defaulted, errors named', () => {
  const a = base({
    'decisions/DEC-b.yaml': 'binds: A\nstatus: bound\n',
    'decisions/DEC-a.yaml': 'id: DEC-a\nbinds: [A]\n',
    'decisions/bad.yaml': 'a: [unclosed\n',
    'requirements/R1.yaml': 'title: x\nelements: A\n',
    'handovers/h1/handover.yaml': ': : :\n',
  });
  const g = a.gateInputs;
  assert.deepEqual(g.decisions.map(d => [d.id, d.binds, d.status, d.effect]), [['DEC-a', ['A'], 'minted', 'fix'], ['DEC-b', ['A'], 'bound', 'fix']]);
  assert.deepEqual(g.requirements[0].elements, ['A']);
  assert.deepEqual(g.registryErrors.map(e => e.path).sort(), ['decisions/bad.yaml', 'handovers/h1/handover.yaml']);
});

test('run: the gate follows the records, and an empty model is not checked', () => {
  const r = GateInputs.run(base({ 'decisions/D.yaml': 'binds: A\n' }));
  assert.equal(r.gate.ready, false);
  assert.ok(r.gate.clauses.some(c => /D is minted, not bound/.test(c.text)));
  const empty = GateInputs.run(GateInputs.assemble({ files: { 'model/workspace.dsl': '' } }));
  assert.deepEqual(empty.diags, []);
});

test('contract gaps need contracts.require, as the app has it', () => {
  const agent = 'workspace { model { s = softwareSystem "S" { a = container "A" "" "MAF" "Agent" { properties { "d.agent.autonomy" "approve-writes" } } } } }';
  const off = GateInputs.assemble({ cfg: { contracts: { command: 'x' } }, files: { 'model/workspace.dsl': agent } });
  assert.deepEqual(off.gateInputs.contractGaps, []);
  const on = GateInputs.assemble({ cfg: { contracts: { command: 'x', require: true } }, files: { 'model/workspace.dsl': agent } });
  assert.match(on.gateInputs.contractGaps[0].text, /A has no compiled contract/);
});

test('domains: packs and the pinned source from a sibling registry; ui is null with nothing in ui/', () => {
  const pin = JSON.stringify({ kind: 'domain_pinned', by: 'me', schema_version: 1, event_id: 'p1', ts: 1, pack: 'orders', registry: 'shared', hash: 'abc' });
  const a = GateInputs.assemble({
    cfg: { model: 'model/workspace.dsl', domains: ['orders'] },
    files: { 'model/workspace.dsl': MODEL, 'domain/orders.yaml': 'id: orders\n', 'ledger/checks.jsonl': pin + '\n', 'behaviour/x.p': 'p' },
    registries: { shared: { 'domain/orders.yaml': 'id: orders\n' } },
  });
  const d = a.gateInputs.domains;
  assert.deepEqual([d.listed, d.packs.map(p => p.key), d.sources, d.behaviour.map(b => b.path)], [['orders'], ['orders'], { orders: 'id: orders\n' }, ['behaviour/x.p']]);
  assert.equal(a.gateInputs.ui, null);
});

test('ui: legacy alone is enough to turn the UI checks on; hashes come from the loader', () => {
  const a = GateInputs.assemble({
    files: { 'model/workspace.dsl': MODEL, 'ui/specs/home.json': '{}', 'ui/legacy/x.json': '{}', 'parity/scenarios/s.yaml': 'id: s\n' },
    hashes: { previews: { home: { 'a.png': 'h' } }, specHashes: { home: 'sh' } },
  });
  const u = a.gateInputs.ui;
  assert.deepEqual([u.previews, u.specHashes, u.scenarios.length, u.legacy.length], [{ home: { 'a.png': 'h' } }, { home: 'sh' }, 1, 1]);
});
