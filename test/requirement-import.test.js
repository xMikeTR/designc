const { test } = require('node:test');
const assert = require('node:assert/strict');
const RI = require('../renderer/requirement-import.js');

const md = (front, body = '# Heading\n\nText.\n') => `---\n${front}\n---\n${body}`;

test('markdown front matter gives id, title, source and version', () => {
  const r = RI.read({ name: 'page.md', text: md('id: HRE-12\ntitle: Quote edits are kept\nsource: https://wiki.example/p/1\nversion: 4') });
  assert.deepEqual(r, { ok: true, id: 'HRE-12', title: 'Quote edits are kept', source: 'https://wiki.example/p/1', version: '4', problems: [] });
});

test('markdown without front matter takes the first heading as title and the file name as source', () => {
  const r = RI.read({ name: 'quote-edits.md', text: '# Quote edits are kept\n\nBody.\n' });
  assert.equal(r.title, 'Quote edits are kept');
  assert.equal(r.source, 'quote-edits.md');
  assert.equal(r.id, null);
});

test('a Jira-style key in the title or file name becomes the id, front matter wins', () => {
  assert.equal(RI.read({ name: 'a.md', text: '# HRE-99 Referral status\n' }).id, 'HRE-99');
  assert.equal(RI.read({ name: 'HRE-7 notes.md', text: '# Notes\n' }).id, 'HRE-7');
  assert.equal(RI.read({ name: 'a.md', text: md('id: ABC-1', '# HRE-99 x\n') }).id, 'ABC-1');
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
    { name: 'HRE-1.md', text: md('title: One\nversion: 1') },
    { name: 'HRE-2.md', text: md('title: Two\nversion: 3') },
    { name: 'HRE-3.md', text: md('title: Three\nversion: 1') },
  ];
  const existing = [{ id: 'HRE-2', version: 3 }, { id: 'HRE-3', version: 1 }];
  existing[1].version = 0;
  const p = RI.plan(files, { existing });
  assert.deepEqual(p.items.map(i => [i.id, i.status]), [['HRE-1', 'new'], ['HRE-2', 'unchanged'], ['HRE-3', 'changed']]);
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
    { name: 'HRE-1 a.md', text: md('title: A') },
    { name: 'HRE-1 b.md', text: md('title: B') },
  ];
  const p = RI.plan(files, { existing: [] });
  assert.equal(p.items.filter(i => i.status === 'new').length, 1);
  assert.equal(p.items.find(i => i.status === 'invalid').problems[0].includes('HRE-1'), true);
});

test('plan: unparseable pages are listed as invalid and counted, not dropped', () => {
  const p = RI.plan([{ name: 'bad.md', text: 'no heading' }, { name: 'ok.md', text: '# Fine\n' }], { existing: [] });
  assert.deepEqual(p.summary, { new: 1, unchanged: 0, changed: 0, invalid: 1 });
});

test('toYaml writes only id, title, source, version and an empty elements list, never page text', () => {
  const [item] = RI.plan([{ name: 'HRE-5.md', text: md('title: Referral: keep edits\nsource: https://w/x\nversion: 2', '# H\n\nSECRET BODY\n') }], { existing: [] }).items;
  const y = RI.toYaml(item);
  assert.equal(y.includes('SECRET'), false);
  assert.match(y, /^id: HRE-5\n/);
  assert.match(y, /title: "Referral: keep edits"/);
  assert.match(y, /elements: \[\]\n$/);
});

test('toYaml keeps existing elements when a changed page is updated', () => {
  const [item] = RI.plan([{ name: 'HRE-5.md', text: md('title: T\nversion: 9') }], { existing: [{ id: 'HRE-5', version: 1 }] }).items;
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
