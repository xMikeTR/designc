'use strict';
// scripts/parity-record.js over the fixture adapter, on a scratch copy of fixtures/parity-registry.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CLI = require('../scripts/parity-record.js');
const Ledger = require('../renderer/ledger.js');

const SRC = path.join(__dirname, '..', 'fixtures', 'parity-registry');
const APPS = path.join(SRC, 'apps');
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-cli-'));
  fs.cpSync(SRC, dir, { recursive: true });
  for (const d of ['ledger', 'parity/baselines', 'parity/reports']) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
  return dir;
}
async function run(args) {
  const out = [];
  const err = [];
  const code = await CLI.main(args, { log: s => out.push(s), err: s => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const side = (reg, s, extra = []) => run(['--registry', reg, '--scenario', 'all', '--side', s, '--adapter', `fixture:${path.join(APPS, `${s}.json`)}`, ...extra]);

test('legacy writes a baseline with no page data; next compares, reports and records through the ledger', async () => {
  const reg = scratch();
  const legacy = await side(reg, 'legacy');
  assert.strictEqual(legacy.code, 0, legacy.err);
  const base = fs.readFileSync(path.join(reg, 'parity/baselines/tags-list/legacy.json'), 'utf8');
  assert.ok(!base.includes('Mock Program') && !base.includes('15/01/2026'), 'no data in a baseline');
  const shots = fs.readdirSync(path.join(reg, 'parity/shots'));
  assert.ok(shots.includes('.gitignore') && shots.some(f => /^[0-9a-f]{64}\.png$/.test(f)));

  const next = await side(reg, 'next', ['--ledger', '--commit', 'a'.repeat(40), '--item', 'W-1', '--by', 'tester', '--json']);
  assert.strictEqual(next.code, 1, 'a failing scenario exits 1');
  const results = JSON.parse(next.out);
  assert.deepStrictEqual(results.map(r => [r.scenario, r.outcome, r.ledger]), [['tags-apply', 'pass', 'recorded'], ['tags-list', 'fail', 'recorded']]);
  const lines = fs.readFileSync(path.join(reg, 'ledger/pipeline.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(lines.map(l => [l.kind, l.scenario, l.outcome, l.item, l.by]), [['parity_result', 'tags-apply', 'pass', 'W-1', 'tester'], ['parity_result', 'tags-list', 'fail', 'W-1', 'tester']]);
  for (const l of lines) assert.deepStrictEqual(Ledger.validate(l), []);
  assert.strictEqual(lines[1].failures[0].kind, 'shape');
  assert.ok(fs.existsSync(path.join(reg, lines[1].report)));
});

test('next with no baseline is an error, and nothing is recorded', async () => {
  const reg = scratch();
  const r = await side(reg, 'next', ['--ledger', '--scenario', 'tags-list']);
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /no baseline for tags-list: record legacy first/);
  assert.ok(!fs.existsSync(path.join(reg, 'ledger')));
});

test('a requirement covers a difference: an acceptance locator for an added button', async () => {
  const reg = scratch();
  const next = JSON.parse(fs.readFileSync(path.join(APPS, 'next.json'), 'utf8'));
  next.screens.list.children[0].children.push({ role: 'button', name: 'Share', box: null, children: [] });
  const app = path.join(reg, 'next-share.json');
  fs.writeFileSync(app, JSON.stringify(next));
  await side(reg, 'legacy', ['--no-shots']);
  const one = () => run(['--registry', reg, '--scenario', 'tags-apply', '--side', 'next', '--adapter', `fixture:${app}`, '--no-shots', '--json']);
  assert.strictEqual(JSON.parse((await one()).out)[0].outcome, 'fail');
  fs.mkdirSync(path.join(reg, 'acceptance'));
  fs.writeFileSync(path.join(reg, 'acceptance/share.yaml'), 'id: AC-share\nlocators:\n  share: { role: button, name: Share }\n');
  const covered = JSON.parse((await one()).out)[0];
  assert.deepStrictEqual([covered.outcome, covered.counts.covered], ['pass', 2], 'Share shows on both list steps');
});

test('arguments: required flags, ledger only for next, unknown scenario, malformed scenario file', async () => {
  assert.throws(() => CLI.parseArgs(['--registry', 'x', '--side', 'next']), /--scenario is required/);
  assert.throws(() => CLI.parseArgs(['--registry', 'x', '--scenario', 'a', '--side', 'legacy', '--ledger']), /needs --side next/);
  assert.throws(() => CLI.parseArgs(['--registry', 'x', '--scenario', 'a', '--side', 'next', '--param', 'novalue']), /name=value/);
  const reg = scratch();
  assert.match((await run(['--registry', reg, '--scenario', 'nope', '--side', 'legacy', '--adapter', 'fixture:x'])).err, /no scenario nope/);
  fs.writeFileSync(path.join(reg, 'parity/scenarios/broken.yaml'), 'title: no id\nsteps: []\n');
  const r = await side(reg, 'legacy', ['--no-shots', '--json']);
  assert.strictEqual(r.code, 2);
  assert.match(JSON.parse(r.out).find(x => x.error).error, /broken\.yaml: the scenario needs an id/);
});

test('exit code: the worst outcome wins', () => {
  assert.strictEqual(CLI.exitCode([{ outcome: 'pass' }, { outcome: 'could_not_run' }]), 3);
  assert.strictEqual(CLI.exitCode([{ outcome: 'could_not_run' }, { outcome: 'fail' }]), 1);
  assert.strictEqual(CLI.exitCode([{ outcome: 'fail' }, { error: 'x' }]), 2);
  assert.strictEqual(CLI.exitCode([{ recorded: 'a' }]), 0);
});
