// Integrated terminal, main process. Human only: no agent tool, ACP request or MCP call reaches it.
// node-pty is passed in so tests can use a fake; main.js passes the real one.

function shellFor(platform, env) {
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] };
  return { file: env.SHELL || '/bin/bash', args: ['-l'] };
}

const size = (n, dflt) => (Number.isInteger(n) && n >= 2 && n <= 1000 ? n : dflt);

class Terminals {
  constructor(pty, { platform = process.platform } = {}) { this.pty = pty; this.platform = platform; this.live = new Map(); this.seq = 0; }

  // The shell starts in cwd with env as given (the user's own environment, by their choice) and TERM set for xterm.js.
  open({ cwd, env, cols, rows, onData, onExit }) {
    const { file, args } = shellFor(this.platform, env);
    const p = this.pty.spawn(file, args, { name: 'xterm-256color', cwd, env: { ...env, TERM: 'xterm-256color' }, cols: size(cols, 80), rows: size(rows, 24) });
    const id = ++this.seq;
    this.live.set(id, p);
    p.onData(s => onData(s));
    p.onExit(e => { this.live.delete(id); onExit(e && e.exitCode); });
    return id;
  }

  input(id, s) { const p = this.live.get(id); if (!p || typeof s !== 'string') return false; p.write(s); return true; }

  resize(id, cols, rows) {
    const p = this.live.get(id); if (!p) return false;
    const c = size(cols, 0), r = size(rows, 0);
    if (c && r) p.resize(c, r);
    return true;
  }

  close(id) { const p = this.live.get(id); if (!p) return false; this.live.delete(id); try { p.kill(); } catch { /* already gone */ } return true; }
  closeAll() { for (const id of [...this.live.keys()]) this.close(id); }
  count() { return this.live.size; }
}

module.exports = { shellFor, Terminals };
