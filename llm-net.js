// designc main process: calls to the anthropic and vertex providers. Node only, no Electron, like git.js.
// renderer/llm.js builds and translates the request; this file owns the network and returns the same result shapes
// as the OpenAI path in main.js ({message, usage, model} or {error, ...} or {cancelled}).
const { execFile } = require('child_process');
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

// args: {model, messages, tools, stream, signal, onText, env, token}
async function call(cfg, args) {
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

module.exports = { call, adc, token: () => defaultAdc.token() };
