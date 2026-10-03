// `designc check` records a gate event: when, by whom, from where, and when it stays quiet.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const Ledger = require('../renderer/ledger.js');

const PY = path.join(__dirname, '..', 'python');
const skip = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['CI', 'TF_BUILD', 'GITLAB_CI', 'GITHUB_ACTIONS', 'DESIGNC_BY'].includes(k)));
const GIT_ENV = { ...CLEAN, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const DSL = 'workspace { model { a = person "A"\n b = softwareSystem "B"\n a -> b "uses" } }';

function registry(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-rec-'));
  put(root, 'model/workspace.dsl', DSL);
  for (const [rel, text] of Object.entries(files)) put(root, rel, text);
  return root;
}
const check = (root, args = [], env = {}) => spawnSync('python3', ['-m', 'designc', 'check', root, ...args], { cwd: PY, encoding: 'utf8', env: { ...CLEAN, ...env } });
const gates = root => {
  const f = path.join(root, 'ledger', 'checks.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.kind === 'gate') : [];
};

test('a local run records one valid gate event; the same state again records nothing', { skip }, () => {
  const root = registry();
  const first = check(root);
  assert.equal(first.status, 0);
  assert.match(first.stdout, /recorded gate event in ledger\//);
  const [ev] = gates(root);
  assert.equal(gates(root).length, 1);
  assert.deepEqual(Ledger.validate(ev), []);
  assert.equal(ev.source, 'local');
  assert.equal(ev.ready, true);
  assert.ok(!('commit' in ev) && !('dirty' in ev), 'not a git repository');
  const second = check(root);
  assert.match(second.stdout, /gate unchanged, not recorded/);
  assert.equal(gates(root).length, 1);
});

test('a different verdict on the same model records again', { skip }, () => {
  const root = registry();
  check(root);
  put(root, 'requirements/R-1.yaml', 'id: R-1\ntitle: t\nsource: s\nversion: 1\nelements: []\n');
  const r = check(root);
  assert.equal(r.status, 1, 'an untraced requirement blocks the gate');
  const all = gates(root);
  assert.equal(all.length, 2);
  assert.equal(all[0].revision, all[1].revision);
  assert.notEqual(all[0].verdict, all[1].verdict);
  assert.equal(all[1].ready, false);
});

test('by comes from --by, then DESIGNC_BY, then the user running it', { skip }, () => {
  const by = (args, env) => { const root = registry(); check(root, args, env); return JSON.parse(fs.readFileSync(path.join(root, 'ledger', 'checks.jsonl'), 'utf8').trim()).by; };
  assert.equal(by(['--by', 'flag'], { DESIGNC_BY: 'env' }), 'flag');
  assert.equal(by([], { DESIGNC_BY: 'ci:pricing/#7' }), 'ci:pricing/#7');
  assert.ok(by([], {}).length > 0);
});

test('CI is detected and nothing is recorded unless asked; --record then labels the source pipeline', { skip }, () => {
  for (const env of [{ CI: 'true' }, { TF_BUILD: 'True' }, { GITLAB_CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) {
    const root = registry();
    const r = check(root, [], env);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /CI detected: not recording/);
    assert.equal(gates(root).length, 0, JSON.stringify(env));
    assert.ok(!fs.existsSync(path.join(root, 'ledger')), 'the checkout stays untouched');
    const rec = check(root, ['--record'], env);
    assert.match(rec.stdout, /recorded gate event/);
    assert.equal(gates(root)[0].source, 'pipeline');
  }
});

test('--no-record never writes, --source labels a recorded event, and a bad --source is refused', { skip }, () => {
  const root = registry();
  assert.equal(check(root, ['--no-record']).status, 0);
  assert.equal(gates(root).length, 0);
  check(root, ['--record', '--source', 'pipeline']);
  assert.equal(gates(root)[0].source, 'pipeline');
  assert.equal(check(root, ['--source', 'ci']).status, 2);
  assert.equal(check(root, ['--record', '--no-record']).status, 2);
});

test('--json stays valid JSON when recording; the note goes to stderr; the exit code is the gate\'s', { skip }, () => {
  const root = registry({ 'requirements/R-1.yaml': 'id: R-1\ntitle: t\nsource: s\nversion: 1\nelements: []\n' });
  const r = check(root, ['--json']);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).gate.ready, false);
  assert.match(r.stderr, /recorded gate event/);
  assert.equal(gates(root).length, 1);
});

test('inside a git repository the event names the commit and whether gate inputs are uncommitted', { skip }, () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-rec-git-'));
  git(top, 'init', '-q', '-b', 'main');
  put(top, 'other/x.txt', 'x\n');
  const root = path.join(top, 'reg');
  put(root, 'model/workspace.dsl', DSL);
  git(top, 'add', '-A'); git(top, 'commit', '-q', '-m', 'one');
  const head1 = git(top, 'rev-parse', 'HEAD');

  check(root);
  let [ev] = gates(root).slice(-1);
  assert.equal(ev.commit, head1);
  assert.equal(ev.dirty, false, 'the ledger file this run just wrote is not a gate input');
  assert.deepEqual(Ledger.validate(ev), []);

  put(root, 'decisions/D-1.yaml', 'id: D-1\nstatus: minted\nbinds: [B]\nstatement: s\n');
  put(top, 'other/y.txt', 'unrelated\n');
  check(root);
  ev = gates(root).slice(-1)[0];
  assert.equal(ev.dirty, true, 'an uncommitted decision');
  assert.equal(ev.commit, head1);

  git(top, 'add', '-A'); git(top, 'commit', '-q', '-m', 'two');
  const head2 = git(top, 'rev-parse', 'HEAD');
  check(root);
  ev = gates(root).slice(-1)[0];
  assert.equal(ev.commit, head2);
  assert.equal(ev.dirty, false);
  const before = gates(root).length;
  check(root);
  assert.equal(gates(root).length, before, 'unchanged on the same commit');
});

test('a repository with no commits yet gives commit null; a broken git leaves the git fields out', { skip }, () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-rec-empty-'));
  git(top, 'init', '-q', '-b', 'main');
  put(top, 'model/workspace.dsl', DSL);
  check(top);
  const ev = gates(top)[0];
  assert.equal(ev.commit, null);
  assert.equal(ev.dirty, true, 'the model is untracked');
  const noGit = registry();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-rec-bin-'));
  fs.symlinkSync(execFileSync('which', ['python3'], { encoding: 'utf8' }).trim(), path.join(bin, 'python3'));
  check(noGit, [], { PATH: bin });
  assert.ok(!('commit' in gates(noGit)[0]));
});

test('git hooks do not run when the CLI reads git state', { skip }, () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-rec-hook-'));
  git(top, 'init', '-q', '-b', 'main');
  put(top, 'model/workspace.dsl', DSL);
  git(top, 'add', '-A'); git(top, 'commit', '-q', '-m', 'one');
  const marker = path.join(top, 'hook-ran');
  put(top, '.git/hooks/post-index-change', `#!/bin/sh\ntouch ${marker}\n`);
  fs.chmodSync(path.join(top, '.git/hooks/post-index-change'), 0o755);
  put(top, '.git/config', fs.readFileSync(path.join(top, '.git/config'), 'utf8') + `[core]\n\tfsmonitor = ${path.join(top, 'fsmon.sh')}\n`);
  put(top, 'fsmon.sh', `#!/bin/sh\ntouch ${marker}\n`);
  fs.chmodSync(path.join(top, 'fsmon.sh'), 0o755);
  check(top);
  assert.ok(!fs.existsSync(marker), 'neither the hook nor the configured fsmonitor program ran');
  assert.equal(gates(top).length, 1);
});
