const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const RI = require('../renderer/requirement-import.js');

const script = path.join(__dirname, '..', 'scripts', 'fetch-confluence.py');

const pages = {
  '100': { id: '100', title: 'HRE-100 Quote edits & referrals', version: { number: 7 }, _links: { webui: '/pages/viewpage.action?pageId=100' },
    body: '<p>SECRET BODY</p><ac:structured-macro ac:name="info"><ac:rich-text-body><p>note</p></ac:rich-text-body></ac:structured-macro>' },
  '101': { id: '101', title: 'Child page', version: { number: 2 }, body: '<p>child</p>' },
};

function serve(seen) {
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const u = new URL(req.url, 'http://x');
    const m = /^\/rest\/api\/content\/(\d+)(\/descendant\/page)?$/.exec(u.pathname);
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!m) return send(404, {});
    if (m[2]) return send(200, { results: m[1] === '100' ? [{ id: '101' }] : [] });
    const p = pages[m[1]];
    if (!p) return send(404, { message: 'SECRET missing' });
    send(200, { id: p.id, title: p.title, version: p.version, _links: { ...p._links, base: `http://127.0.0.1:${server.address().port}` },
      body: { storage: { value: p.body } } });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

function run(args, env) {
  return new Promise(resolve => {
    const p = spawn('python3', ['-I', script, ...args], { env: { PATH: process.env.PATH, ...env } });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', code => resolve({ code, out }));
  });
}

test('a page is saved as html the importer reads, with GET only and a Bearer token, and the report has no page text', async () => {
  const seen = [];
  const server = await serve(seen);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'conf-')), 'pages');
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await run([base, out, '100', '999'], { CONFLUENCE_TOKEN: 'tok-123' });
  server.close();
  assert.match(r.out, /saved 1, skipped 1/);
  assert.match(r.out, /skipped 999: HTTP 404/);
  assert.equal(/SECRET|tok-123/.test(r.out), false);
  assert.equal(seen.every(s => s.method === 'GET' && s.auth === 'Bearer tok-123'), true);
  const text = fs.readFileSync(path.join(out, '100.html'), 'utf8');
  assert.match(text, /SECRET BODY/);
  const read = RI.read({ name: '100.html', text });
  assert.equal(read.ok, true);
  assert.equal(read.title, 'HRE-100 Quote edits & referrals');
  assert.equal(read.id, 'HRE-100');
  assert.equal(read.version, '7');
  assert.equal(read.source, `${base}/pages/viewpage.action?pageId=100`);
});

test('--descendants also saves the pages below, once each', async () => {
  const seen = [];
  const server = await serve(seen);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'conf-')), 'pages');
  const r = await run([`http://127.0.0.1:${server.address().port}`, out, '100', '101', '--descendants'], { CONFLUENCE_TOKEN: 't' });
  server.close();
  assert.match(r.out, /saved 2, skipped 0/);
  assert.deepEqual(fs.readdirSync(out).sort(), ['100.html', '101.html']);
});

test('basic auth is used when a user variable is set', async () => {
  const seen = [];
  const server = await serve(seen);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'conf-')), 'pages');
  await run([`http://127.0.0.1:${server.address().port}`, out, '101'], { CONFLUENCE_TOKEN: 'api', CONFLUENCE_USER: 'me@example.com' });
  server.close();
  assert.equal(seen[0].auth, 'Basic ' + Buffer.from('me@example.com:api').toString('base64'));
});

test('refuses a missing token, a plain-http remote host and a page id that is not a number', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-'));
  assert.equal((await run(['https://wiki.example.com', d, '1'], {})).code, 2);
  assert.equal((await run(['http://wiki.example.com', d, '1'], { CONFLUENCE_TOKEN: 't' })).code, 2);
  assert.equal((await run(['https://wiki.example.com', d, '../x'], { CONFLUENCE_TOKEN: 't' })).code, 2);
});
