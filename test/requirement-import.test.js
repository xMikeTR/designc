const { test } = require('node:test');
const assert = require('node:assert/strict');
const RI = require('../renderer/requirement-import.js');

const md = (front, body = '# Heading\n\nText.\n') => `---\n${front}\n---\n${body}`;

test('markdown front matter gives id, title, source and version', () => {
  const r = RI.read({ name: 'page.md', text: md('id: DEMO-12\ntitle: Quote edits are kept\nsource: https://wiki.example/p/1\nversion: 4') });
  assert.deepEqual(r, { ok: true, id: 'DEMO-12', title: 'Quote edits are kept', source: 'https://wiki.example/p/1', version: '4', problems: [] });
});

test('markdown without front matter takes the first heading as title and the file name as source', () => {
  const r = RI.read({ name: 'quote-edits.md', text: '# Quote edits are kept\n\nBody.\n' });
  assert.equal(r.title, 'Quote edits are kept');
  assert.equal(r.source, 'quote-edits.md');
  assert.equal(r.id, null);
});

test('a Jira-style key in the title or file name becomes the id, front matter wins', () => {
  assert.equal(RI.read({ name: 'a.md', text: '# DEMO-99 Referral status\n' }).id, 'DEMO-99');
  assert.equal(RI.read({ name: 'DEMO-7 notes.md', text: '# Notes\n' }).id, 'DEMO-7');
  assert.equal(RI.read({ name: 'a.md', text: md('id: ABC-1', '# DEMO-99 x\n') }).id, 'ABC-1');
});

test('html export gives title, canonical url and page version from metadata', () => {
  const html = '<html><head><title>Quote edits &amp; referrals</title><link rel="canonical" href="https://wiki.example/p/2">'
    + '<meta name="confluence-page-version" content="12"></head><body><h1>Other</h1></body></html>';
  const r = RI.read({ name: 'p2.html', text: html });
  assert.equal(r.title, 'Quote edits & referrals');
  assert.equal(r.source, 'https://wiki.example/p/2');
  assert.equal(r.version, '12');
});

test('html falls back to the first h1 when there is no title', () => {
  assert.equal(RI.read({ name: 'x.html', text: '<body><h1>Only heading</h1></body>' }).title, 'Only heading');
});

test('with no page version the version is a hash of the text, stable and sensitive to edits', () => {
  const a = RI.read({ name: 'a.md', text: '# T\n\nOne.\n' });
  const same = RI.read({ name: 'a.md', text: '# T\r\n\r\nOne.\r\n' });
  const edited = RI.read({ name: 'a.md', text: '# T\n\nTwo.\n' });
  assert.match(a.version, /^[0-9a-f]{16}$/);
  assert.equal(a.version, same.version);
  assert.notEqual(a.version, edited.version);
});

test('a page with no title is unparseable and says why', () => {
  const r = RI.read({ name: 'empty.md', text: 'just text\n' });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /no title/);
});

test('a file that is not html or markdown is refused by name', () => {
  const r = RI.read({ name: 'x.pdf', text: '%PDF' });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /\.html or \.md/);
});

test('plan: new, unchanged and changed against existing requirements', () => {
  const files = [
    { name: 'DEMO-1.md', text: md('title: One\nversion: 1') },
    { name: 'DEMO-2.md', text: md('title: Two\nversion: 3') },
    { name: 'DEMO-3.md', text: md('title: Three\nversion: 1') },
  ];
  const existing = [{ id: 'DEMO-2', version: 3 }, { id: 'DEMO-3', version: 1 }];
  existing[1].version = 0;
  const p = RI.plan(files, { existing });
  assert.deepEqual(p.items.map(i => [i.id, i.status]), [['DEMO-1', 'new'], ['DEMO-2', 'unchanged'], ['DEMO-3', 'changed']]);
  assert.equal(p.items[2].from, '0');
});

test('plan: no key means a slug of the title, made unique against existing ids and the batch', () => {
  const files = [
    { name: 'a.md', text: '# Quote edits are kept\n' },
    { name: 'b.md', text: '# Quote edits are kept\n\nDifferent body\n' },
  ];
  const p = RI.plan(files, { existing: [] });
  assert.deepEqual(p.items.map(i => i.id), ['quote-edits-are-kept', 'quote-edits-are-kept-2']);
});

test('plan: a repeated key in the batch is a problem and only the first is imported', () => {
  const files = [
    { name: 'DEMO-1 a.md', text: md('title: A') },
    { name: 'DEMO-1 b.md', text: md('title: B') },
  ];
  const p = RI.plan(files, { existing: [] });
  assert.equal(p.items.filter(i => i.status === 'new').length, 1);
  assert.equal(p.items.find(i => i.status === 'invalid').problems[0].includes('DEMO-1'), true);
});

test('plan: unparseable pages are listed as invalid and counted, not dropped', () => {
  const p = RI.plan([{ name: 'bad.md', text: 'no heading' }, { name: 'ok.md', text: '# Fine\n' }], { existing: [] });
  assert.deepEqual(p.summary, { new: 1, unchanged: 0, changed: 0, invalid: 1 });
});

test('toYaml writes only id, title, source, version and an empty elements list, never page text', () => {
  const [item] = RI.plan([{ name: 'DEMO-5.md', text: md('title: Referral: keep edits\nsource: https://w/x\nversion: 2', '# H\n\nSECRET BODY\n') }], { existing: [] }).items;
  const y = RI.toYaml(item);
  assert.equal(y.includes('SECRET'), false);
  assert.match(y, /^id: DEMO-5\n/);
  assert.match(y, /title: "Referral: keep edits"/);
  assert.match(y, /elements: \[\]\n$/);
});

test('toYaml keeps existing elements when a changed page is updated', () => {
  const [item] = RI.plan([{ name: 'DEMO-5.md', text: md('title: T\nversion: 9') }], { existing: [{ id: 'DEMO-5', version: 1 }] }).items;
  assert.match(RI.toYaml(item, { elements: ['Quotes DB'] }), /elements: \["Quotes DB"\]/);
});

test('plan: a page with no key that was imported before keeps its id by source, so a re-import is not renamed', () => {
  const files = [{ name: 'a.md', text: md('title: Quote edits are kept\nsource: https://w/p/1\nversion: 2') }];
  const p = RI.plan(files, { existing: [{ id: 'quote-edits-are-kept', version: 1, source: 'https://w/p/1' }] });
  assert.deepEqual([p.items[0].id, p.items[0].status], ['quote-edits-are-kept', 'changed']);
});

test('plan: an id that is not safe as a file name is invalid, never written to a path', () => {
  const p = RI.plan([{ name: 'a.md', text: md('id: ../../etc/x\ntitle: T') }], { existing: [] });
  assert.equal(p.items[0].status, 'invalid');
  assert.match(p.items[0].problems[0], /file name/);
});

test('setElements changes only the elements line, in flow or block form, and keeps title, source and version', () => {
  const flow = 'id: DEMO-5\ntitle: "T"\nsource: "https://w/x"\nversion: 2\nelements: []\n';
  assert.equal(RI.setElements(flow, ['Quotes DB', 'Rating API']), 'id: DEMO-5\ntitle: "T"\nsource: "https://w/x"\nversion: 2\nelements: ["Quotes DB","Rating API"]\n');
  const block = 'id: R\ntitle: T\nelements:\n  - Old\n  - Older\nversion: 3\n';
  assert.equal(RI.setElements(block, ['New']), 'id: R\ntitle: T\nelements: ["New"]\nversion: 3\n');
  assert.equal(RI.setElements('id: R\ntitle: T\n', ['A']), 'id: R\ntitle: T\nelements: ["A"]\n');
});

test('setElements refuses a shape it cannot edit safely and an empty or non-string list', () => {
  assert.equal(RI.setElements('id: R\nelements: &x [a]\n', ['A']), null);
  assert.equal(RI.setElements('id: R\nelements: []\n', []), null);
  assert.equal(RI.setElements('id: R\nelements: []\n', ['A', 3]), null);
});

const jmd = (jira, id = 'ZZ-1') => ({ name: `${id}.md`, text: md(`id: ${id}\ntitle: Thing ${id}\nsource: https://j.example/browse/${id}\nversion: 1\njira: ${JSON.stringify(jira)}`) });
const mapping = { labels: { 'lbl-hot': { risk: 'high', data_class: 'pii' }, 'lbl-low': { risk: 'low' } }, components: { 'comp-x': { repo: 'repo-x' } } };

test('mapJira applies the mapping, takes the highest risk, and lists what it did not map', () => {
  const r = RI.mapJira({ labels: ['lbl-low', 'lbl-hot', 'lbl-new'], components: ['comp-x', 'comp-new'] }, mapping);
  assert.deepEqual(r.fields, { risk: 'high', data_class: 'pii', repo: 'repo-x' });
  assert.deepEqual(r.unmapped, ['lbl-new', 'comp-new']);
});

test('a missing, empty or malformed mapping maps nothing and everything is unmapped, never an error', () => {
  for (const m of [undefined, null, {}, 'junk', { labels: 3, components: [] }]) {
    const r = RI.mapJira({ labels: ['a'], components: ['b'] }, m);
    assert.deepEqual(r.fields, {});
    assert.deepEqual(r.unmapped, ['a', 'b']);
  }
});

test('plan carries the mapped fields and counts unmapped names once; toYaml writes them with the raw jira block', () => {
  const p = RI.plan([jmd({ type: 'Story', labels: ['lbl-hot', 'lbl-new'], components: [] }, 'ZZ-1'), jmd({ labels: ['lbl-new'], components: ['comp-x'] }, 'ZZ-2')], { mapping });
  assert.equal(p.unmappedNames, 1);
  assert.deepEqual(p.items[0].mapped, { risk: 'high', data_class: 'pii' });
  assert.deepEqual(p.items[1].mapped, { repo: 'repo-x' });
  const y = RI.toYaml(p.items[0]);
  assert.match(y, /^risk: high$/m);
  assert.match(y, /^data_class: pii$/m);
  assert.match(y, /^jira: \{"type":"Story","labels":\["lbl-hot","lbl-new"\],"components":\[\]\}$/m);
  assert.doesNotMatch(RI.toYaml(p.items[1]), /^risk:/m);
});

test('without a jira block or a mapping the written requirement is unchanged from before', () => {
  const p = RI.plan([{ name: 'a.md', text: md('id: ZZ-3\ntitle: Plain\nsource: s\nversion: 1') }]);
  assert.equal(p.unmappedNames, 0);
  assert.equal(RI.toYaml(p.items[0]), 'id: ZZ-3\ntitle: Plain\nsource: "s"\nversion: 1\nelements: []\n');
});

test('the optional mapped fields on a requirement are validated the same in the JS and Python records', () => {
  const R = require('../renderer/records.js');
  assert.deepEqual(R.validate('requirement', { id: 'a', title: 't', risk: 'high', data_class: 'pii', repo: 'r', jira: { labels: [] } }), []);
  assert.deepEqual(R.validate('requirement', { id: 'a', title: 't', risk: '', jira: [] }), ['risk: must be a non-empty string', 'jira: must be a mapping']);
});
