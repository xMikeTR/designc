const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { extract } = require('../extract.js');

const FULL = path.join(__dirname, '..', 'fixtures', 'fullstack');
const API = path.join(FULL, 'api'), UI = path.join(FULL, 'ui');
const edgeSet = r => r.facts.edges.map(e => `${e.from} -${e.kind}-> ${e.to}`).sort();

test('two repos extracted apart link the UI to the API as one folder holding both does', async () => {
  const split = await extract({ Api: API, Ui: UI });
  assert.equal('error' in split, false, split.error);
  const alone = await extract(UI);
  assert.ok(alone.facts.unresolved.some(u => /customers/.test(u.what)), 'on its own the UI cannot find its API');
  assert.ok(edgeSet(split).includes('ui -sync-> Shop.Api'), edgeSet(split).join('\n'));
  assert.equal(split.facts.unresolved.some(u => /customers/.test(u.what)), false);
  // everything the combined folder finds in api/ and ui/ is found again
  const combined = await extract(FULL);
  for (const e of edgeSet(combined)) if (!/node-api/.test(e)) assert.ok(edgeSet(split).includes(e), `missing ${e}`);
  assert.deepEqual(split.facts.repos, ['Api', 'Ui']);
  assert.equal(split.facts.repo, 'Api + Ui');
});

test('every path in split facts names its repo, and the file list does too', async () => {
  const r = await extract({ Api: API, Ui: UI });
  const files = new Set(r.facts.files);
  assert.ok([...files].every(f => /^(Api|Ui)\//.test(f)));
  assert.ok(files.has('Api/src/Shop.Api/Program.cs') && files.has('Ui/package.json'));
  const evidence = [...r.facts.elements.flatMap(e => e.evidence), ...r.facts.edges.flatMap(e => e.evidence)];
  assert.ok(evidence.length > 0 && evidence.every(v => /^(Api|Ui)\//.test(v.file) || v.file === 'designc.json'), JSON.stringify(evidence.filter(v => !/^(Api|Ui)\//.test(v.file))));
  const edge = r.facts.edges.find(e => e.from === 'ui' && e.to === 'Shop.Api');
  assert.ok(edge.evidence.every(v => v.file.startsWith('Ui/')));
  // components and code level read the right repo through the prefixed paths
  assert.ok(r.facts.components.some(c => c.files.some(f => f.startsWith('Api/'))));
  const methodFiles = r.facts.code.types.flatMap(t => t.methods.map(m => m.file));
  assert.ok(methodFiles.length > 0 && methodFiles.every(f => /^(Api|Ui)\//.test(f)) && methodFiles.some(f => f.startsWith('Api/')), 'method files are read through the repo prefix');
});

test('a container name held by two repos is kept apart, not merged', async () => {
  const r = await extract({ Web: UI, Admin: UI });
  assert.equal('error' in r, false, r.error);
  const names = r.facts.elements.filter(e => e.kind === 'container').map(e => e.name).sort();
  assert.deepEqual(names, ['ui (Admin)', 'ui (Web)']);
  assert.ok(r.facts.unresolved.some(u => /kept apart/.test(u.what)));
  const owners = new Set(r.facts.edges.filter(e => e.to === 'Entra ID').map(e => e.from));
  assert.deepEqual([...owners].sort(), ['ui (Admin)', 'ui (Web)']);
  // a shared external system is one element, not two
  assert.equal(r.facts.elements.filter(e => e.name === 'Entra ID').length, 1);
});

test('a split extraction with no project in any repo says which repos it checked', async () => {
  const r = await extract({ Empty: path.join(FULL, 'ledger') });
  assert.match(r.error, /Checked: Empty/);
});

test('one folder still extracts with no prefix', async () => {
  const r = await extract(UI);
  assert.ok(r.facts.files.every(f => !/^Ui\//.test(f)));
  assert.equal(r.facts.repos, undefined);
});

test('settings that need one repo say they are not applied to a split extraction', async () => {
  const r = await extract({ Api: API, Ui: UI }, { ui: { screens: { x: { Ui: ['src/**'] } } }, intent: 'docs/intent.md', coverage: ['cov.xml'] });
  const what = r.facts.unresolved.map(u => u.what).join('\n');
  assert.match(what, /ui\.screens is not supported with repos/);
  assert.match(what, /extract\.intent is not supported with repos/);
  assert.match(what, /extract\.coverage is not supported with repos/);
  assert.equal(r.facts.ui, undefined);
  assert.equal(r.facts.intent, undefined);
});
