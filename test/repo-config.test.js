const { test } = require('node:test');
const assert = require('node:assert/strict');
const RepoConfig = require('../renderer/repoconfig.js');

test('first repo on a design with no codebase creates repos', () => {
  const r = RepoConfig.add({ model: 'm' }, 'Api', '../api');
  assert.deepEqual(r.cfg.repos, { Api: '../api' });
  assert.ok(!('codebase' in r.cfg));
});

test('adding to a design with a codebase asks for its name, then moves it into repos', () => {
  const cfg = { model: 'm', codebase: '../app' };
  const ask = RepoConfig.add(cfg, 'Ui', '../ui');
  assert.equal(ask.needsName, 'codebase');
  assert.deepEqual(cfg, { model: 'm', codebase: '../app' }, 'input is not mutated');
  const r = RepoConfig.add(cfg, 'Ui', '../ui', { codebaseName: 'Api' });
  assert.deepEqual(r.cfg.repos, { Api: '../app', Ui: '../ui' });
  assert.ok(!('codebase' in r.cfg));
  assert.equal(r.cfg.model, 'm');
});

test('the codebase name may not clash with the new repo name', () => {
  assert.match(RepoConfig.add({ codebase: '../app' }, 'Api', '../ui', { codebaseName: 'Api' }).error, /different/i);
});

test('names are letters, digits, dash, underscore, and not a path', () => {
  for (const bad of ['', ' ', 'a/b', '1x', 'a b', '..']) assert.ok(RepoConfig.add({}, bad, '../x').error, JSON.stringify(bad));
  assert.ok(!RepoConfig.add({}, 'Ui-2_x', '../x').error);
});

test('a duplicate name or a folder already added is refused', () => {
  const cfg = { repos: { Api: '../api' } };
  assert.match(RepoConfig.add(cfg, 'Api', '../other').error, /already/i);
  assert.match(RepoConfig.add(cfg, 'Ui', '../api').error, /already.*Api/i);
  assert.match(RepoConfig.add(cfg, 'Ui', '../api/').error, /already.*Api/i, 'trailing slash is the same folder');
});

test('remove drops a repo; removing the last one drops repos', () => {
  const two = { repos: { Api: '../api', Ui: '../ui' }, model: 'm' };
  assert.deepEqual(RepoConfig.remove(two, 'Ui').cfg.repos, { Api: '../api' });
  const none = RepoConfig.remove({ repos: { Api: '../api' } }, 'Api').cfg;
  assert.ok(!('repos' in none));
  assert.ok(RepoConfig.remove(two, 'Nope').error);
});
