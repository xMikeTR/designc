'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../testdeps.js');

const mk = (pkg, files = {}) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-deps-'));
  if (pkg) fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(pkg));
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); }
  return d;
};

test('both packages missing: the command adds both with the project\'s package manager', () => {
  assert.equal(T.check(mk({ devDependencies: {} })).command, 'npm install -D @playwright/test @axe-core/playwright');
  assert.equal(T.check(mk({}, { 'package.json': '{}', 'pnpm-lock.yaml': '' })).command, 'pnpm add -D @playwright/test @axe-core/playwright');
  assert.match(T.check(mk({}, { 'package.json': '{}', 'yarn.lock': '' })).command, /^yarn add -D /);
});

test('declared but not installed counts as missing; declared and installed does not', () => {
  const d = mk({ devDependencies: { '@playwright/test': '^1', '@axe-core/playwright': '^4' } }, { 'node_modules/@playwright/test/package.json': '{}' });
  const r = T.check(d);
  assert.deepEqual(r.deps.map(x => [x.name, x.declared, x.installed]), [['@playwright/test', true, true], ['@axe-core/playwright', true, false]]);
  assert.deepEqual(r.missing, ['@axe-core/playwright']);
  fs.mkdirSync(path.join(d, 'node_modules/@axe-core/playwright'), { recursive: true });
  fs.writeFileSync(path.join(d, 'node_modules/@axe-core/playwright/package.json'), '{}');
  const ok = T.check(d);
  assert.equal(ok.command, null);
  assert.deepEqual(ok.missing, []);
});

test('no package.json, or one that does not parse, is an error that says what to do', () => {
  assert.match(T.check(mk(null)).error, /No package\.json .*codebase in designc\.json/);
  assert.match(T.check(mk(null, { 'package.json': '{' })).error, /does not parse/);
});

test('the install is built in the main process from the fixed list; the renderer passes no command', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const h = main.slice(main.indexOf("handle('deps:install'"), main.indexOf('// Integrated terminal'));
  assert.match(h, /showMessageBox/);
  assert.match(h, /ensureTrusted/);
  assert.match(h, /runShell\(runId, st\.command, dir\)/);
  assert.doesNotMatch(h, /async \(runId, (cmd|command)/);
});
