// One verified property, end to end: a randomised idempotency check on `relativise` (applying it twice equals once)
// records `check` evidence for an element; the status model reads it as verified, and as declared once a file
// under the element's paths changes after the checked commit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { relativise } = require('../audit/audit.js');
const Status = require('../renderer/health-status.js');

const AUDIT = path.join(__dirname, '..', 'audit', 'audit.js');
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });

// deterministic generator, so a failure reproduces
function rng(seed) { return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
function randomSarif(r, root) {
  const pick = a => a[Math.floor(r() * a.length)];
  const results = Array.from({ length: Math.floor(r() * 12) }, () => ({
    ruleId: pick(['CA1', 'S1', 'x/y']),
    message: { text: pick(['m', 'n', '{"message":"j"}']) },
    locations: [{ physicalLocation: { artifactLocation: { uri: pick([`${root}/a.cs`, 'file://' + root + '/b.cs', 'c.cs']) }, region: { startLine: Math.floor(r() * 3) + 1 } } }],
  }));
  return { runs: [{ results }] };
}

test('relativise is idempotent (randomised), and the evidence moves the status verified -> declared on edit', () => {
  const root = '/r';
  const r = rng(42);
  for (let i = 0; i < 200; i++) {
    const s = randomSarif(r, root);
    const once = relativise(JSON.parse(JSON.stringify(s)), root);
    const twice = relativise(JSON.parse(JSON.stringify(once)), root);
    assert.deepEqual(twice, once, `case ${i}`);
  }

  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-prop-'));
  try {
    fs.mkdirSync(path.join(d, 'src'));
    fs.writeFileSync(path.join(d, 'src/handler.js'), 'exports.h = () => 1;\n');
    git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't');
    git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base');
    const out = path.join(d, 'out');
    const rec = spawnSync('node', [AUDIT, 'record', '--out', out, '--element', 'c.handler', '--property', 'idempotent', '--by', 'test/audit-property.test.js', '--result', 'pass', '--repo', d], { encoding: 'utf8' });
    assert.equal(rec.status, 0, rec.stderr);
    const ev = JSON.parse(fs.readFileSync(path.join(out, 'evidence.json'), 'utf8'))['c.handler'].idempotent;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].commit, git(d, 'rev-parse', 'HEAD').stdout.trim());

    // the same check re-run replaces its entry rather than piling up
    spawnSync('node', [AUDIT, 'record', '--out', out, '--element', 'c.handler', '--property', 'idempotent', '--by', 'test/audit-property.test.js', '--result', 'pass', '--repo', d]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'evidence.json'), 'utf8'))['c.handler'].idempotent.length, 1);

    // the status model, with changedSince answered by git for the element's paths
    const changedSince = c => git(d, 'diff', '--name-only', c, '--', 'src').stdout.trim() !== '';
    const compute = () => Status.compute({ claim: true, evidence: ev, changedSince });
    assert.equal(compute(), 'verified');
    fs.writeFileSync(path.join(d, 'src/handler.js'), 'exports.h = () => 2;\n');
    git(d, 'commit', '-qam', 'edit');
    assert.equal(compute(), 'declared', 'an edit under the element invalidates the check');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
