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
  fields: { system: 'system', element: 'element', task: 'task', decision: 'decision', outcome: 'outcome', attempt: 'attempt' },
};

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

async function fetchTelemetry(root, settings) {
  const cfg = { ...DEFAULTS, ...(settings || {}), fields: { ...DEFAULTS.fields, ...((settings || {}).fields || {}) } };
  const pk = process.env[cfg.publicKeyEnv], sk = process.env[cfg.secretKeyEnv];
  const to = new Date(), from = new Date(to.getTime() - cfg.lookbackDays * 86400000);
  // Sample mode: same response shapes, read from a file, so the pipeline below is identical.
  if ((!cfg.baseUrl || !pk || !sk) && cfg.sampleFile) {
    const file = path.resolve(root, cfg.sampleFile);
    if (!file.startsWith(root + path.sep)) return { error: 'sampleFile must be inside the registry' };
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { runs: normalise(s.observations.data, s.scores.data, cfg), meta: { source: 'sample', file: cfg.sampleFile, fetchedAt: Date.now(), rows: s.observations.data.length, truncated: false, lookbackDays: cfg.lookbackDays } };
    } catch (e) { return { error: `Couldn't read ${cfg.sampleFile}: ${e.message}` }; }
  }
  if (!cfg.baseUrl) return { error: 'not_configured' };
  if (!pk || !sk) return { error: 'no_keys', env: [cfg.publicKeyEnv, cfg.secretKeyEnv] };
  const auth = Buffer.from(`${pk}:${sk}`).toString('base64');
  try {
    const [{ rows, truncated }, scores] = await Promise.all([fetchRows(cfg, auth, from, to), fetchScores(cfg, auth, from, to).catch(() => [])]);
    return { runs: normalise(rows, scores, cfg), meta: { source: 'langfuse', baseUrl: cfg.baseUrl, fetchedAt: Date.now(), rows: rows.length, truncated, lookbackDays: cfg.lookbackDays } };
  } catch (e) {
    if (e.status === 401 || e.status === 403) return { error: 'auth', message: 'Langfuse rejected the keys (check the project and region).' };
    if (e.status === 404) return { error: 'http', message: 'Observations API v2 not found. Self-hosted Langfuse v3 does not have it; upgrade to v4 or use Langfuse Cloud.' };
    return { error: 'http', message: e.message };
  }
}

module.exports = { fetchTelemetry, normalise, DEFAULTS };
