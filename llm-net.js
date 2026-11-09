// designc main process: calls to the anthropic and vertex providers. Node only, no Electron, like git.js.
// renderer/llm.js builds and translates the request; this file owns the network and returns the same result shapes
// as the OpenAI path in main.js ({message, usage, model} or {error, ...} or {cancelled}).
const { execFile, spawn } = require('child_process');
const Llm = require('./renderer/llm.js');

// Application Default Credentials through the gcloud the person runs: designc never stores or asks for a login.
// The token lives in memory for 50 minutes (they last an hour); a failure is never cached.
const GCLOUD_ARGS = ['auth', 'application-default', 'print-access-token'];
const runGcloud = () => new Promise((resolve, reject) => execFile('gcloud', GCLOUD_ARGS, { timeout: 20000, windowsHide: true, shell: process.platform === 'win32' },
  (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve({ stdout }))));
function adc({ run = runGcloud, now = Date.now } = {}) {
  let cached = null;
  return {
    async token() {
      if (cached && now() < cached.until) return { token: cached.token };
      try {
        const token = String((await run()).stdout || '').trim();
        if (!token) return { error: 'no_adc', hint: 'Run gcloud auth application-default login, then try again.' };
        cached = { token, until: now() + 50 * 60000 };
        return { token };
      } catch (e) {
        if (e.code === 'ENOENT') return { error: 'no_gcloud', hint: 'Install the Google Cloud CLI, then run gcloud auth application-default login.' };
        return { error: 'no_adc', hint: 'Run gcloud auth application-default login, then try again.' };
      }
    },
  };
}
const defaultAdc = adc();

async function readStream(res, onText) {
  const s = Llm.anthropicStream(), dec = new TextDecoder(), reader = res.body.getReader();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      const t = s.push(ev); if (t && onText) onText(t);
    }
  }
  if (s.error) return { error: 'http', status: 200, message: s.error };
  return s.result();
}

// The claude-code provider: the local `claude` CLI in print mode, signed in with your Claude subscription (`claude login`).
// API-key variables are dropped from its environment so a stray key cannot switch it to API billing. The CLI's own tools are off; designc's tools
// (read_model and the rest) are offered as text and the model asks for them with a JSON reply, so the panel's tool loop,
// permissions and the Grill-me role work unchanged.
function claudeCode(cfg, { model, messages, tools, signal, onText, env = process.env, spawnFn = spawn }) {
  const { system, prompt } = Llm.toPrompt(messages, tools);
  const args = ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence'];
  const m = model || cfg.model; if (m) args.push('--model', String(m));
  if (system) args.push('--system-prompt', system);
  const childEnv = { ...env }; delete childEnv.ANTHROPIC_API_KEY; delete childEnv.ANTHROPIC_AUTH_TOKEN;
  return new Promise(resolve => {
    let out = '', err = '', done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    const p = spawnFn(cfg.command || 'claude', args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32', windowsHide: true });
    if (signal) signal.addEventListener('abort', () => { p.kill(); finish({ cancelled: true }); }, { once: true });
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('error', e => finish(e.code === 'ENOENT' ? { error: 'no_claude', hint: 'Install Claude Code, then run claude login.' } : { error: 'network', message: e.message }));
    p.on('close', code => {
      let j; try { j = JSON.parse(out); } catch { /* not json */ }
      if (!j || j.is_error || code) return finish({ error: 'http', status: code || 0, message: (j && j.result) || err.trim() || 'claude exited with an error. Run claude login if you are signed out.', model: m });
      const msg = Llm.fromReply(String(j.result || ''), tools, Date.now());
      if (onText && msg.content) onText(msg.content);
      const u = j.usage || {};
      finish({ message: msg, usage: { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0 }, model: m });
    });
    p.stdin.on('error', () => {}); p.stdin.end(prompt);
  });
}

// args: {model, messages, tools, stream, signal, onText, env, token}
async function call(cfg, args) {
  if (Llm.provider(cfg) === 'claude-code') return claudeCode(cfg, args);
  const vertex = Llm.provider(cfg) === 'vertex';
  const check = Llm.request(cfg, { ...args, token: args.token || 'x' });
  if (check.error) return check;
  let token = args.token;
  if (vertex && !token) {
    const t = await (args.adc || defaultAdc).token();
    if (t.error) return t;
    token = t.token;
  }
  const r = vertex ? Llm.request(cfg, { ...args, token }) : check;
  try {
    const res = await (args.fetch || fetch)(r.url, { method: 'POST', headers: { ...r.headers, accept: args.stream ? 'text/event-stream' : 'application/json' }, body: JSON.stringify(r.body), signal: args.signal });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { error: 'http', status: res.status, message: (b.error && b.error.message) || res.statusText, model: args.model };
    }
    if (args.stream && (res.headers.get('content-type') || '').includes('event-stream')) return await readStream(res, args.onText);
    const out = Llm.fromAnthropic(await res.json());
    if (args.stream && args.onText && out.message.content) args.onText(out.message.content);
    return out;
  } catch (e) {
    if (e.name === 'AbortError') return { cancelled: true };
    return { error: 'network', message: e.message };
  }
}

module.exports = { call, claudeCode, adc, token: () => defaultAdc.token() };
