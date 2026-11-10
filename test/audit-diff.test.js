// `audit diff` end to end on a tiny repo: a deliberate smell on a branch exits 1 and is named; a clean copy exits 0.
// Needs the analyzers (audit/tools, installed once into the cache dir by the first run, which needs the network).
// Without them it skips, and says so: the selfcheck container has no network, so there it skips.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOLS = process.env.DESIGNC_AUDIT_TOOLS || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'designc-audit', 'tools');
const ready = fs.existsSync(path.join(TOOLS, '.installed'));
const AUDIT = path.join(__dirname, '..', 'audit', 'audit.js');

const sh = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const SMELL = `function tangle(a, b, c) {
  let n = 0;
  for (let i = 0; i < a; i++) {
    if (i % 2) {
      for (let j = 0; j < b; j++) {
        if (j % 3) {
          if (c) { while (n < 10) { if (n % 2) { n += 2; } else { n++; } } }
          else { for (const k of [1, 2]) { if (k) { if (n) { n--; } } } }
        }
      }
    }
  }
  return n;
}
module.exports = { tangle };
`;

test('audit diff: a new smell exits 1 and names it; no change exits 0; the repo is not written to', { skip: ready ? false : `analyzers not installed in ${TOOLS}` }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-diff-'));
  try {
    fs.mkdirSync(path.join(d, 'src'));
    fs.writeFileSync(path.join(d, 'package.json'), '{"name":"small","main":"src/index.js"}');
    fs.writeFileSync(path.join(d, 'src/index.js'), "const { add } = require('./util');\nconsole.log(add(1, 2));\n");
    fs.writeFileSync(path.join(d, 'src/util.js'), 'exports.add = (a, b) => a + b;\n');
    sh(d, 'init', '-q', '-b', 'main'); sh(d, 'config', 'user.email', 't@t'); sh(d, 'config', 'user.name', 't');
    sh(d, 'add', '-A'); sh(d, 'commit', '-qm', 'base');
    const run = () => spawnSync('node', [AUDIT, 'diff', d, '--base', 'main'], { encoding: 'utf8', env: { ...process.env, DESIGNC_AUDIT_TOOLS: TOOLS } });

    const clean = run();
    assert.equal(clean.status, 0, clean.stderr);

    sh(d, 'checkout', '-q', '-b', 'smell');
    fs.writeFileSync(path.join(d, 'src/smell.js'), SMELL);
    sh(d, 'add', '-A'); sh(d, 'commit', '-qm', 'smell');
    const before = sh(d, 'status', '--porcelain').stdout;
    const r = run();
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /src\/smell\.js:1 +sonarjs\/cognitive-complexity/);
    const sarif = JSON.parse(r.stdout);
    assert.ok(sarif.runs.every(x => x.results.every(f => f.locations[0].physicalLocation.artifactLocation.uri === 'src/smell.js')), 'only the new file is reported');
    assert.equal(sh(d, 'status', '--porcelain').stdout, before, 'the analysed repo is not written to');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
