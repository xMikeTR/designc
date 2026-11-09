/* designc desktop: model providers. Pure, no I/O, no dependencies.
   Dual-load like renderer/policy.js: <script src="llm.js"> in the renderer, require('./renderer/llm.js') from main.js
   and tests. The renderer speaks OpenAI-shaped messages and tools. For the `anthropic` and `vertex` providers this
   module translates them to the Anthropic Messages API and back, and builds the request from designc.json `llm`.
   main.js owns the network, the key and the ADC token; nothing here reads the environment except what it is handed. */
const Llm = (() => {
  const PROVIDERS = ['openai', 'anthropic', 'vertex', 'claude-code'];
  const ANTHROPIC_HOST = 'https://api.anthropic.com';
  const SAFE = { project: /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/, region: /^[a-z0-9-]{1,40}$/, model: /^[A-Za-z0-9][A-Za-z0-9._@-]{0,100}$/ };

  // 'openai' (the OpenAI-compatible gateway, the default), 'anthropic', 'vertex', 'claude-code' (the local claude CLI, on your Claude subscription), or null for a name designc does not know.
  function provider(cfg) {
    const p = String((cfg && cfg.provider) || 'openai').trim().toLowerCase().replace(/^openai-compatible$/, 'openai');
    return PROVIDERS.includes(p) ? p : null;
  }

  const parseArgs = s => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } };

  function toAnthropic(messages, tools) {
    const system = [], out = [];
    for (const m of messages || []) {
      if (m.role === 'system') { if (m.content) system.push(String(m.content)); continue; }
      if (m.role === 'tool') {
        const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content == null ? '' : m.content) };
        const last = out[out.length - 1];
        if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every(b => b.type === 'tool_result')) last.content.push(block);
        else out.push({ role: 'user', content: [block] });
        continue;
      }
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
        const content = [];
        if (m.content) content.push({ type: 'text', text: String(m.content) });
        for (const c of m.tool_calls) content.push({ type: 'tool_use', id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) });
        out.push({ role: 'assistant', content });
        continue;
      }
      out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content == null ? '' : m.content) });
    }
    const body = { messages: out };
    if (system.length) body.system = system.join('\n\n');
    if (tools && tools.length) body.tools = tools.map(t => ({ name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object', properties: {} } }));
    return body;
  }

  const usageOf = (i, o) => (i == null && o == null) ? null : { prompt_tokens: i || 0, completion_tokens: o || 0, total_tokens: (i || 0) + (o || 0) };
  const callOf = (id, name, args) => ({ id, type: 'function', function: { name, arguments: args } });

  function fromAnthropic(res) {
    const blocks = (res && res.content) || [];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    const calls = blocks.filter(b => b.type === 'tool_use').map(b => callOf(b.id, b.name, JSON.stringify(b.input || {})));
    const u = res && res.usage;
    return { message: { role: 'assistant', content: text || null, tool_calls: calls.length ? calls : undefined }, usage: u ? usageOf(u.input_tokens, u.output_tokens) : null, model: res && res.model };
  }

  // Reduces Anthropic SSE events one at a time. push(event) returns the text delta to show, '' for anything else.
  function anthropicStream() {
    const calls = new Map();
    let text = '', model, inTok, outTok;
    const s = {
      error: null,
      push(ev) {
        if (!ev) return '';
        if (ev.type === 'message_start' && ev.message) { model = ev.message.model; if (ev.message.usage) inTok = ev.message.usage.input_tokens; }
        else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') calls.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, input: ev.content_block.input, json: '' });
        else if (ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'text_delta') { text += ev.delta.text; return ev.delta.text; }
          if (ev.delta.type === 'input_json_delta' && calls.has(ev.index)) calls.get(ev.index).json += ev.delta.partial_json || '';
        } else if (ev.type === 'message_delta' && ev.usage) outTok = ev.usage.output_tokens;
        else if (ev.type === 'error') s.error = (ev.error && ev.error.message) || 'The model returned an error.';
        return '';
      },
      result() {
        const tc = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => callOf(c.id, c.name, c.json || (c.input && Object.keys(c.input).length ? JSON.stringify(c.input) : '{}')));
        return { message: { role: 'assistant', content: text || null, tool_calls: tc.length ? tc : undefined }, usage: usageOf(inTok, outTok), model };
      },
    };
    return s;
  }

  // The request for the anthropic and vertex providers: {url, headers, body} or {error}.
  // `env` is the process environment; `token` is the ADC access token main.js fetched (vertex only).
  function request(cfg, { model, messages, tools, stream, env = {}, token }) {
    const p = provider(cfg);
    if (p !== 'anthropic' && p !== 'vertex') return { error: 'invalid' };
    if (!model) return { error: 'not_configured' };
    const base = { max_tokens: Number(cfg.maxTokens) > 0 ? Number(cfg.maxTokens) : 4096, ...(stream ? { stream: true } : {}), ...toAnthropic(messages, tools) };
    if (p === 'anthropic') {
      const keyEnv = cfg.apiKeyEnv || 'ANTHROPIC_API_KEY';
      if (!env[keyEnv]) return { error: 'no_key', env: keyEnv };
      const host = String(cfg.baseUrl || ANTHROPIC_HOST).replace(/\/+$/, '');
      return { url: `${host}/v1/messages`, headers: { 'content-type': 'application/json', 'x-api-key': env[keyEnv], 'anthropic-version': '2023-06-01' }, body: { model, ...base } };
    }
    const project = cfg.project || env.ANTHROPIC_VERTEX_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT;
    const region = cfg.region || env.CLOUD_ML_REGION || 'global';
    if (!project) return { error: 'no_project' };
    if (!SAFE.project.test(project) || !SAFE.region.test(region) || !SAFE.model.test(model)) return { error: 'invalid' };
    if (!token) return { error: 'no_token' };
    const host = region === 'global' ? 'https://aiplatform.googleapis.com' : `https://${region}-aiplatform.googleapis.com`;
    const method = stream ? 'streamRawPredict' : 'rawPredict';
    return { url: `${host}/v1/projects/${project}/locations/${region}/publishers/anthropic/models/${model}:${method}`, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: { anthropic_version: 'vertex-2023-10-16', ...base } };
  }

  // The claude-code provider: OpenAI-shaped messages and tools as one system string plus a plain transcript for `claude -p`.
  // The CLI runs with its own tools off, so designc's tools are offered as text and the model asks for them with a JSON reply.
  const TOOL_RULES = 'You can call these tools. To call one or more, reply with ONLY this JSON and nothing else: {"tool_calls":[{"name":"<tool>","arguments":{...}}]}. You will get the results in the next message. When you have what you need, answer in plain text. Never invent tool results.';
  function toPrompt(messages, tools) {
    const system = [], turns = [], names = new Map();
    const txt = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p.text || '').join('') : '');
    for (const m of messages || []) {
      const text = txt(m.content);
      if (m.role === 'system') { if (text) system.push(text); continue; }
      if (m.role === 'tool') { turns.push(`Tool result (${names.get(m.tool_call_id) || 'tool'}):\n${text}`); continue; }
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
        for (const c of m.tool_calls) names.set(c.id, c.function.name);
        turns.push('Assistant: ' + JSON.stringify({ tool_calls: m.tool_calls.map(c => ({ name: c.function.name, arguments: parseArgs(c.function.arguments) })) })); continue;
      }
      if (!text) continue;
      turns.push(`${m.role === 'assistant' ? 'Assistant' : 'User'}: ${text}`);
    }
    if (tools && tools.length) system.push(TOOL_RULES + '\n\nTools:\n' + tools.map(t => `- ${t.function.name}: ${t.function.description || ''} Arguments (JSON schema): ${JSON.stringify(t.function.parameters || {})}`).join('\n'));
    const prompt = turns.length === 1 && turns[0].startsWith('User: ') ? turns[0].slice(6) : turns.join('\n\n') + '\n\nAssistant:';
    return { system: system.join('\n\n'), prompt };
  }

  // The model's reply as an OpenAI-shaped assistant message: tool_calls when it asked for known tools, else its text.
  function fromReply(text, tools, seq = 0) {
    const known = new Set((tools || []).map(t => t.function.name));
    const at = known.size ? text.search(/\{\s*"tool_calls"\s*:/) : -1;
    if (at >= 0) {
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let k = at; k < text.length; k++) {
        const ch = text[k];
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}' && --depth === 0) { end = k + 1; break; }
      }
      let j; try { j = JSON.parse(text.slice(at, end)); } catch (e) { j = null; }
      const calls = j && Array.isArray(j.tool_calls) ? j.tool_calls.filter(c => c && known.has(c.name)) : [];
      if (calls.length) return { role: 'assistant', content: null, tool_calls: calls.map((c, n) => ({ id: `call_cc${seq}_${n}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments && typeof c.arguments === 'object' ? c.arguments : {}) } })) };
    }
    return { role: 'assistant', content: text };
  }

  return { PROVIDERS, provider, toPrompt, fromReply, toAnthropic, fromAnthropic, anthropicStream, request };
})();
if (typeof module !== 'undefined') module.exports = Llm;
