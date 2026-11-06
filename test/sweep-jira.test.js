const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const jsyaml = require('js-yaml');

const script = path.join(__dirname, '..', 'scripts', 'sweep-jira.py');
const issues = {
  'ZZ-1': { summary: 'New thing one', issuetype: { name: 'Story' }, labels: ['lbl-a'], components: [{ name: 'comp-a' }], priority: { name: 'High' }, description: 'SECRET BODY' },
  'ZZ-2': { summary: 'Already in work', issuetype: { name: 'Bug' }, labels: [], components: [] },
  'ZZ-3': { summary: 'Already in the inbox', issuetype: { name: 'Task' }, labels: [], components: [] },
  'ZZ-4': { summary: 'Dismissed before', issuetype: { name: 'Task' }, labels: [], components: [] },
  'ZZ-5': { summary: 'Colon: "quoted" title', issuetype: { name: 'Task' }, labels: [], components: [] },
};

function serve(seen) {
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const u = new URL(req.url, 'http://x');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (u.pathname === '/rest/api/2/search') {
      return res.end(JSON.stringify({ total: Object.keys(issues).length, issues: Object.keys(issues).map(key => ({ key, fields: issues[key] })) }));
    }
    res.end('{}');
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

const registry = () => {
  const reg = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  fs.mkdirSync(path.join(reg, 'work')); fs.mkdirSync(path.join(reg, 'inbox/dismissed'), { recursive: true });
  fs.writeFileSync(path.join(reg, 'work/W-x.yaml'), 'id: W-x\ntitle: x\ntarget: { jira: "ZZ-2" }\n');
  fs.writeFileSync(path.join(reg, 'inbox/ZZ-3.yaml'), 'id: ZZ-3\ntitle: keep me\n');
  fs.writeFileSync(path.join(reg, 'inbox/dismissed/ZZ-4.yaml'), 'id: ZZ-4\ntitle: no\n');
  return reg;
};

test('a sweep writes an inbox entry only for issues not already in work, the inbox or dismissed; GET only; no text printed', async () => {
  const seen = [];
  const server = await serve(seen);
  const reg = registry();
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await run([base, reg], { JIRA_TOKEN: 'tok-1' });
  server.close();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /swept 2 new, 3 already tracked/);
  assert.equal(/SECRET|tok-1|New thing/.test(r.out), false);
  assert.equal(seen.every(s => s.method === 'GET' && s.auth === 'Bearer tok-1'), true);
  assert.deepEqual(fs.readdirSync(path.join(reg, 'inbox')).sort(), ['ZZ-1.yaml', 'ZZ-3.yaml', 'ZZ-5.yaml', 'dismissed']);
  assert.equal(fs.readFileSync(path.join(reg, 'inbox/ZZ-3.yaml'), 'utf8'), 'id: ZZ-3\ntitle: keep me\n', 'an existing entry is untouched');
  const o = jsyaml.load(fs.readFileSync(path.join(reg, 'inbox/ZZ-1.yaml'), 'utf8'));
  assert.equal(o.id, 'ZZ-1');
  assert.equal(o.title, 'New thing one');
  assert.deepEqual(o.target, { jira: 'ZZ-1' });
  assert.deepEqual(o.jira, { type: 'Story', labels: ['lbl-a'], components: ['comp-a'], priority: 'High' });
  assert.match(fs.readFileSync(path.join(reg, 'inbox/ZZ-1.yaml'), 'utf8'), /^swept: \d{4}-\d{2}-\d{2}$/m);
  assert.equal(fs.readFileSync(path.join(reg, 'inbox/ZZ-1.yaml'), 'utf8').includes('SECRET'), false, 'the description is never copied');
  assert.equal(jsyaml.load(fs.readFileSync(path.join(reg, 'inbox/ZZ-5.yaml'), 'utf8')).title, 'Colon: "quoted" title');
});

test('the default query is assignee-based and recent, and --jql replaces it', async () => {
  for (const [args, want] of [[[], /assignee%20%3D%20currentUser%28%29|assignee\+%3D\+currentUser%28%29/], [['--jql', 'project = QQ'], /project\+%3D\+QQ|project%20%3D%20QQ/]]) {
    const seen = [];
    const server = await serve(seen);
    await run([`http://127.0.0.1:${server.address().port}`, registry(), ...args], { JIRA_TOKEN: 't' });
    server.close();
    assert.match(seen[0].url, want);
    if (!args.length) assert.match(decodeURIComponent(seen[0].url.replace(/\+/g, ' ')), /created >= -1d\) OR updated >= -1d|created >= -1d OR updated >= -1d/);
  }
});

test('a missing token or a non-https base url is refused before any request', async () => {
  assert.equal((await run(['https://x.example', os.tmpdir()], {})).code, 2);
  assert.equal((await run(['http://x.example', os.tmpdir()], { JIRA_TOKEN: 't' })).code, 2);
});
