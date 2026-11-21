// L3 slice 1: every module the language server loads is covered by package.json build.files (so a packaged app can start it).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.join(__dirname, '..');
const globs = require('../package.json').build.files.filter(g => !g.startsWith('!'));
const rx = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, m => (m.endsWith('/') ? '\0' : '\1')).replace(/\*/g, '[^/]*').replace(/\0/g, '(?:.*/)?').replace(/\1/g, '.*') + '$');
const covered = rel => globs.some(g => rx(g).test(rel));

test('build.files covers every module the language server loads', () => {
  const code = `
    for (const m of ['./lsp/providers.js','./headless/index.js','./renderer/problems.js','./renderer/core.js','./renderer/refactor.js','./renderer/dsl-assist.js','./renderer/canvas/vocabulary.js','vscode-languageserver/node','vscode-languageserver-textdocument']) require(m);
    console.log(JSON.stringify(Object.keys(require.cache)));`;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', code], { cwd: APP, encoding: 'utf8' }));
  const rels = [...new Set([...out.map(f => path.relative(APP, f).split(path.sep).join('/')), 'lsp/server.js'])].filter(r => !r.startsWith('..'));
  assert.ok(rels.some(r => r.startsWith('node_modules/vscode-jsonrpc/')) && rels.some(r => r.startsWith('node_modules/js-yaml/')));
  const missing = rels.filter(r => !covered(r));
  assert.deepEqual(missing, []);
});
