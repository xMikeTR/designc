'use strict';
// What the generated acceptance specs need in the codebase that runs them (renderer/core-handover.js writes
// tests/acceptance/fixture.ts and imports both). Node only like git.js, no Electron. The package list and the command
// are fixed here, so the renderer can ask for an install but never choose what runs.
const fs = require('fs');
const path = require('path');

const NEEDED = ['@playwright/test', '@axe-core/playwright'];

function manager(dir) {
  const has = f => fs.existsSync(path.join(dir, f));
  if (has('pnpm-lock.yaml')) return { name: 'pnpm', add: 'pnpm add -D' };
  if (has('yarn.lock')) return { name: 'yarn', add: 'yarn add -D' };
  return { name: 'npm', add: 'npm install -D' };
}

// {error} when the folder has no readable package.json, else each package as declared / installed and the command
// that would add the missing ones.
function check(dir) {
  const file = path.join(dir, 'package.json');
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { error: e.code === 'ENOENT' ? `No package.json in ${dir}. Point codebase in designc.json at the project that runs the acceptance specs.` : `${file} does not parse: ${e.message}` }; }
  const declared = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };
  const deps = NEEDED.map(name => ({ name, declared: Object.prototype.hasOwnProperty.call(declared, name),
    installed: fs.existsSync(path.join(dir, 'node_modules', ...name.split('/'), 'package.json')) }));
  const missing = deps.filter(d => !d.declared || !d.installed).map(d => d.name);
  const m = manager(dir);
  return { dir, deps, missing, manager: m.name, command: missing.length ? `${m.add} ${missing.join(' ')}` : null };
}

module.exports = { NEEDED, check, manager };
