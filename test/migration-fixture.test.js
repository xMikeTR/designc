// The migration fixture (fixtures/migration): the registry is sound, the target is red on its base commit,
// and green once the reference solution is laid over it. See fixtures/migration/EXPECTED.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const Core = require('../renderer/core.js');
const Work = require('../renderer/work.js');
const Dispatch = require('../renderer/dispatch.js');

const root = path.join(__dirname, '..', 'fixtures', 'migration');
const reg = path.join(root, 'registry');
const dir = d => fs.readdirSync(path.join(reg, d)).map(f => yaml.load(fs.readFileSync(path.join(reg, d, f), 'utf8')));

test('the registry parses, lints clean and its work items are valid', () => {
  const m = Core.parse(fs.readFileSync(path.join(reg, 'model/workspace.dsl'), 'utf8'));
  assert.equal(m.errors.length, 0);
  assert.deepEqual(Core.check(m, {}).filter(d => !d.suppressed && d.sev === 'error'), []);
  const reqs = dir('requirements'), items = dir('work');
  assert.equal(items.length, 4);
  for (const i of items) assert.deepEqual(Work.validate(i, { requirements: reqs, items: items.map(x => x.id) }), [], i.id);
});

test('the legacy is named as a read-only reference and the code areas are declared', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(reg, 'designc.json'), 'utf8'));
  const r = Dispatch.references(cfg.references);
  assert.deepEqual(r.refs.map(x => [x.key, x.kind]), [['wpf', 'legacy']]);
  assert.ok(fs.existsSync(path.join(reg, cfg.references.wpf.path, 'QuoteCalculator/PremiumCalculator.cs')));
  assert.ok(JSON.stringify(Core.handoverElements(fs.readFileSync(path.join(reg, 'model/workspace.dsl'), 'utf8'), [])).includes('src/pricing/**'));
});

// The outer test runner sets NODE_TEST_CONTEXT, which would make a nested `node --test` report success.
const env = (({ NODE_TEST_CONTEXT, ...rest }) => rest)(process.env);
const npm = (cwd, ...args) => spawnSync('npm', ['-s', ...args], { cwd, encoding: 'utf8', env });
const run = (cwd, ...args) => npm(cwd, 'run', ...args);
function copyTarget(withSolution) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-'));
  fs.cpSync(path.join(root, 'target'), tmp, { recursive: true });
  if (withSolution) fs.cpSync(path.join(root, '.reference-solution'), tmp, { recursive: true });
  return tmp;
}

test('the target is red on its base commit', () => {
  const tmp = copyTarget(false);
  const r = npm(tmp, 'test');
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /# fail 8/);
  assert.equal(run(tmp, 'check:scope').status, 0);
});

test('with the reference solution the tests, money and scope gates are green', () => {
  const tmp = copyTarget(true);
  const r = npm(tmp, 'test');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(run(tmp, 'check:money').status, 0);
  assert.equal(run(tmp, 'check:scope').status, 0);
});

test('the natural floating point reinstatement fails the money gate with the way out', () => {
  const tmp = copyTarget(true);
  fs.writeFileSync(path.join(tmp, 'src/pricing/reinstatement.js'), 'exports.reinstatementPremium = (p, d) => Math.round(p * d / 365);\n');
  const r = run(tmp, 'check:money');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /divRoundHalfEven/);
});

test('touching the shared file fails the scope gate', () => {
  const tmp = copyTarget(true);
  fs.appendFileSync(path.join(tmp, 'src/shared/format.js'), '// fixed\n');
  assert.equal(run(tmp, 'check:scope').status, 1);
});

test('the limit tests do not pin the maximum, so either answer passes', () => {
  const tmp = copyTarget(true);
  fs.writeFileSync(path.join(tmp, 'src/validation/limit.js'), fs.readFileSync(path.join(tmp, 'src/validation/limit.js'), 'utf8').replace(/250/g, '500'));
  const r = npm(tmp, 'test');
  assert.equal(r.status, 0, r.stdout);
});
