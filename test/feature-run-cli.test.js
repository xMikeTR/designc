'use strict';
// scripts/feature-run.js over the fixture adapter, on a scratch copy of test/fixtures/feature-run/registry.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CLI = require('../scripts/feature-run.js');

const FX = path.join(__dirname, 'fixtures', 'feature-run');
const APP = path.join(FX, 'app.json');
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-run-'));
  fs.cpSync(path.join(FX, 'registry'), path.join(dir, 'registry'), { recursive: true });
  return { dir, reg: path.join(dir, 'registry') };
}
function appFile(dir, edit) {
  const a = JSON.parse(fs.readFileSync(APP, 'utf8'));
  if (edit) edit(a);
  const f = path.join(dir, 'app.json');
  fs.writeFileSync(f, JSON.stringify(a));
  return f;
}
async function run(args) {
  const out = [], err = [];
  const code = await CLI.main(args, { log: s => out.push(s), err: s => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const go = (reg, app, extra = []) => run(['--registry', reg, '--feature', 'all', '--adapter', `fixture:${app}`, ...extra]);
const listing = d => fs.readdirSync(d, { recursive: true }).sort();

test('exit 0 on pass, --json shape is the feature_result row without kind, commit, by', async () => {
  const { dir, reg } = scratch();
  const r = await go(reg, appFile(dir), ['--json']);
  assert.strictEqual(r.code, 0, r.err);
  const rows = JSON.parse(r.out);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(Object.keys(rows[0]), ['feature', 'outcome', 'journeys']);
  assert.deepStrictEqual(Object.keys(rows[0].journeys[0]), ['journey', 'entry', 'outcome', 'failures']);
  assert.strictEqual(rows[0].outcome, 'pass');
});

test('exit 1 when a journey fails; exit 3 when it could not run; text output names the failure', async () => {
  const { dir, reg } = scratch();
  const fail = await go(reg, appFile(dir, a => { a.on = a.on.filter(o => !o.press); }));
  assert.strictEqual(fail.code, 1);
  assert.match(fail.out, /orders-export/);
  assert.match(fail.out, /fail/);
  const cnr = await go(reg, appFile(dir, a => { a.api['GET /health'] = 500; }));
  assert.strictEqual(cnr.code, 3);
  assert.match(cnr.out, /ready/);
});

test('exit 2: FM003 problem, unknown feature, unknown journey, bad args, unparseable file', async () => {
  const { dir, reg } = scratch();
  const app = appFile(dir);
  const f = path.join(reg, 'features', 'orders-export.yaml');
  const good = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, good.replace('steps:\n      - entry', 'steps:\n      - entry\n      - entry'));
  const bad = await go(reg, app);
  assert.strictEqual(bad.code, 2);
  assert.match(bad.err, /FM003/);
  fs.writeFileSync(f, good);
  assert.strictEqual((await run(['--registry', reg, '--feature', 'nope', '--adapter', `fixture:${app}`])).code, 2);
  assert.strictEqual((await go(reg, app, ['--journey', 'nope'])).code, 2);
  assert.strictEqual((await run(['--registry', reg])).code, 2);
  fs.writeFileSync(f, 'id: [unclosed');
  assert.strictEqual((await go(reg, app)).code, 2);
});

test('--out writes capture json and png per run, outside the registry; nothing is written without it', async () => {
  const { dir, reg } = scratch();
  const app = appFile(dir);
  const before = listing(reg);
  assert.strictEqual((await go(reg, app)).code, 0);
  assert.deepStrictEqual(listing(reg), before);
  const out = path.join(dir, 'evidence');
  assert.strictEqual((await go(reg, app, ['--out', out])).code, 0);
  assert.deepStrictEqual(listing(out), ['orders-export', 'orders-export/export-all--header-button.json', 'orders-export/export-all--header-button.png', 'orders-export/export-all--shortcut.json', 'orders-export/export-all--shortcut.png']);
  assert.deepStrictEqual(listing(reg), before);
  assert.ok(JSON.parse(fs.readFileSync(path.join(out, 'orders-export', 'export-all--shortcut.json'), 'utf8')).tree);
  assert.strictEqual((await go(reg, app, ['--out', path.join(reg, 'evidence')])).code, 2);
  assert.deepStrictEqual(listing(reg), before);
});

test('--feature by id and --journey filter', async () => {
  const { dir, reg } = scratch();
  const r = await run(['--registry', reg, '--feature', 'orders-export', '--journey', 'export-all', '--adapter', `fixture:${appFile(dir)}`, '--json']);
  assert.strictEqual(r.code, 0, r.err);
});
