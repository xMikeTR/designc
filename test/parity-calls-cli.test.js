'use strict';
// --har with per-step request counts, over the fixture adapter (N4 / S9).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CLI = require('../scripts/parity-record.js');

const SRC = path.join(__dirname, '..', 'fixtures', 'parity-registry');
const APPS = path.join(SRC, 'apps');
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-calls-'));
  fs.cpSync(SRC, dir, { recursive: true });
  for (const d of ['ledger', 'parity/baselines', 'parity/reports']) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
  // one scenario with two steps, the second makes the calls
  fs.rmSync(path.join(dir, 'parity/scenarios/tags-apply.yaml'));
  return dir;
}
async function run(args) {
  const out = [];
  const err = [];
  const code = await CLI.main(args, { log: s => out.push(s), err: s => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
function fixture(reg, name, requests) {
  const fx = JSON.parse(fs.readFileSync(path.join(APPS, `${name === 'legacy' ? 'legacy' : 'legacy'}.json`), 'utf8'));
  fx.requests = requests;
  const f = path.join(reg, `${name}-calls.json`);
  fs.writeFileSync(f, JSON.stringify(fx));
  return f;
}
const rec = (reg, side, file, extra = []) => run(['--registry', reg, '--scenario', 'tags-list', '--side', side, '--adapter', `fixture:${file}`, '--no-shots', '--base-url', 'http://app.test', '--json', ...extra]);
const items = n => Array.from({ length: n }, (_, i) => ({ method: 'GET', path: `/api/items/${i + 1}`, step: 1, response: { id: i + 1 } }));
const reportOf = reg => JSON.parse(fs.readFileSync(path.join(reg, 'parity/reports/tags-list.json'), 'utf8'));

test('--har legacy one call against next three: kind calls in the report and the parity_result failure, exit 1', async () => {
  const reg = scratch();
  const L = fixture(reg, 'legacy', [{ method: 'GET', path: '/api/items/9', step: 1 }]);
  const N = fixture(reg, 'next', items(3));
  assert.strictEqual((await rec(reg, 'legacy', L, ['--har'])).code, 0);
  const base = JSON.parse(fs.readFileSync(path.join(reg, 'parity/baselines/tags-list/legacy.json'), 'utf8'));
  assert.deepStrictEqual(base.steps[0].calls, [{ method: 'GET', path: '/api/items/:id', count: 1 }]);
  const r = await rec(reg, 'next', N, ['--har', '--ledger', '--commit', 'a'.repeat(40), '--by', 't']);
  assert.strictEqual(r.code, 1, r.out + r.err);
  const res = JSON.parse(r.out)[0];
  assert.deepStrictEqual(res.failures.map(f => [f.step, f.kind, f.key]), [[1, 'calls', 'calls:GET /api/items/:id']]);
  const rep = reportOf(reg);
  const f = rep.result.steps[0].findings.find(x => x.kind === 'calls');
  assert.strictEqual(f.severity, 'fail');
  assert.match(f.msg, /3 or more times in this step; legacy calls it once/);
  assert.deepStrictEqual(rep.next.steps[0].calls, [{ method: 'GET', path: '/api/items/:id', count: 3 }]);
  const ev = fs.readFileSync(path.join(reg, 'ledger/pipeline.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).pop();
  assert.strictEqual(ev.failures[0].kind, 'calls');
  // no values: the request's id never reaches the report
  assert.ok(!JSON.stringify(rep.next).includes('/api/items/1"'));
});

test('the same run without --har has no calls key anywhere and exits 0', async () => {
  const reg = scratch();
  const L = fixture(reg, 'legacy', [{ method: 'GET', path: '/api/items/9', step: 1 }]);
  const N = fixture(reg, 'next', items(3));
  await rec(reg, 'legacy', L);
  const r = await rec(reg, 'next', N);
  assert.strictEqual(r.code, 0, r.out + r.err);
  const files = [path.join(reg, 'parity/baselines/tags-list/legacy.json'), path.join(reg, 'parity/reports/tags-list.json')];
  for (const f of files) assert.ok(!/calls/.test(fs.readFileSync(f, 'utf8')), f);
});

test('a baseline recorded without --har against next with --har gives no calls finding', async () => {
  const reg = scratch();
  const L = fixture(reg, 'legacy', [{ method: 'GET', path: '/api/items/9', step: 1 }]);
  const N = fixture(reg, 'next', items(3));
  await rec(reg, 'legacy', L);
  const r = await rec(reg, 'next', N, ['--har']);
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.ok(!reportOf(reg).result.steps.some(s => s.findings.some(f => f.kind === 'calls')));
  assert.ok(reportOf(reg).next.steps[0].calls, 'the next side did record counts');
});

test('a fixture request without step is undated: counts are unknown, so no calls key and no finding', async () => {
  const reg = scratch();
  const L = fixture(reg, 'legacy', [{ method: 'GET', path: '/api/items/9' }]);
  const N = fixture(reg, 'next', [{ method: 'GET', path: '/api/items/1' }, { method: 'GET', path: '/api/items/2' }, { method: 'GET', path: '/api/items/3' }]);
  await rec(reg, 'legacy', L, ['--har']);
  assert.ok(!('calls' in JSON.parse(fs.readFileSync(path.join(reg, 'parity/baselines/tags-list/legacy.json'), 'utf8')).steps[0]));
  assert.strictEqual((await rec(reg, 'next', N, ['--har'])).code, 0);
});
