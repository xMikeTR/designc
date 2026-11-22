// L3 slice 3: one implementation. The editor's providers live in the server; the app only wires them (source guard).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', 'renderer');
const read = f => fs.readFileSync(path.join(R, f), 'utf8');
const walk = d => fs.readdirSync(path.join(R, d), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test('renderer/app.js has none of the old editor providers', () => {
  const app = read('app.js');
  for (const bad of ['registerHoverProvider', 'registerCompletionItemProvider', 'registerCodeActionProvider', 'setModelMarkers', 'DslAssist.completeAt', 'DslAssist.hoverAt', 'Refactor.recordable', 'designc.recordDecision', 'setMarkers', 'byKey(PROPS)'])
    assert.ok(!app.includes(bad), `app.js still contains ${bad}`);
  assert.ok(!/^const PROP = /m.test(app), 'PROP is gone (PROPS stays for help:props)');
  assert.match(app, /^const PROPS = /m);
});

test('only lsp-client.js registers Monaco language providers', () => {
  for (const f of walk('.').filter(f => f.endsWith('.js'))) {
    const hits = (read(f).match(/languages\.register\w*Provider/g) || []).filter(m => !/registerTokensProviderFactory/.test(m));
    if (f === 'lsp-client.js') assert.ok(hits.length >= 5, 'lsp-client registers the providers');
    else assert.deepEqual(hits, [], `${f} registers a provider`);
  }
  const app = read('app.js');
  for (const keep of ['languages.register(', 'setMonarchTokensProvider', 'setLanguageConfiguration']) assert.ok(app.includes(keep), keep);
});

test('lsp-client.js is protocol-only', () => {
  const src = read('lsp-client.js').replace(/\/\*[\s\S]*?\*\//, '').replace(/\/\/.*$/gm, '');
  for (const w of ['Core', 'DslAssist', 'Refactor', 'Problems']) assert.ok(!new RegExp(`\\b${w}\\b`).test(src), `lsp-client.js mentions ${w}`);
});

test('index.html loads lsp-client.js after the Monaco loader and before app.js', () => {
  const h = read('index.html'), at = s => h.indexOf(`<script src="${s}"></script>`);
  assert.ok(at('../node_modules/monaco-editor/min/vs/loader.js') > 0 && at('lsp-client.js') > at('../node_modules/monaco-editor/min/vs/loader.js') && at('app.js') > at('lsp-client.js'));
});
