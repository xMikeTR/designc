// A minimal LSP client over a child's stdio (Content-Length framing). Test-only.
const { spawn } = require('child_process');

function start(args, { cwd } = {}) {
  const child = spawn(process.execPath, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = Buffer.alloc(0), id = 0;
  const pending = new Map(), seen = [], waiters = [];
  child.stderr.on('data', () => {});
  child.stdout.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const sep = buf.indexOf('\r\n\r\n'); if (sep < 0) return;
      const m = /Content-Length: (\d+)/i.exec(buf.slice(0, sep).toString()); if (!m) return;
      const len = Number(m[1]), end = sep + 4 + len; if (buf.length < end) return;
      const msg = JSON.parse(buf.slice(sep + 4, end).toString('utf8')); buf = buf.slice(end);
      if (msg.id !== undefined && !msg.method && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
      else {
        if (msg.id !== undefined && msg.method) send({ jsonrpc: '2.0', id: msg.id, result: null }); // answer server->client requests (registerCapability, ...)
        seen.push(msg); for (const w of [...waiters]) w();
      }
    }
  });
  const send = o => { const s = Buffer.from(JSON.stringify(o)); child.stdin.write(`Content-Length: ${s.length}\r\n\r\n`); child.stdin.write(s); };
  const exited = new Promise(res => child.on('exit', (code, sig) => res({ code, sig })));
  return {
    child, exited, seen,
    request: (method, params) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); send({ jsonrpc: '2.0', id: i, method, params }); }),
    notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
    // The first message (from the ones seen so far, in order, not yet consumed by `from`) matching method and predicate.
    waitFor(method, predicate = () => true, ms = 10000, from = 0) {
      return new Promise((resolve, reject) => {
        const look = () => { const i = seen.findIndex((m, k) => k >= from && m.method === method && predicate(m.params)); return i < 0 ? null : seen[i]; };
        const hit = look(); if (hit) return resolve(hit.params);
        const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`timed out waiting for ${method}`)); }, ms);
        const w = () => { const h = look(); if (h) { clearTimeout(t); waiters.splice(waiters.indexOf(w), 1); resolve(h.params); } };
        waiters.push(w);
      });
    },
    close: () => { child.kill(); },
  };
}
module.exports = { start };
