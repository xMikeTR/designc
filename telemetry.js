// Langfuse → designc runs.
// Reads the Observations API v2 and Scores API v3 (the v1 trace/observation reads are removed on
// Langfuse Cloud on 2026-11-16), groups observation rows by traceId, and turns each trace into a
// "run" keyed by the design element, task and decision it served.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  baseUrl: '', publicKeyEnv: 'LANGFUSE_PUBLIC_KEY', secretKeyEnv: 'LANGFUSE_SECRET_KEY',
  lookbackDays: 14, tags: ['designc'], maxRows: 20000, outcomeScore: 'task_passed', sampleFile: '',
  // Where each designc field lives in trace metadata. Change these to match what you already emit.
  fields: { system: 'system', element: 'element', task: 'task', decision: 'decision', outcome: 'outcome', attempt: 'attempt', run: 'run', passed: 'task_passed' },
};
// OpenTelemetry GenAI attributes that hold content when the pipeline captures it. Langfuse keeps span attributes
// under `attributes.` in metadata; both spellings are read.
const CONTENT = {
  system: 'gen_ai.system_instructions', input: 'gen_ai.input.messages', output: 'gen_ai.output.messages',
  args: 'gen_ai.tool.call.arguments', result: 'gen_ai.tool.call.result', errorType: 'error.type',
};
const CONTENT_KEYS = Object.values(CONTENT).map(k => 'attributes.' + k);

const iso = d => d.toISOString();
const num = v => (v == null || v === '' ? 0 : Number(v) || 0);

async function getJson(url, auth) {
  const res = await fetch(url, { headers: { authorization: 'Basic ' + auth, accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error((body && (body.message || body.error)) || res.statusText); e.status = res.status; throw e; }
  return body;
}

async function fetchRows(cfg, auth, from, to) {
  const base = cfg.baseUrl.replace(/\/$/, '') + '/api/public/v2/observations';
  const f = cfg.fields;
  const q = new URLSearchParams({
    fromStartTime: iso(from), toStartTime: iso(to), limit: '1000',
    fields: 'core,basic,usage,metadata,model,trace_context',
    expandMetadata: Object.values(f).join(','),
  });
  if (cfg.tags && cfg.tags.length) q.set('filter', JSON.stringify([{ type: 'arrayOptions', column: 'tags', operator: 'any of', value: cfg.tags }]));
  const rows = []; let cursor = null, truncated = false;
  do {
    if (cursor) q.set('cursor', cursor);
    const body = await getJson(`${base}?${q}`, auth);
    rows.push(...(body.data || []));
    cursor = body.meta && body.meta.cursor;
    if (rows.length >= cfg.maxRows) { truncated = !!cursor; break; }
  } while (cursor);
  return { rows, truncated };
}

async function fetchScores(cfg, auth, from, to) {
  if (!cfg.outcomeScore) return [];
  const base = cfg.baseUrl.replace(/\/$/, '') + '/api/public/v3/scores';
  const q = new URLSearchParams({ fromTimestamp: iso(from), toTimestamp: iso(to), name: cfg.outcomeScore, fields: 'subject', limit: '100' });
  const out = []; let cursor = null, pages = 0;
  do {
    if (cursor) q.set('cursor', cursor);
    const body = await getJson(`${base}?${q}`, auth);
    out.push(...(body.data || []));
    cursor = body.meta && body.meta.cursor; pages++;
  } while (cursor && pages < 50);
  return out;
}

// observation rows (+ scores) → runs, one per trace
function normalise(rows, scores, cfg) {
  const f = cfg.fields, byTrace = new Map();
  for (const r of rows) { if (!byTrace.has(r.traceId)) byTrace.set(r.traceId, []); byTrace.get(r.traceId).push(r); }
  const scoreOf = new Map();
  for (const s of scores) {
    const tid = s.subject && (s.subject.kind === 'trace' ? s.subject.id : s.subject.traceId);
    if (tid) scoreOf.set(tid, s.value);
  }
  const runs = [];
  for (const [traceId, obs] of byTrace) {
    const root = obs.find(o => o.isRootObservation) || obs[obs.length - 1];
    const meta = key => { for (const o of [root, ...obs]) { const m = o.metadata || {}; if (m[key] != null && m[key] !== '') return String(m[key]); } return null; };
    const gens = obs.filter(o => o.type === 'GENERATION');
    const models = new Map(); gens.forEach(g => g.model && models.set(g.model, (models.get(g.model) || 0) + 1));
    const starts = obs.map(o => Date.parse(o.startTime)).filter(Boolean), ends = obs.map(o => Date.parse(o.endTime || o.startTime)).filter(Boolean);
    const errors = obs.filter(o => o.level === 'ERROR');
    let outcome = meta(f.outcome);
    if (!outcome && scoreOf.has(traceId)) { const v = scoreOf.get(traceId); outcome = v === true || v === 1 || v === '1' || v === 'passed' ? 'passed' : 'failed'; }
    if (!outcome) outcome = errors.length ? 'error' : 'unknown';
    runs.push({
      traceId, projectId: root.projectId, name: root.traceName || root.name || '',
      start: Math.min(...starts), durationMs: Math.max(...ends) - Math.min(...starts),
      system: meta(f.system), element: meta(f.element), task: meta(f.task), decision: meta(f.decision),
      attempt: meta(f.attempt) ? Number(meta(f.attempt)) : null, outcome: outcome.toLowerCase(),
      tokens: gens.reduce((a, g) => a + num(g.totalUsage), 0), inputTokens: gens.reduce((a, g) => a + num(g.inputUsage), 0), outputTokens: gens.reduce((a, g) => a + num(g.outputUsage), 0),
      cost: obs.reduce((a, o) => a + num(o.totalCost), 0), generations: gens.length, observations: obs.length,
      model: [...models].sort((a, b) => b[1] - a[1]).map(x => x[0])[0] || null,
      errors: errors.length, firstError: errors[0] ? (errors[0].statusMessage || errors[0].name || 'error') : null,
      tags: root.tags || [],
      url: cfg.baseUrl && root.projectId ? `${cfg.baseUrl.replace(/\/$/, '')}/project/${root.projectId}/traces/${traceId}` : null,
    });
  }
  return runs.sort((a, b) => b.start - a.start);
}

const metaOf = (o, key) => { const m = o.metadata || {}; return m[key] != null && m[key] !== '' ? m[key] : null; };
const contentOf = (o, k) => metaOf(o, 'attributes.' + CONTENT[k]) ?? metaOf(o, CONTENT[k]);
const first = v => (Array.isArray(v) ? (v.length ? v[0] : null) : v);
const ms = o => Date.parse(o.endTime || o.startTime) - Date.parse(o.startTime);

function childrenOf(rows) {
  const kids = new Map();
  for (const o of rows) { if (!kids.has(o.parentObservationId)) kids.set(o.parentObservationId, []); kids.get(o.parentObservationId).push(o); }
  for (const list of kids.values()) list.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  return kids;
}
function descendants(kids, id) {
  const out = [];
  const walk = (pid, depth) => { for (const o of kids.get(pid) || []) { out.push({ o, depth }); walk(o.id, depth + 1); } };
  walk(id, 0);
  return out;
}
const errorOf = o => (o.level === 'ERROR' ? (o.statusMessage || contentOf(o, 'errorType') || 'error') : (contentOf(o, 'errorType') ? String(contentOf(o, 'errorType')) : null));

// Task attempts for error analysis: every span carrying the task field, with what happened under it. Spans with no
// steps under them (the run never reached the agent) are counted in `empty`, not listed.
function taskSpans(rows, cfg) {
  const f = cfg.fields, kids = childrenOf(rows), spans = [], byId = new Map(rows.map(o => [o.id, o]));
  // An attempt is the outermost observation carrying the task field (its parent names another task or none),
  // never a model or tool call itself: S2 tags a SPAN, other pipelines tag an AGENT and everything under it.
  const isAttempt = o => {
    if (o.type === 'GENERATION' || o.type === 'TOOL') return false;
    const t = metaOf(o, f.task), p = byId.get(o.parentObservationId);
    return t != null && !(p && String(metaOf(p, f.task)) === String(t));
  };
  let empty = 0;
  for (const o of rows) {
    if (!isAttempt(o)) continue;
    const under = descendants(kids, o.id).map(x => x.o);
    if (!under.length) { empty++; continue; }
    const passed = metaOf(o, f.passed), outcomeField = metaOf(o, f.outcome);
    const outcome = outcomeField != null ? String(outcomeField).toLowerCase()
      : passed != null ? (passed === 1 || passed === true || passed === '1' ? 'passed' : 'failed') : 'unknown';
    const attempt = metaOf(o, f.attempt), start = Date.parse(o.startTime);
    spans.push({
      id: o.id, traceId: o.traceId, projectId: o.projectId, name: o.name || '',
      task: String(metaOf(o, f.task)), run: metaOf(o, f.run) != null ? String(metaOf(o, f.run)) : null,
      attempt: attempt != null && !Number.isNaN(Number(attempt)) ? Number(attempt) : null,
      element: first(metaOf(o, f.element)) != null ? String(first(metaOf(o, f.element))) : null,
      outcome, start, durationMs: ms(o), steps: under.length,
      errors: under.filter(x => errorOf(x)).length,
      tokens: under.filter(x => x.type === 'GENERATION').reduce((a, g) => a + (num(g.totalUsage) || num(g.inputUsage) + num(g.outputUsage)), 0),
      url: cfg.baseUrl && o.projectId ? `${cfg.baseUrl.replace(/\/$/, '')}/project/${o.projectId}/traces/${o.traceId}?observation=${o.id}` : null,
    });
  }
  return { spans: spans.sort((a, b) => b.start - a.start), empty };
}

const parseJson = v => { if (typeof v !== 'string') return v; const t = v.trim(); if (!/^[[{"]/.test(t)) return v; try { return JSON.parse(t); } catch { return v; } };
const text = v => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));
function part(p) {
  if (typeof p === 'string') return { type: 'text', text: p };
  if (p.type === 'tool_call') return { type: 'tool_call', name: p.name || '', arguments: text(parseJson(p.arguments)) };
  if (p.type === 'tool_call_response') return { type: 'tool_call_response', response: text(parseJson(p.response ?? p.result)) };
  return { type: 'text', text: text(p.content ?? p.text ?? p) };
}
// Messages in the GenAI shape ({role, parts}) or the OpenAI shape ({role, content, tool_calls}), or plain text.
function messages(v, role = 'user') {
  v = parseJson(v);
  if (v == null || v === '') return null;
  if (!Array.isArray(v)) {
    if (v && Array.isArray(v.messages)) return messages(v.messages, role);
    if (v && typeof v === 'object' && !v.role) return null;
    v = [v];
  }
  return v.map(m => {
    if (typeof m === 'string') return { role, parts: [{ type: 'text', text: m }] };
    if (Array.isArray(m.parts)) return { role: m.role || role, parts: m.parts.map(part) };
    const parts = [];
    if (m.content != null && m.content !== '') parts.push(...(Array.isArray(m.content) ? m.content.map(part) : [{ type: 'text', text: text(m.content) }]));
    for (const c of m.tool_calls || []) parts.push({ type: 'tool_call', name: (c.function || c).name || '', arguments: text(parseJson((c.function || c).arguments)) });
    return { role: m.role || role, parts };
  });
}
const systemText = v => { const m = messages(v, 'system'); return m ? m.flatMap(x => x.parts).map(p => p.text || '').join('\n') : null; };

// One task attempt as a readable timeline: model turns (what was said to the model since its last turn, what it
// answered) and tool calls (arguments, result, error), in start order, `depth` below the task span.
function traceSteps(rows, spanId) {
  const span = rows.find(o => o.id === spanId);
  if (!span) return { error: 'That task attempt is not in this trace.' };
  const kids = childrenOf(rows), steps = [];
  let system = null, seen = 0, captured = false;
  const ordered = descendants(kids, spanId).sort((a, b) => Date.parse(a.o.startTime) - Date.parse(b.o.startTime));
  for (const { o, depth } of ordered) {
    const base = { id: o.id, name: o.name || '', depth, start: Date.parse(o.startTime), ms: ms(o), error: errorOf(o) };
    if (o.type === 'GENERATION') {
      const input = messages(contentOf(o, 'input') ?? o.input), output = messages(contentOf(o, 'output') ?? o.output, 'assistant');
      const sys = systemText(contentOf(o, 'system'));
      if (sys && system == null) system = sys;
      if (input || output || sys) captured = true;
      const fresh = input ? input.slice(seen).filter(m => m.role === 'user' || m.role === 'system') : null;
      if (input) seen = input.length;
      steps.push({ ...base, kind: 'model', model: o.model || null, tokensIn: num(o.inputUsage), tokensOut: num(o.outputUsage), fresh, output });
    } else if (o.type === 'TOOL') {
      const args = text(parseJson(contentOf(o, 'args') ?? o.input)), result = text(parseJson(contentOf(o, 'result') ?? o.output));
      if (args != null || result != null) captured = true;
      steps.push({ ...base, kind: 'tool', arguments: args, result });
    } else steps.push({ ...base, kind: 'span' });
  }
  return { steps, system, captured };
}

// Every observation of one trace, untagged ones included; `io` adds the observations' input and output.
async function traceRows(cfg, auth, traceId, io) {
  const q = new URLSearchParams({ traceId, limit: '1000', fields: `core,basic,usage,metadata,model${io ? ',io' : ''}`, expandMetadata: [...Object.values(cfg.fields), ...(io ? CONTENT_KEYS : [])].join(',') });
  const base = cfg.baseUrl.replace(/\/$/, '') + '/api/public/v2/observations';
  const rows = []; let cursor = null, pages = 0;
  do {
    if (cursor) q.set('cursor', cursor);
    const body = await getJson(`${base}?${q}`, auth);
    rows.push(...(body.data || []));
    cursor = body.meta && body.meta.cursor; pages++;
  } while (cursor && pages < 20);
  return rows;
}

// The tags filter applies per observation, and a pipeline may tag only its run and task spans, so the model and tool
// calls under a task attempt are read trace by trace (a few at a time) for Review's queue.
async function attemptRows(cfg, auth, rows) {
  const ids = [...new Set(rows.filter(o => metaOf(o, cfg.fields.task) != null).map(o => o.traceId))];
  if (!cfg.tags || !cfg.tags.length || !ids.length) return rows;
  const out = [];
  for (let i = 0; i < ids.length; i += 4) (await Promise.all(ids.slice(i, i + 4).map(id => traceRows(cfg, auth, id, false)))).forEach(r => out.push(...r));
  return out;
}

async function fetchTrace(root, settings, traceId) {
  const cfg = config(settings);
  if (typeof traceId !== 'string' || !/^[\w-]{1,128}$/.test(traceId)) return { error: 'bad_trace' };
  const pk = process.env[cfg.publicKeyEnv], sk = process.env[cfg.secretKeyEnv];
  if ((!cfg.baseUrl || !pk || !sk) && cfg.sampleFile) {
    const s = readSample(root, cfg);
    return s.error ? s : { rows: s.observations.data.filter(o => o.traceId === traceId) };
  }
  if (!cfg.baseUrl) return { error: 'not_configured' };
  if (!pk || !sk) return { error: 'no_keys', env: [cfg.publicKeyEnv, cfg.secretKeyEnv] };
  const auth = Buffer.from(`${pk}:${sk}`).toString('base64');
  try {
    return { rows: await traceRows(cfg, auth, traceId, true) };
  } catch (e) {
    if (e.status === 401 || e.status === 403) return { error: 'auth', message: 'Langfuse rejected the keys (check the project and region).' };
    return { error: 'http', message: e.message };
  }
}

const config = settings => ({ ...DEFAULTS, ...(settings || {}), fields: { ...DEFAULTS.fields, ...((settings || {}).fields || {}) } });
function readSample(root, cfg) {
  const file = path.resolve(root, cfg.sampleFile);
  if (!file.startsWith(root + path.sep)) return { error: 'sampleFile must be inside the registry' };
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { error: `Couldn't read ${cfg.sampleFile}: ${e.message}` }; }
}

async function fetchTelemetry(root, settings) {
  const cfg = config(settings);
  const pk = process.env[cfg.publicKeyEnv], sk = process.env[cfg.secretKeyEnv];
  const to = new Date(), from = new Date(to.getTime() - cfg.lookbackDays * 86400000);
  // Sample mode: same response shapes, read from a file, so the pipeline below is identical.
  if ((!cfg.baseUrl || !pk || !sk) && cfg.sampleFile) {
    const s = readSample(root, cfg);
    if (s.error) return s;
    try {
      return { runs: normalise(s.observations.data, s.scores.data, cfg), tasks: taskSpans(s.observations.data, cfg), meta: { source: 'sample', file: cfg.sampleFile, fetchedAt: Date.now(), rows: s.observations.data.length, truncated: false, lookbackDays: cfg.lookbackDays } };
    } catch (e) { return { error: `Couldn't read ${cfg.sampleFile}: ${e.message}` }; }
  }
  if (!cfg.baseUrl) return { error: 'not_configured' };
  if (!pk || !sk) return { error: 'no_keys', env: [cfg.publicKeyEnv, cfg.secretKeyEnv] };
  const auth = Buffer.from(`${pk}:${sk}`).toString('base64');
  try {
    const [{ rows, truncated }, scores] = await Promise.all([fetchRows(cfg, auth, from, to), fetchScores(cfg, auth, from, to).catch(() => [])]);
    const tasks = taskSpans(await attemptRows(cfg, auth, rows), cfg);
    return { runs: normalise(rows, scores, cfg), tasks, meta: { source: 'langfuse', baseUrl: cfg.baseUrl, fetchedAt: Date.now(), rows: rows.length, truncated, lookbackDays: cfg.lookbackDays } };
  } catch (e) {
    if (e.status === 401 || e.status === 403) return { error: 'auth', message: 'Langfuse rejected the keys (check the project and region).' };
    if (e.status === 404) return { error: 'http', message: 'Observations API v2 not found. Self-hosted Langfuse v3 does not have it; upgrade to v4 or use Langfuse Cloud.' };
    return { error: 'http', message: e.message };
  }
}

module.exports = { fetchTelemetry, fetchTrace, normalise, taskSpans, traceSteps, DEFAULTS };
