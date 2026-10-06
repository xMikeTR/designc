/* designc desktop: "Set up this folder". Pure, no I/O, no dependencies.
   Dual-load like renderer/policy.js: <script src="setup.js"> in the renderer, require('./renderer/setup.js')
   from main.js and tests. designc.json holds the names of environment variables, never their values: the
   renderer only ever learns whether a name is set, and only main.js reads a value, to send it to the URL
   the human typed when they press Test connection. */
const Setup = (() => {
  const L = typeof module === 'object' && module.exports ? require('./llm.js') : Llm;
  const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
  const DEFAULTS = { apiKeyEnv: 'DESIGNC_LLM_API_KEY', publicKeyEnv: 'LANGFUSE_PUBLIC_KEY', secretKeyEnv: 'LANGFUSE_SECRET_KEY' };
  const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

  const STARTER_MODEL = `workspace "New design" {
  model {
    user = person "User"
    system = softwareSystem "New system" {
      app = container "App"
    }
    user -> app "Uses"
  }
}
`;

  const blank = v => v == null || String(v).trim() === '';
  const name = (sec, f) => (sec && !blank(sec[f]) ? String(sec[f]).trim() : DEFAULTS[f]);
  // The key variable a provider reads: the gateway's own, ANTHROPIC_API_KEY for the Anthropic API, none for Vertex AI (ADC).
  const llmNames = d => {
    const p = L.provider(d.llm);
    if (p === 'vertex') return [];
    return [d.llm && !blank(d.llm.apiKeyEnv) ? String(d.llm.apiKeyEnv).trim() : (p === 'anthropic' ? 'ANTHROPIC_API_KEY' : DEFAULTS.apiKeyEnv)];
  };
  const lfNames = d => [name(d.langfuse, 'publicKeyEnv'), name(d.langfuse, 'secretKeyEnv')];

  function envNames(draft) {
    return [...(draft.llm ? llmNames(draft) : []), ...(draft.langfuse ? lfNames(draft) : [])];
  }

  function envStatus(names, env) {
    const out = {};
    for (const n of names) if (typeof n === 'string' && ENV_NAME.test(n)) out[n] = !blank(env[n]);
    return out;
  }

  // https anywhere; plain http only on this machine, so a key never crosses a network in clear.
  function urlProblem(u) {
    let p; try { p = new URL(u); } catch { return 'Enter a full URL starting with https://.'; }
    if (p.protocol === 'https:') return null;
    if (p.protocol === 'http:' && LOCAL.has(p.hostname)) return null;
    return p.protocol === 'http:' ? 'Use https, or http only for localhost: the key would be sent unencrypted.' : 'Enter a full URL starting with https://.';
  }

  function validate(draft) {
    const errs = [];
    const envField = (sec, key, f) => {
      if (!sec || blank(sec[f])) return;
      if (!ENV_NAME.test(String(sec[f]).trim())) errs.push({ field: `${key}.${f}`, msg: 'Enter the name of an environment variable (like MY_API_KEY), not the key itself.' });
    };
    const urlField = (sec, key) => { if (sec && !blank(sec.baseUrl)) { const m = urlProblem(String(sec.baseUrl).trim()); if (m) errs.push({ field: `${key}.baseUrl`, msg: m }); } };
    if (!blank(draft.model)) {
      const m = String(draft.model).trim();
      if (!m.endsWith('.dsl') || m.startsWith('/') || /^[A-Za-z]:/.test(m) || m.split(/[\\/]/).includes('..')) errs.push({ field: 'model', msg: 'Enter a .dsl path inside this folder, like model/workspace.dsl.' });
    }
    if (draft.llm && !L.provider(draft.llm)) errs.push({ field: 'llm.provider', msg: `Unknown provider ${draft.llm.provider}. Use openai, anthropic or vertex.` });
    urlField(draft.llm, 'llm'); envField(draft.llm, 'llm', 'apiKeyEnv');
    urlField(draft.langfuse, 'langfuse'); envField(draft.langfuse, 'langfuse', 'publicKeyEnv'); envField(draft.langfuse, 'langfuse', 'secretKeyEnv');
    return errs;
  }

  // A section that is null or missing was skipped and stays as it is. Fields the wizard owns are set, or removed
  // when blank; every other key (tags, litellmMetadata, agents, codebase...) is kept.
  function merge(current, draft) {
    const out = { ...(current || {}) };
    if (!blank(draft.model)) out.model = String(draft.model).trim();
    for (const key of ['llm', 'langfuse']) {
      if (!draft[key]) continue;
      const sec = { ...(out[key] || {}) };
      for (const [f, v] of Object.entries(draft[key])) { if (blank(v) || (key === 'llm' && f === 'provider' && L.provider({ provider: v }) === 'openai')) delete sec[f]; else sec[f] = String(v).trim(); }
      if (Object.keys(sec).length) out[key] = sec; else delete out[key];
    }
    return out;
  }

  const b64 = s => (typeof Buffer !== 'undefined' ? Buffer.from(s).toString('base64') : btoa(s));
  const missing = names => ({ error: 'missing', env: names, hint: `Set ${names.join(' and ')} in your environment, then restart designc.` });

  // What Test connection sends: {url, init} for fetch, or why it cannot be sent.
  function probe(kind, draft, env) {
    const sec = draft[kind];
    if (kind !== 'llm' && kind !== 'langfuse') return { error: 'invalid', hint: `Unknown connection ${kind}.` };
    const prov = kind === 'llm' ? L.provider(sec) : null;
    const needsUrl = kind === 'langfuse' || prov === 'openai';
    if (!sec || (needsUrl && blank(sec.baseUrl)) || (kind === 'llm' && blank(sec.model))) return { error: 'incomplete', hint: kind === 'langfuse' ? 'Enter the base URL first.' : needsUrl ? 'Enter the base URL and the model first.' : 'Enter the model first.' };
    const bad = validate({ [kind]: sec });
    if (bad.length) return { error: 'invalid', hint: bad[0].msg };
    const base = blank(sec.baseUrl) ? '' : String(sec.baseUrl).trim().replace(/\/$/, '');
    const names = kind === 'llm' ? llmNames(draft) : lfNames(draft);
    const unset = names.filter(n => blank(env[n]));
    if (unset.length) return missing(unset);
    if (kind === 'llm' && prov === 'anthropic') {
      const r = L.request(sec, { model: String(sec.model).trim(), messages: [{ role: 'user', content: 'Reply with OK.' }], env });
      return { url: r.url, init: { method: 'POST', headers: r.headers, body: JSON.stringify({ ...r.body, max_tokens: 1 }) } };
    }
    if (kind === 'llm') {
      return { url: `${base}/chat/completions`, init: { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env[names[0]]}` },
        body: JSON.stringify({ model: String(sec.model).trim(), messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 1 }) } };
    }
    return { url: `${base}/api/public/v2/observations?limit=1&fields=core`, init: { method: 'GET', headers: { accept: 'application/json', authorization: `Basic ${b64(`${env[names[0]]}:${env[names[1]]}`)}` } } };
  }

  // res is {status, body} from fetch, or {network: message}.
  const WHAT = { openai: 'gateway', anthropic: 'Anthropic API', vertex: 'Vertex AI' };
  function verdict(kind, draft, res) {
    const what = kind === 'llm' ? WHAT[L.provider(draft.llm)] || 'gateway' : 'Langfuse';
    if (res.network) return { error: `Couldn't reach the ${what}: ${res.network}`, hint: 'Check the base URL and that the service is running.' };
    const b = res.body || {};
    if (res.status >= 200 && res.status < 300) return { ok: true, detail: kind === 'llm' ? `The ${what} answered as ${b.model || String(draft.llm.model).trim()}.` : 'Langfuse accepted the keys.' };
    const names = (kind === 'llm' ? llmNames(draft) : lfNames(draft)).join(' and ');
    if (res.status === 401 || res.status === 403) return { error: `The ${what} refused the key (HTTP ${res.status}).`, hint: `Check the value of ${names}, then restart designc.` };
    if (res.status === 404) return { error: `The ${what} has no such endpoint (HTTP 404).`, hint: kind === 'llm' ? (L.provider(draft.llm) === 'openai' ? 'Check the base URL: an OpenAI-compatible gateway usually ends in /v1.' : 'Check the model name the provider expects.') : 'Check the base URL: it is the Langfuse host, without /api.' };
    const msg = (b.error && b.error.message) || b.message || (typeof b.error === 'string' ? b.error : '') || `HTTP ${res.status}`;
    return { error: `The ${what} answered: ${msg}`, hint: kind === 'llm' ? 'Check the model name the provider expects.' : 'Check the base URL.' };
  }

  // The host a section talks to (host:port), so Test connection can tell whether it is already saved.
  function hostOf(kind, sec) {
    if (!sec) return null;
    try {
      if (!blank(sec.baseUrl)) return new URL(String(sec.baseUrl).trim()).host;
      return kind === 'llm' && L.provider(sec) === 'anthropic' ? 'api.anthropic.com' : null;
    } catch { return null; }
  }

  const exportLine = n => (ENV_NAME.test(n) ? `export ${n}="<your key>"` : null);

  const m = { ENV_NAME, DEFAULTS, STARTER_MODEL, envNames, envStatus, validate, merge, probe, verdict, hostOf, exportLine };
  if (typeof module === 'object' && module.exports) module.exports = m;
  return m;
})();
