// Agent Client Protocol (ACP) client: designc is the Client, any ACP agent (Claude Code, Codex,
// Gemini CLI, Copilot, a MAF host with an ACP adapter…) is the Agent. Speaks protocol v1:
// newline-delimited JSON-RPC 2.0 over the agent's stdio.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const PROTOCOL_VERSION = 1;

class AcpConnection {
  constructor({ key, command, args = [], env = {}, cwd, onUpdate, onRequest, onExit, onLog }) {
    Object.assign(this, { key, onUpdate, onRequest, onExit, onLog });
    this.nextId = 1; this.pending = new Map(); this.buf = '';
    this.proc = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', d => this.onData(d));
    this.proc.stderr.on('data', d => onLog && onLog(String(d)));
    this.proc.on('error', e => this.fail(e));
    this.proc.on('exit', code => this.fail(new Error(`agent exited (${code})`)));
  }
  fail(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    if (!this.dead) { this.dead = true; this.onExit && this.onExit(err); }
  }
  send(msg) { if (!this.dead) this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.send({ id, method, params }); });
  }
  notify(method, params) { this.send({ method, params }); }
  onData(chunk) {
    this.buf += chunk; let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim(); this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { this.onLog && this.onLog(`[non-JSON] ${line}\n`); continue; }
      if (msg.id != null && (msg.result !== undefined || msg.error) && !msg.method) {
        const p = this.pending.get(msg.id); if (!p) continue; this.pending.delete(msg.id);
        msg.error ? p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, data: msg.error.data })) : p.resolve(msg.result);
      } else if (msg.method === 'session/update') this.onUpdate && this.onUpdate(msg.params);
      else if (msg.method && msg.id != null) {
        Promise.resolve(this.onRequest(msg.method, msg.params || {}))
          .then(result => this.send({ id: msg.id, result: result === undefined ? null : result }))
          .catch(e => this.send({ id: msg.id, error: { code: e.code || -32000, message: e.message } }));
      } // other notifications are ignored
    }
  }
  kill() { try { this.proc.kill(); } catch { /* already gone */ } }
}

// Manages one connection per configured agent and routes agent→client requests.
class AcpHub {
  constructor({ getRoot, getCodebase, mcpServer, ui }) {
    Object.assign(this, { getRoot, getCodebase, mcpServer, ui });
    this.conns = new Map();
  }
  // Paths the agent may read: the registry and the configured codebase. Writes go to the UI for policy.
  readable(abs) {
    const roots = [this.getRoot(), this.getCodebase()].filter(Boolean).map(r => path.resolve(r));
    const p = path.resolve(abs);
    return roots.some(r => p === r || p.startsWith(r + path.sep));
  }
  async connect(key, spec, sessionMeta) {
    const existing = this.conns.get(key);
    if (existing && !existing.conn.dead) return existing.info;
    const root = this.getRoot();
    const conn = new AcpConnection({
      key, command: spec.command, args: spec.args || [], env: spec.env || {}, cwd: root,
      onUpdate: p => this.ui('acp:update', key, p),
      onLog: t => this.ui('acp:log', key, t),
      onExit: e => { this.conns.delete(key); this.ui('acp:exit', key, e.message); },
      onRequest: (m, p) => this.handle(key, m, p),
    });
    const init = await withTimeout(conn.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: 'designc', title: 'designc', version: '0.1.0' },
    }), 60000, 'initialize');
    if (init.authMethods && init.authMethods.length && spec.authMethod) await conn.request('authenticate', { methodId: spec.authMethod });
    const session = await withTimeout(conn.request('session/new', { cwd: root, mcpServers: [this.mcpServer(sessionMeta)] }), 60000, 'session/new');
    const info = { key, sessionId: session.sessionId, agent: init.agentInfo || null, protocolVersion: init.protocolVersion,
      modes: session.modes || null, authMethods: (init.authMethods || []).map(a => a.name || a.id) };
    this.conns.set(key, { conn, info });
    return info;
  }
  async prompt(key, text) {
    const c = this.conns.get(key); if (!c) throw new Error('Agent is not connected');
    return c.conn.request('session/prompt', { sessionId: c.info.sessionId, prompt: [{ type: 'text', text }] });
  }
  cancel(key) { const c = this.conns.get(key); if (c) c.conn.notify('session/cancel', { sessionId: c.info.sessionId }); }
  disconnect(key) { const c = this.conns.get(key); if (c) { c.conn.kill(); this.conns.delete(key); } }
  disconnectAll() { for (const k of [...this.conns.keys()]) this.disconnect(k); }

  async handle(key, method, p) {
    if (method === 'fs/read_text_file') {
      if (!path.isAbsolute(p.path) || !this.readable(p.path)) throw Object.assign(new Error(`designc only lets agents read the registry and the codebase, not ${p.path}`), { code: -32001 });
      let text = await fsp.readFile(p.path, 'utf8');
      if (p.line || p.limit) { const lines = text.split('\n'); const s = Math.max(0, (p.line || 1) - 1); text = lines.slice(s, p.limit ? s + p.limit : undefined).join('\n'); }
      return { content: text };
    }
    if (method === 'fs/write_text_file') {
      // Policy and the diff approval live in the UI; it answers {ok} or {error}.
      let old = null; try { old = await fsp.readFile(p.path, 'utf8'); } catch { /* new file */ }
      const r = await this.ui('acp:write', key, { path: p.path, content: p.content, old });
      if (!r || !r.ok) throw Object.assign(new Error(r && r.error ? r.error : 'The user declined this write.'), { code: -32002 });
      await fsp.mkdir(path.dirname(p.path), { recursive: true });
      await fsp.writeFile(p.path, p.content, 'utf8');
      return null;
    }
    if (method === 'session/request_permission') {
      const r = await this.ui('acp:permission', key, p);
      return { outcome: r && r.optionId ? { outcome: 'selected', optionId: r.optionId } : { outcome: 'cancelled' } };
    }
    throw Object.assign(new Error(`designc does not support ${method}`), { code: -32601 });
  }
}

function withTimeout(promise, ms, what) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);
}

module.exports = { AcpHub, PROTOCOL_VERSION };
