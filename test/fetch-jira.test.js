const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const RI = require('../renderer/requirement-import.js');

const script = path.join(__dirname, '..', 'scripts', 'fetch-jira.py');

const issues = {
  'HRE-100': { summary: 'Quote edits:  keep\nunderwriter changes', description: 'SECRET BODY\r\nh2. Acceptance', updated: '2026-10-01T10:00:00.000+0000' },
  'HRE-101': { summary: 'Referral status', description: null, updated: '2026-10-02T09:00:00.000+0000' },
};

function serve(seen, { cloud } = {}) {
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const u = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const m = /^\/rest\/api\/2\/issue\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const f = issues[decodeURIComponent(m[1])];
      return f ? send(200, { key: decodeURIComponent(m[1]), fields: f }) : send(404, { errorMessages: ['SECRET missing'] });
    }
    const keys = Object.keys(issues);
    if (u.pathname === '/rest/api/2/search' && !cloud) {
      const start = Number(u.searchParams.get('startAt'));
      return send(200, { total: keys.length, issues: keys.slice(start, start + 1).map(key => ({ key })) });
    }
    if (u.pathname === '/rest/api/2/search/jql' && cloud) {
      const i = Number(u.searchParams.get('nextPageToken') || 0);
      return send(200, { issues: [{ key: keys[i] }], ...(i + 1 < keys.length ? { nextPageToken: String(i + 1) } : { isLast: true }) });
    }
    send(cloud ? 410 : 404, {});
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

test('an issue is saved as markdown the importer reads, with GET only and a Bearer token, and the report has no issue text', async () => {
  const seen = [];
  const server = await serve(seen);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jira-')), 'issues');
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await run([base, out, 'HRE-100', 'HRE-999'], { JIRA_TOKEN: 'tok-123' });
  server.close();
  assert.match(r.out, /saved 1, skipped 1/);
  assert.match(r.out, /skipped HRE-999: HTTP 404/);
  assert.equal(/SECRET|tok-123/.test(r.out), false);
  assert.equal(seen.every(s => s.method === 'GET' && s.auth === 'Bearer tok-123'), true);
  const text = fs.readFileSync(path.join(out, 'HRE-100.md'), 'utf8');
  assert.match(text, /SECRET BODY/);
  const read = RI.read({ name: 'HRE-100.md', text });
  assert.equal(read.ok, true);
  assert.equal(read.id, 'HRE-100');
  assert.equal(read.title, 'Quote edits: keep underwriter changes');
  assert.equal(read.version, '2026-10-01T10:00:00.000+0000');
  assert.equal(read.source, `${base}/browse/HRE-100`);
});

test('a JQL query saves every issue it finds, once each, on Data Center and on Cloud', async () => {
  for (const cloud of [false, true]) {
    const seen = [];
    const server = await serve(seen, { cloud });
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jira-')), 'issues');
    const r = await run([`http://127.0.0.1:${server.address().port}`, out, 'HRE-101', '--jql', 'project = HRE AND component = Quotes'], { JIRA_TOKEN: 't' });
    server.close();
    assert.match(r.out, /saved 2, skipped 0/, `cloud=${cloud}`);
    assert.deepEqual(fs.readdirSync(out).sort(), ['HRE-100.md', 'HRE-101.md']);
    assert.equal(RI.read({ name: 'HRE-101.md', text: fs.readFileSync(path.join(out, 'HRE-101.md'), 'utf8') }).ok, true);
  }
});

test('--max stops the query and says so', async () => {
  const seen = [];
  const server = await serve(seen);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jira-')), 'issues');
  const r = await run([`http://127.0.0.1:${server.address().port}`, out, '--jql', 'project = HRE', '--max', '1'], { JIRA_TOKEN: 't' });
  server.close();
  assert.match(r.out, /saved 1, skipped 1/);
  assert.match(r.out, /stopped at --max 1/);
});

test('basic auth is used when a user variable is set', async () => {
  const seen = [];
  const server = await serve(seen);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jira-')), 'issues');
  await run([`http://127.0.0.1:${server.address().port}`, out, 'HRE-101'], { JIRA_TOKEN: 'api', JIRA_USER: 'me@example.com' });
  server.close();
  assert.equal(seen[0].auth, 'Basic ' + Buffer.from('me@example.com:api').toString('base64'));
});

test('refuses a missing token, a plain-http remote host, a bad key and nothing to fetch', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-'));
  assert.equal((await run(['https://jira.example.com', d, 'HRE-1'], {})).code, 2);
  assert.equal((await run(['http://jira.example.com', d, 'HRE-1'], { JIRA_TOKEN: 't' })).code, 2);
  assert.equal((await run(['https://jira.example.com', d, '../x'], { JIRA_TOKEN: 't' })).code, 2);
  assert.equal((await run(['https://jira.example.com', d], { JIRA_TOKEN: 't' })).code, 2);
});
