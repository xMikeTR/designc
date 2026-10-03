const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { confine, childEnv } = require('../paths.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-paths-'));
const root = path.join(tmp, 'reg'), outside = path.join(tmp, 'out');
fs.mkdirSync(path.join(root, 'model'), { recursive: true }); fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
fs.symlinkSync(outside, path.join(root, 'link'));
fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'model', 'f.txt'));

test('confine accepts files and new files inside the root', () => {
  assert.equal(confine(root, 'model/workspace.dsl'), path.join(root, 'model/workspace.dsl'));
  assert.equal(confine(root, 'new/deep/file.yaml'), path.join(root, 'new/deep/file.yaml'));
  assert.equal(confine(root, ''), root);
});
test('confine rejects ../ escapes lexically', () => {
  assert.throws(() => confine(root, '../out/secret.txt'), /outside the open folder/);
});
test('confine rejects a symlinked folder or file that leads outside', () => {
  assert.throws(() => confine(root, 'link/secret.txt'), /outside the open folder/);
  assert.throws(() => confine(root, 'link/new.txt'), /outside the open folder/);
  assert.throws(() => confine(root, 'model/f.txt'), /outside the open folder/);
});
test('childEnv drops secret-looking names unless inherited explicitly', () => {
  const env = { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k', LANGFUSE_SECRET_KEY: 's', GH_TOKEN: 't', DESIGNC_LLM_API_KEY: 'x', DOTNET_ROOT: '/d' };
  assert.deepEqual(childEnv(env), { PATH: '/bin', HOME: '/h', DOTNET_ROOT: '/d' });
  assert.equal(childEnv(env, ['ANTHROPIC_API_KEY']).ANTHROPIC_API_KEY, 'k');
  assert.equal(childEnv(env, ['ANTHROPIC_API_KEY']).GH_TOKEN, undefined);
});

const { isTrusted, trustChoices } = require('../paths.js');

test('isTrusted: the folder itself or any trusted ancestor, never a sibling or a lookalike prefix', () => {
  const t = [path.join(tmp, 'work')];
  assert.equal(isTrusted(t, path.join(tmp, 'work')), true);
  assert.equal(isTrusted(t, path.join(tmp, 'work', 'repo', 'registry')), true);
  assert.equal(isTrusted(t, path.join(tmp, 'work2')), false);
  assert.equal(isTrusted(t, tmp), false);
  assert.equal(isTrusted([], root), false);
});

test('trustChoices: folder first, then the repository, then the parent; no duplicates, never the home or filesystem root', () => {
  const home = os.homedir();
  const c = trustChoices('/w/repo/registry', '/w/repo', '/nohome');
  assert.deepEqual(c.map(x => x.path), ['/w/repo/registry', '/w/repo']);
  assert.deepEqual(trustChoices('/w/repo', '/w/repo', '/nohome').map(x => x.path), ['/w/repo', '/w']);
  assert.deepEqual(trustChoices('/w', null, '/w').map(x => x.path), ['/w']);
  assert.deepEqual(trustChoices(path.join(home, 'x'), null, home).map(x => x.path), [path.join(home, 'x')]);
});

test('isTrusted: the user-level trust-everything switch trusts any folder, nothing else does', () => {
  assert.equal(isTrusted([], '/w/repo'), false);
  assert.equal(isTrusted([], '/w/repo', true), true);
  assert.equal(isTrusted([], '/w/repo', 'yes'), false, 'only the boolean true counts');
  assert.equal(isTrusted([], '/w/repo', undefined), false);
});
