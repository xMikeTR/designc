'use strict';
// Parity.requests: a HAR as endpoint and payload shapes only (docs/parity-contract.md, "Requests").
const test = require('node:test');
const assert = require('node:assert');
const Parity = require('../renderer/parity.js');

const entry = (method, url, { status = 200, req, res, mime = 'application/json', type } = {}) => ({
  ...(type ? { _resourceType: type } : {}),
  request: { method, url, ...(req === undefined ? {} : { postData: { mimeType: 'application/json', text: typeof req === 'string' ? req : JSON.stringify(req) } }) },
  response: { status, content: { mimeType: mime, ...(res === undefined ? {} : { text: typeof res === 'string' ? res : JSON.stringify(res) }) } },
});
const har = (...entries) => ({ log: { version: '1.2', entries } });
const BASE = 'http://legacy.test:8080/';

test('keeps method, path, status and shapes; an array is its first record; values never appear', () => {
  const r = Parity.requests(har(
    entry('GET', 'http://legacy.test:8080/api/bordereaux?page=2&q=Nordic', { res: [{ Cedant: 'Nordic Marine', Lines: 188, Premium: '$964,500', Received: '2026-10-04', ok: true, note: null }, { Cedant: 'Other' }] }),
    entry('POST', 'http://legacy.test:8080/api/bordereaux/17/notes', { status: 201, req: { text: 'Secret text', n: 1000 }, res: { id: 99 } }),
  ), { baseUrl: BASE });
  assert.deepStrictEqual(r, [
    { method: 'GET', path: '/api/bordereaux', status: 200, request: null,
      response: [{ Cedant: 'text:Aa', Lines: 'num:?0', Premium: 'num:$#,##0', Received: 'date:dddd-dd-0d', ok: 'bool', note: 'null' }] },
    { method: 'POST', path: '/api/bordereaux/:id/notes', status: 201, request: { text: 'text:Aa', n: 'num:0' }, response: { id: 'num:?0' } },
  ]);
  const s = JSON.stringify(r);
  for (const v of ['Nordic', 'Secret', '964', 'page=2', '/17']) assert.ok(!s.includes(v), `${v} leaked`);
});

test('numeric and uuid path segments become :id; empty arrays and bodies are kept as such', () => {
  const r = Parity.requests(har(
    entry('GET', 'http://legacy.test:8080/api/x/3f2a9c1d-5e7b-4a0c-9d6e-8f0a1b2c3d4e', { res: [] }),
    entry('DELETE', 'http://legacy.test:8080/api/x/5', { status: 204 }),
  ), { baseUrl: BASE });
  assert.deepStrictEqual(r.map(x => [x.method, x.path, x.status, x.request, x.response]), [
    ['GET', '/api/x/:id', 200, null, []], ['DELETE', '/api/x/:id', 204, null, null]]);
});

test('other hosts, static assets and the page itself are dropped; identical entries are listed once', () => {
  const r = Parity.requests(har(
    entry('GET', 'http://legacy.test:8080/', { mime: 'text/html', res: '<html>', type: 'document' }),
    entry('GET', 'http://legacy.test:8080/app.js', { mime: 'text/javascript', res: 'x', type: 'script' }),
    entry('GET', 'http://other.test/api/a', { res: {} }),
    entry('GET', 'http://legacy.test:8080/api/a', { res: { a: 'x' } }),
    entry('GET', 'http://legacy.test:8080/api/a', { res: { a: 'y' } }),
    entry('GET', 'http://legacy.test:8080/api/b', { type: 'fetch', mime: 'text/plain', res: 'Hello' }),
  ), { baseUrl: BASE });
  assert.deepStrictEqual(r.map(x => `${x.method} ${x.path}`), ['GET /api/a', 'GET /api/b']);
  assert.strictEqual(r[1].response, 'text:Aa');
});

test('a base64 body is decoded; an unparsable body is a text shape; no log is no requests', () => {
  const b64 = Buffer.from(JSON.stringify({ k: 'v' })).toString('base64');
  const e = entry('GET', 'http://legacy.test:8080/api/c');
  e.response.content = { mimeType: 'application/json', text: b64, encoding: 'base64' };
  assert.deepStrictEqual(Parity.requests(har(e), { baseUrl: BASE })[0].response, { k: 'text:A?' });
  assert.strictEqual(Parity.requests(har(entry('GET', 'http://legacy.test:8080/api/d', { res: '{bad' })), { baseUrl: BASE })[0].response, 'text:aa');
  assert.deepStrictEqual(Parity.requests({}, { baseUrl: BASE }), []);
  assert.deepStrictEqual(Parity.requests(null, { baseUrl: BASE }), []);
});
