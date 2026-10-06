// designc main process: calls to the anthropic and vertex providers. Node only, no Electron, like git.js.
// renderer/llm.js builds and translates the request; this file owns the network and returns the same result shapes
// as the OpenAI path in main.js ({message, usage, model} or {error, ...} or {cancelled}).
const Llm = require('./renderer/llm.js');

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
  const r = Llm.request(cfg, args);
  if (r.error) return r;
  try {
    const res = await fetch(r.url, { method: 'POST', headers: { ...r.headers, accept: args.stream ? 'text/event-stream' : 'application/json' }, body: JSON.stringify(r.body), signal: args.signal });
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

module.exports = { call };
