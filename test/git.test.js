const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const git = require('../git.js');

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' };
const g = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

// A repo whose registry is the `reg` subfolder, beside an unrelated `other` folder.
function repo() {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-'));
  g(top, 'init', '-q', '-b', 'main');
  put(top, 'reg/model/workspace.dsl', 'v1\n'); put(top, 'other/x.txt', 'x\n');
  g(top, 'add', '-A'); g(top, 'commit', '-q', '-m', 'first');
  put(top, 'reg/model/workspace.dsl', 'v2\n');
  g(top, 'add', '-A'); g(top, 'commit', '-q', '-m', 'second');
  return { top, reg: path.join(top, 'reg') };
}

test('findRepo walks up to a .git without running git, and is null outside a repo', () => {
  const { top, reg } = repo();
  assert.equal(git.findRepo(reg), top);
  assert.equal(git.findRepo(fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-'))), null);
});

test('status sees only the registry, with paths relative to it', async () => {
  const { top, reg } = repo();
  put(top, 'reg/decisions/a.yaml', 'id: a\n'); put(top, 'other/y.txt', 'y\n');
  put(top, 'reg/model/workspace.dsl', 'v3\n'); g(top, 'add', 'reg/model/workspace.dsl');
  const s = await git.status(reg);
  assert.equal(s.branch, 'main'); assert.equal(s.detached, false); assert.equal(s.head, g(top, 'rev-parse', 'HEAD'));
  assert.deepEqual(s.files.map(f => f.path).sort(), ['decisions/a.yaml', 'model/workspace.dsl']);
  const m = s.files.find(f => f.path === 'model/workspace.dsl'), u = s.files.find(f => f.path === 'decisions/a.yaml');
  assert.deepEqual([m.index, m.worktree], ['M', '.']); assert.deepEqual([u.index, u.worktree], ['?', '?']);
});

test('status reports a detached head and no upstream', async () => {
  const { top, reg } = repo();
  g(top, 'checkout', '-q', '--detach', 'HEAD~1');
  const s = await git.status(reg);
  assert.equal(s.detached, true); assert.equal(s.branch, null); assert.equal(s.upstream, null);
});

test('refs lists branches and tags, marking the current branch', async () => {
  const { top, reg } = repo();
  g(top, 'branch', 'feature/x'); g(top, 'tag', 'v1');
  const r = await git.refs(reg);
  assert.deepEqual(r.branches.map(b => b.name).sort(), ['feature/x', 'main']);
  assert.equal(r.branches.find(b => b.current).name, 'main');
  assert.deepEqual(r.tags.map(t => t.name), ['v1']);
  assert.match(r.tags[0].hash, /^[0-9a-f]{40}$/);
});

test('log is limited to the file, newest first, and max is clamped', async () => {
  const { top, reg } = repo();
  put(top, 'other/x.txt', 'changed\n'); g(top, 'add', '-A'); g(top, 'commit', '-q', '-m', 'unrelated');
  const l = await git.log(reg, 'model/workspace.dsl', 10);
  assert.deepEqual(l.map(c => c.subject), ['second', 'first']);
  assert.match(l[0].hash, /^[0-9a-f]{40}$/); assert.equal(l[0].short, l[0].hash.slice(0, 7)); assert.equal(l[0].author, 'T');
  assert.equal((await git.log(reg, 'model/workspace.dsl', 1)).length, 1);
  assert.equal((await git.log(reg, 'model/workspace.dsl', -5)).length, 1);
  assert.equal((await git.log(reg, '.', 10)).length, 2);
});

test('show returns the file at a commit and refuses anything that is not a full hash', async () => {
  const { top, reg } = repo();
  const first = g(top, 'rev-parse', 'HEAD~1');
  assert.deepEqual(await git.show(reg, first, 'model/workspace.dsl'), { text: 'v1\n' });
  for (const bad of ['HEAD', 'main', '--output=x', first.slice(0, 7), `${first}:../other/x.txt`, ''])
    assert.match((await git.show(reg, bad, 'model/workspace.dsl')).error, /full commit hash/, bad);
  assert.match((await git.show(reg, first, '../other/x.txt')).error, /outside/);
  assert.match((await git.show(reg, first, 'nope.txt')).error, /not in that commit/);
});

test('a repo cannot run its own fsmonitor or hooks through a read', async () => {
  const { top, reg } = repo();
  const marker = path.join(top, 'ran.txt');
  fs.writeFileSync(path.join(top, 'fsm.sh'), `#!/bin/sh\necho ran > '${marker}'\nprintf '\\0'\n`, { mode: 0o755 });
  g(top, 'config', 'core.fsmonitor', path.join(top, 'fsm.sh'));
  g(top, 'config', 'core.pager', `touch '${marker}'`);
  await git.status(reg); await git.log(reg, '.', 5); await git.refs(reg);
  assert.equal(fs.existsSync(marker), false);
});

test('git errors come back as {error}, not thrown', async () => {
  const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-'));
  assert.ok((await git.status(nowhere)).error);
  assert.ok((await git.refs(nowhere)).error);
  assert.ok((await git.log(nowhere, '.', 5)).error);
});

// ---- slice 2: the daily loop

const gitNames = async root => (await git.status(root)).files.map(f => `${f.index}${f.worktree}:${f.path}`).sort();

test('stage and unstage move a registry file in and out of the index; paths outside the registry are refused', async () => {
  const { top, reg } = repo();
  put(top, 'reg/decisions/a.yaml', 'id: a\n');
  assert.deepEqual(await git.stage(reg, ['decisions/a.yaml']), { ok: true });
  assert.deepEqual(await gitNames(reg), ['A.:decisions/a.yaml']);
  assert.deepEqual(await git.unstage(reg, ['decisions/a.yaml']), { ok: true });
  assert.deepEqual(await gitNames(reg), ['??:decisions/a.yaml']);
  assert.ok((await git.stage(reg, ['../other/x.txt'])).error);
  assert.ok((await git.stage(reg, [])).error);
});

test('stage and unstage of the registry root move every registry file and leave the rest of the repo alone', async () => {
  const { top, reg } = repo();
  put(top, 'reg/decisions/a.yaml', 'id: a\n'); put(top, 'reg/model/workspace.dsl', 'v3\n'); put(top, 'other/y.txt', 'y\n');
  assert.deepEqual(await git.stage(reg, ['.']), { ok: true });
  assert.deepEqual(await gitNames(reg), ['A.:decisions/a.yaml', 'M.:model/workspace.dsl']);
  assert.equal(g(top, 'status', '--porcelain', '--', 'other'), '?? other/y.txt');
  assert.deepEqual(await git.unstage(reg, ['.']), { ok: true });
  assert.deepEqual(await gitNames(reg), ['.M:model/workspace.dsl', '??:decisions/a.yaml']);
});

test('stash saves registry changes with untracked files, lists them, and applies, pops and drops by validated ref', async () => {
  const { top, reg } = repo();
  assert.match((await git.stashPush(reg, 'nothing')).error, /Nothing to stash/);
  put(top, 'reg/model/workspace.dsl', 'v3\n'); put(top, 'reg/decisions/a.yaml', 'id: a\n'); put(top, 'other/y.txt', 'y\n');
  assert.deepEqual(await git.stashPush(reg, 'wip decisions'), { ok: true });
  assert.deepEqual(await gitNames(reg), []);
  assert.equal(fs.readFileSync(path.join(top, 'other/y.txt'), 'utf8'), 'y\n'); // outside the registry: untouched
  const l = await git.stashList(reg);
  assert.equal(l.length, 1); assert.equal(l[0].ref, 'stash@{0}'); assert.match(l[0].message, /wip decisions/);
  assert.deepEqual(await git.stashApply(reg, 'stash@{0}'), { ok: true });
  assert.deepEqual(await gitNames(reg), ['.M:model/workspace.dsl', '??:decisions/a.yaml']);
  assert.equal((await git.stashList(reg)).length, 1); // apply keeps it
  for (const bad of ['--all', 'HEAD', 'stash@{x}', 'stash@{0};ls', '', null]) { assert.ok((await git.stashDrop(reg, bad)).error, String(bad)); assert.ok((await git.stashApply(reg, bad)).error, String(bad)); }
  assert.deepEqual(await git.stashDrop(reg, 'stash@{0}'), { ok: true });
  assert.deepEqual(await git.stashList(reg), []);
  assert.match((await git.stashPop(reg)).error, /No stash/);
});

test('stash pop restores the newest stash and removes it', async () => {
  const { top, reg } = repo();
  put(top, 'reg/a.txt', 'a'); await git.stashPush(reg, 'one');
  assert.deepEqual(await git.stashPop(reg), { ok: true });
  assert.deepEqual(await gitNames(reg), ['??:a.txt']);
  assert.deepEqual(await git.stashList(reg), []);
});

test('discard restores tracked files from the index and refuses untracked files, directories and outside paths', async () => {
  const { top, reg } = repo();
  put(top, 'reg/model/workspace.dsl', 'edited\n'); put(top, 'reg/new.txt', 'n\n'); put(top, 'other/x.txt', 'changed\n');
  assert.ok((await git.discard(reg, ['new.txt'])).error);                 // untracked: never deleted
  assert.ok((await git.discard(reg, ['model'])).error);                   // a directory is not a file git lists
  assert.ok((await git.discard(reg, ['.'])).error);
  assert.ok((await git.discard(reg, ['../other/x.txt'])).error);
  assert.ok((await git.discard(reg, [])).error);
  assert.equal(fs.readFileSync(path.join(reg, 'new.txt'), 'utf8'), 'n\n');
  assert.deepEqual(await git.discard(reg, ['model/workspace.dsl']), { ok: true });
  assert.equal(fs.readFileSync(path.join(reg, 'model/workspace.dsl'), 'utf8'), 'v2\n');
  fs.rmSync(path.join(reg, 'model/workspace.dsl'));                       // a deleted file comes back
  assert.deepEqual(await git.discard(reg, ['model/workspace.dsl']), { ok: true });
  assert.equal(fs.readFileSync(path.join(reg, 'model/workspace.dsl'), 'utf8'), 'v2\n');
});

test('discard keeps what is staged: only the working tree copy is restored', async () => {
  const { top, reg } = repo();
  put(top, 'reg/model/workspace.dsl', 'staged\n'); g(top, 'add', 'reg/model/workspace.dsl');
  put(top, 'reg/model/workspace.dsl', 'worktree\n');
  assert.deepEqual(await git.discard(reg, ['model/workspace.dsl']), { ok: true });
  assert.equal(fs.readFileSync(path.join(reg, 'model/workspace.dsl'), 'utf8'), 'staged\n');
  assert.deepEqual(await gitNames(reg), ['M.:model/workspace.dsl']);
});

test('commit takes the message on stdin, so a message that looks like a flag is text', async () => {
  const { top, reg } = repo();
  put(top, 'reg/decisions/a.yaml', 'id: a\n'); await git.stage(reg, ['decisions/a.yaml']);
  const r = await git.commit(reg, '--amend -m nope\n\nbody');
  assert.equal(r.ok, true); assert.equal(r.hash, g(top, 'rev-parse', 'HEAD'));
  assert.equal(g(top, 'log', '-1', '--format=%s'), '--amend -m nope');
  assert.equal(g(top, 'rev-list', '--count', 'HEAD'), '3');
});

test('commit refuses an empty message, nothing staged, and staged files outside the registry', async () => {
  const { top, reg } = repo();
  assert.match((await git.commit(reg, 'x')).error, /Nothing is staged/);
  put(top, 'reg/a.txt', 'a'); await git.stage(reg, ['a.txt']);
  assert.match((await git.commit(reg, '  \n')).error, /message/);
  put(top, 'other/z.txt', 'z'); g(top, 'add', 'other/z.txt');
  assert.match((await git.commit(reg, 'x')).error, /outside the registry/);
});

test('hooks do not run on commit', async () => {
  const { top, reg } = repo();
  put(top, '.git/hooks/pre-commit', '#!/bin/sh\ntouch "$PWD/hook-ran"\nexit 1\n'); fs.chmodSync(path.join(top, '.git/hooks/pre-commit'), 0o755);
  put(top, 'reg/a.txt', 'a'); await git.stage(reg, ['a.txt']);
  assert.equal((await git.commit(reg, 'x')).ok, true);
  assert.equal(fs.existsSync(path.join(top, 'hook-ran')), false);
});

test('branch creates and switches; switch only accepts an existing branch name', async () => {
  const { top, reg } = repo();
  assert.deepEqual(await git.branch(reg, 'feature/x'), { ok: true });
  assert.equal(g(top, 'branch', '--show-current'), 'feature/x');
  assert.ok((await git.branch(reg, '-bad')).error); assert.ok((await git.branch(reg, 'a b')).error);
  assert.deepEqual(await git.switchTo(reg, 'main'), { ok: true });
  assert.equal(g(top, 'branch', '--show-current'), 'main');
  assert.match((await git.switchTo(reg, 'nope')).error, /No branch/);
  assert.match((await git.switchTo(reg, '--detach')).error, /No branch/);
});

function withRemote() {
  const r = repo(), bare = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-'));
  g(bare, 'init', '-q', '--bare', '-b', 'main'); g(r.top, 'remote', 'add', 'origin', bare);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-'));
  return { ...r, bare, other };
}

test('push with no upstream is refused until publish; publish needs exactly one remote', async () => {
  const { top, reg, bare } = withRemote();
  assert.match((await git.push(reg)).error, /no upstream/i);
  assert.deepEqual(await git.publish(reg), { ok: true });
  assert.equal(g(bare, 'rev-parse', 'main'), g(top, 'rev-parse', 'HEAD'));
  assert.equal((await git.status(reg)).upstream, 'origin/main');
  g(top, 'remote', 'add', 'second', bare); g(top, 'checkout', '-q', '-b', 'b2');
  assert.match((await git.publish(reg)).error, /one remote/);
});

test('pull is fast-forward only; a diverged branch is an error and nothing is merged', async () => {
  const { top, reg, bare, other } = withRemote();
  await git.publish(reg);
  g(other, 'clone', '-q', bare, 'c'); const c = path.join(other, 'c');
  put(c, 'reg/remote.txt', 'r'); g(c, 'add', '-A'); g(c, 'commit', '-q', '-m', 'remote'); g(c, 'push', '-q');
  assert.deepEqual(await git.fetch(reg), { ok: true });
  assert.equal((await git.status(reg)).behind, 1);
  assert.deepEqual(await git.pull(reg), { ok: true });
  assert.ok(fs.existsSync(path.join(top, 'reg/remote.txt')));
  put(c, 'reg/r2.txt', 'r'); g(c, 'add', '-A'); g(c, 'commit', '-q', '-m', 'remote2'); g(c, 'push', '-q');
  put(top, 'reg/l.txt', 'l'); g(top, 'add', '-A'); g(top, 'commit', '-q', '-m', 'local');
  await git.fetch(reg);
  const before = g(top, 'rev-parse', 'HEAD');
  assert.ok((await git.pull(reg)).error);
  assert.equal(g(top, 'rev-parse', 'HEAD'), before);
  assert.ok((await git.push(reg)).error);
});

test('ledger union attribute: detected, added once, existing lines kept', () => {
  const { reg } = repo();
  assert.equal(git.hasLedgerUnion(reg), false);
  put(reg, '.gitattributes', '*.dsl text\n');
  assert.deepEqual(git.addLedgerUnion(reg), { ok: true });
  assert.deepEqual(git.addLedgerUnion(reg), { ok: true });
  assert.equal(git.hasLedgerUnion(reg), true);
  assert.equal(fs.readFileSync(path.join(reg, '.gitattributes'), 'utf8'), '*.dsl text\nledger/*.jsonl merge=union\n');
});

test('two branches that each appended to the ledger merge without a conflict', async () => {
  const { top, reg } = repo();
  git.addLedgerUnion(reg); put(reg, 'ledger/designc.jsonl', 'one\n');
  g(top, 'add', '-A'); g(top, 'commit', '-q', '-m', 'base');
  g(top, 'checkout', '-q', '-b', 'b'); put(reg, 'ledger/designc.jsonl', 'one\nfrom-b\n'); g(top, 'commit', '-qam', 'b');
  g(top, 'checkout', '-q', 'main'); put(reg, 'ledger/designc.jsonl', 'one\nfrom-main\n'); g(top, 'commit', '-qam', 'm');
  g(top, 'merge', '-q', '--no-edit', 'b');
  assert.deepEqual(fs.readFileSync(path.join(reg, 'ledger/designc.jsonl'), 'utf8').split('\n').filter(Boolean).sort(), ['from-b', 'from-main', 'one']);
});

test('head gives the commit, branch and whether tracked files are dirty', async () => {
  const { top } = repo();
  const h = await git.head(top);
  assert.equal(h.commit, g(top, 'rev-parse', 'HEAD')); assert.equal(h.branch, 'main'); assert.equal(h.dirty, false);
  put(top, 'other/x.txt', 'changed\n');
  assert.equal((await git.head(top)).dirty, true);
  assert.ok((await git.head(fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-')))).error);
});

test('isAncestor says whether a commit is reachable from a branch, and refuses what it cannot judge', async () => {
  const { top } = repo();
  const onMain = g(top, 'rev-parse', 'HEAD');
  g(top, 'switch', '-q', '-c', 'feature');
  put(top, 'other/f.txt', 'f\n'); g(top, 'add', '-A'); g(top, 'commit', '-q', '-m', 'feature work');
  const onFeature = g(top, 'rev-parse', 'HEAD');
  assert.deepEqual(await git.isAncestor(top, onMain, 'main'), { onMain: true, commit: onMain });
  assert.deepEqual(await git.isAncestor(top, onFeature, 'main'), { onMain: false, commit: onFeature });
  assert.equal((await git.isAncestor(top, onFeature.slice(0, 9), 'main')).commit, onFeature, 'a short hash is resolved');
  g(top, 'switch', '-q', 'main'); g(top, 'merge', '-q', '--ff-only', 'feature');
  assert.equal((await git.isAncestor(top, onFeature, 'main')).onMain, true);
  assert.ok((await git.isAncestor(top, 'a'.repeat(40), 'main')).error, 'unknown commit');
  assert.ok((await git.isAncestor(top, onMain, 'nope')).error, 'unknown branch');
  assert.ok((await git.isAncestor(top, onMain, '--all')).error, 'a flag is not a branch');
  assert.ok((await git.isAncestor(top, 'HEAD; rm -rf', 'main')).error);
});
