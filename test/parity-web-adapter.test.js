'use strict';
// The web adapter in a real Chromium against a local page served over http. Skipped, with the reason, where Chromium
// cannot start.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const R = require('../recorder/index.js');
const Web = require('../recorder/adapters/web.js');

const dir = path.join(__dirname, '..', 'fixtures', 'parity-legacy');
const find = (n, role, name) => n.role === role && n.name === name ? n : (n.children || []).map(c => find(c, role, name)).find(Boolean) || null;
const has = (tree, text) => JSON.stringify(tree).includes(text);

let skip = false;
let server;
let baseUrl;
const posts = [];
test.before(async () => {
  try { await (await require('playwright-core').chromium.launch()).close(); }
  catch (e) { skip = `Chromium cannot start here: ${e.message.split('\n')[0]}`; return; }
  server = http.createServer((req, res) => {
    if (req.method === 'POST') { posts.push(req.url); res.end('{}'); return; }
    const page = new URL(req.url, 'http://x').pathname;
    if (page === '/sso') { res.statusCode = 302; res.setHeader('location', `http://localhost:${server.address().port}/tags.html`); res.end(); return; }
    if (page === '/login' || page === '/change') {
      res.setHeader('content-type', 'text/html');
      res.end(`<title>x</title><input type="password"><input ${page === '/change' ? 'type="password"' : 'type="hidden"'}>`);
      return;
    }
    const f = path.join(dir, path.basename(page));
    if (!fs.existsSync(f)) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', 'text/html'); res.end(fs.readFileSync(f));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
});
test.after(() => server && server.close());

const bulk = [
  { goto: { path: 'tags.html' } },
  { fill: { role: 'textbox', name: 'Program', value: { param: 'program' } } },
  { click: { role: 'button', name: 'Bulk apply' } },
  { fill: { role: 'textbox', name: 'Tag', value: 'Q1' } },
  { click: { role: 'button', name: 'Apply' } },
];

test('records a real page: roles, names, values, boxes, test ids and a screenshot; a committing click is blocked', async t => {
  if (skip) return t.skip(skip);
  const r = await R.record({ adapter: Web.create(), side: 'legacy', params: { baseUrl, program: 'Alpha' }, scenario: { id: 'bulk', steps: bulk } });
  assert.deepStrictEqual(r.steps.map(s => s.status), ['ok', 'ok', 'ok', 'ok', 'blocked']);
  const first = r.steps[0].capture.tree;
  assert.strictEqual(first.role, 'RootWebArea');
  assert.ok(find(first, 'columnheader', 'Inception'));
  assert.ok(!find(first, 'dialog', 'Apply tag'), 'the hidden dialog is not in the tree');
  assert.ok(find(first, 'button', 'Export').disabled);
  const box = find(first, 'button', 'Bulk apply').box;
  assert.ok(box && box.w > 0 && box.h > 0);
  const search = find(r.steps[1].capture.tree, 'textbox', 'Program');
  assert.strictEqual(search.value, 'Alpha');
  assert.strictEqual(search.testId, 'program-search');
  assert.ok(find(r.steps[2].capture.tree, 'dialog', 'Apply tag'));
  assert.ok(r.steps[0].shot && r.shots[r.steps[0].shot].length > 1000);
});

test('the person running it can allow writes', async t => {
  if (skip) return t.skip(skip);
  const r = await R.record({ adapter: Web.create(), side: 'legacy', params: { baseUrl, program: 'Alpha' }, scenario: { id: 'bulk', steps: bulk },
    allowWrites: true, screenshots: false });
  assert.strictEqual(r.steps[4].status, 'ok');
  assert.ok(has(r.steps[4].capture.tree, 'Tag Q1 applied to 2 programs'));
});

test('read-only aborts a request that is not a read, whatever the button is called, and lists it', async t => {
  if (skip) return t.skip(skip);
  posts.length = 0;
  const steps = [{ goto: { path: 'tags.html' } }, { click: { role: 'button', name: 'Refresh' } }];
  const r = await R.record({ adapter: Web.create(), side: 'legacy', params: { baseUrl }, scenario: { id: 'r', steps }, screenshots: false });
  assert.deepStrictEqual(posts, [], 'the server never saw the POST');
  assert.deepStrictEqual(r.steps[1].capture.blockedRequests.map(b => b.method), ['POST']);
  assert.ok(has(r.steps[1].capture.tree, 'Could not refresh'));
  const ok = await R.record({ adapter: Web.create(), side: 'legacy', params: { baseUrl }, scenario: { id: 'r', steps }, screenshots: false,
    allowRequests: ['/api/refresh'] });
  assert.deepStrictEqual(posts, ['/api/refresh']);
  assert.ok(has(ok.steps[1].capture.tree, 'Refreshed'));
});

test('a login wall stops the scenario: a sign-in form, or a redirect to another host', async t => {
  if (skip) return t.skip(skip);
  const go = p => R.record({ adapter: Web.create(), side: 'legacy', params: { baseUrl }, scenario: { id: 'w', steps: [{ goto: { path: p } }] }, screenshots: false });
  const form = await go('login');
  assert.strictEqual(form.steps[0].status, 'could_not_run');
  assert.match(form.wall, /\/login asks for a password/);
  assert.match((await go('sso')).wall, /went to localhost, not 127\.0\.0\.1/);
  const two = await go('change');
  assert.strictEqual(two.steps[0].status, 'ok', 'two password fields is a form in the app, not a sign-in');
  assert.strictEqual(two.wall, undefined);
  assert.strictEqual((await go('tags.html')).wall, undefined);
});

test('an element the page does not have is could not run', async t => {
  if (skip) return t.skip(skip);
  const r = await R.record({ adapter: Web.create(), side: 'next', params: { baseUrl }, scenario: { id: 'x', steps: [
    { goto: { path: 'tags.html' } }, { click: { role: 'button', name: 'Edit', index: 3 } },
  ] }, screenshots: false });
  assert.deepStrictEqual(r.steps.map(s => s.status), ['ok', 'could_not_run']);
});
