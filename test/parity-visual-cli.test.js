'use strict';
// Parity tier 2 through the recorder CLI (fixture adapter, whose screenshots are one-colour PNGs of the screen's content),
// plus the scenario fields it adds: mask (selectors painted over in both apps' shots) and threshold.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CLI = require('../scripts/parity-record.js');
const Parity = require('../renderer/parity.js');
const Recorder = require('../recorder/index.js');

const SRC = path.join(__dirname, '..', 'fixtures', 'parity-registry');
const APPS = path.join(SRC, 'apps');
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-visual-'));
  fs.cpSync(SRC, dir, { recursive: true });
  for (const d of ['ledger', 'parity/baselines', 'parity/reports', 'parity/shots']) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
  return dir;
}
async function run(args) {
  const out = [], err = [];
  const code = await CLI.main(args, { log: s => out.push(s), err: s => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const side = (reg, s, extra = []) => run(['--registry', reg, '--scenario', 'all', '--side', s, '--adapter', `fixture:${path.join(APPS, `${s}.json`)}`, ...extra]);

test('next compares legacy and new screenshots: the same app on both sides passes, a different one fails, and the row carries it', async () => {
  // legacy.json on both sides: identical screens, so identical pixels
  const same = scratch();
  await side(same, 'legacy');
  const ok = await run(['--registry', same, '--scenario', 'all', '--side', 'next', '--adapter', `fixture:${path.join(APPS, 'legacy.json')}`, '--json']);
  for (const r of JSON.parse(ok.out)) assert.deepStrictEqual([r.visual.outcome, r.visual.ratio], ['pass', 0], r.scenario);

  // the new app's own screens differ (in data as well as shape, and pixels see data): tier 1 ignores values, tier 2 does not
  const reg = scratch();
  await side(reg, 'legacy');
  const next = await side(reg, 'next', ['--ledger', '--commit', 'a'.repeat(40), '--by', 'tester', '--json']);
  const byId = Object.fromEntries(JSON.parse(next.out).map(r => [r.scenario, r]));
  assert.strictEqual(byId['tags-list'].visual.outcome, 'fail');
  assert.strictEqual(byId['tags-list'].visual.threshold, 0.001);

  const rows = fs.readFileSync(path.join(reg, 'ledger/pipeline.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.kind === 'parity_result');
  const list = rows.find(r => r.scenario === 'tags-list');
  assert.deepStrictEqual(Object.keys(list.visual).sort(), ['outcome', 'ratio', 'threshold']);
  assert.strictEqual(list.visual.outcome, 'fail');
});

test('tier 1 stays the outcome: a visual fail does not change parity_result.outcome', async () => {
  const reg = scratch();
  await side(reg, 'legacy');
  const next = await side(reg, 'next', ['--json']);
  const r = JSON.parse(next.out).find(x => x.scenario === 'tags-apply');
  assert.strictEqual(r.outcome, 'pass');
});

test('with no screenshots the visual tier is skipped, never passed', async () => {
  const reg = scratch();
  await side(reg, 'legacy', ['--no-shots']);
  const next = await side(reg, 'next', ['--no-shots', '--json']);
  for (const r of JSON.parse(next.out)) assert.strictEqual(r.visual.outcome, 'skipped');
});

test('a shot missing on this machine is skipped for that step, not passed', async () => {
  const reg = scratch();
  await side(reg, 'legacy');
  for (const f of fs.readdirSync(path.join(reg, 'parity/shots'))) if (f.endsWith('.png')) fs.rmSync(path.join(reg, 'parity/shots', f));
  const next = await side(reg, 'next', ['--no-shots', '--json']);
  assert.strictEqual(JSON.parse(next.out).find(x => x.scenario === 'tags-apply').visual.outcome, 'skipped');
});

test('a scenario sets its own threshold, validated with the rest of the scenario', () => {
  const ok = { id: 's', steps: [{ goto: { path: '/' } }], threshold: 0.05, mask: ['.clock', '#user'] };
  assert.deepStrictEqual(Parity.scenarioProblems(ok), []);
  assert.match(Parity.scenarioProblems({ ...ok, threshold: 2 }).join(), /threshold/);
  assert.match(Parity.scenarioProblems({ ...ok, threshold: 'x' }).join(), /threshold/);
  assert.match(Parity.scenarioProblems({ ...ok, mask: '.clock' }).join(), /mask/);
  assert.match(Parity.scenarioProblems({ ...ok, mask: [''] }).join(), /mask/);
});

test('the recorder hands the scenario mask selectors to the adapter with each screenshot', async () => {
  const seen = [];
  const session = {
    act: async () => ({ ok: true }), capture: async () => ({ tree: [], viewport: { width: 1, height: 1 } }),
    screenshot: async opts => { seen.push(opts); return null; }, close: async () => {},
  };
  const adapter = { name: 'stub', open: async () => session };
  await Recorder.record({ scenario: { id: 's', steps: [{ goto: { path: '/' } }], mask: ['.clock'] }, side: 'legacy', adapter, params: {}, screenshots: true });
  assert.deepStrictEqual(seen, [{ mask: ['.clock'] }]);
});

test('parity_result accepts an additive visual object and rejects anything else', () => {
  const Ledger = require('../renderer/ledger.js');
  const row = { kind: 'parity_result', by: 'p', scenario: 's', commit: null, outcome: 'pass', failures: [] };
  assert.deepStrictEqual(Ledger.validate(row), []);
  assert.deepStrictEqual(Ledger.validate({ ...row, visual: { ratio: 0, threshold: 0.001, outcome: 'pass' } }), []);
  assert.ok(Ledger.validate({ ...row, visual: 'pass' }).some(e => /visual/.test(e)));
});
