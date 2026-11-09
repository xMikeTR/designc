const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../git');

test('initRepo makes a new folder a repo on main with one empty commit and stages nothing', async () => {
  const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-repo-')), 'new', 'app');
  assert.deepEqual(await git.repoState(d), { exists: false, repo: false, base: false });
  assert.deepEqual(await git.initRepo(d), { ok: true });
  assert.deepEqual(await git.repoState(d), { exists: true, repo: true, base: true });
  assert.equal((await git.run(d, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim(), 'main');
  assert.equal((await git.run(d, ['rev-list', '--count', 'HEAD'])).out.trim(), '1');
});

test('initRepo leaves existing files uncommitted and is safe to run twice', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-repo-'));
  fs.writeFileSync(path.join(d, 'a.txt'), 'x');
  assert.deepEqual(await git.repoState(d), { exists: true, repo: false, base: false });
  await git.initRepo(d); await git.initRepo(d);
  assert.equal((await git.run(d, ['rev-list', '--count', 'HEAD'])).out.trim(), '1');
  assert.equal((await git.run(d, ['ls-files'])).out.trim(), '');
});

test('a subfolder of a repo is not itself a repo for building into', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-repo-'));
  await git.initRepo(d);
  fs.mkdirSync(path.join(d, 'sub'));
  assert.equal((await git.repoState(path.join(d, 'sub'))).repo, false);
});
