'use strict';
// The feature journey executor (docs/feature-map-contract.md, Runner). It runs a feature's journeys on a live app through
// the same adapters as parity (recorder/index.js stays as it is: parity's grammar and meaning do not change), and adds the
// ready probe. It never writes and knows nothing about browsers or ledgers.
//
// Adapter session, beyond parity's: act also takes {press: '<keys>'} and {wait: {role, name | text}}; request({method, path})
// -> {status} is needed only when verify.ready has an api check.
const { COMMITS, findNode, sha256 } = require('./index.js');

const ACTIONS = ['goto', 'click', 'fill', 'select', 'press', 'wait'];
const MAX_FAILURES = 50;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

// The step with its params filled in. press carries its keys as args. A missing param is reported as missingParam.
function resolveStep(step, params) {
  const [k] = Object.keys(step).filter(x => ACTIONS.includes(x));
  if (k === 'press') return { action: k, args: step.press };
  const a = { ...step[k] };
  if (a.value && typeof a.value === 'object' && 'param' in a.value) {
    const v = (params || {})[a.value.param];
    if (v == null) return { action: k, args: a, missingParam: a.value.param };
    a.value = String(v);
  }
  return { action: k, args: a };
}

// One run per journey x entry point. The bare `entry` marker is replaced by the entry point's `via`; with no marker the
// via goes first. A feature with no entry points has one run per journey (entry null) and the marker is dropped.
function runs(feature, journeyId) {
  const out = [];
  const eps = Array.isArray(feature.entry_points) && feature.entry_points.length ? feature.entry_points : [null];
  for (const j of Array.isArray(feature.journeys) ? feature.journeys : []) {
    if (journeyId && j.id !== journeyId) continue;
    const steps = Array.isArray(j.steps) ? j.steps : [];
    for (const ep of eps) {
      const via = ep ? [ep.via] : [];
      const has = steps.includes('entry');
      const expanded = has ? steps.flatMap(s => (s === 'entry' ? via : [s])) : [...via, ...steps];
      out.push({ journey: j.id, entry: ep ? ep.id : null, steps: expanded });
    }
  }
  return out;
}

// A node of this role whose subtree's names, joined with spaces, include the text (a status's text is not its name).
function findText(tree, role, text) {
  const names = n => [n.name || '', ...(n.children || []).map(names)].filter(Boolean).join(' ');
  let hit = null;
  (function walk(n) {
    if (!n || hit) return;
    if (n.role === role && names(n).includes(text)) hit = n;
    else for (const c of n.children || []) walk(c);
  })(tree);
  return hit;
}

const present = (tree, m) => (m.text != null ? findText(tree, m.role, m.text) : m.name != null ? findNode(tree, m.role, m.name, m.index || 0) : findText(tree, m.role, ''));
const describeMatch = m => `${m.role}${m.text != null ? ` with text "${m.text}"` : m.name != null ? ` named "${m.name}"` : ''}`;

// The ready probe: goto, check `expect` on the screen, then the api answers 2xx. {ok: true} | {ok: false, msg}. Never throws.
async function ready(session, cfg) {
  try {
    if (!isObj(cfg) || !cfg.goto) return { ok: false, msg: 'no verify.ready in designc.json (goto is required), so the app cannot be shown to be usable' };
    if (cfg.api && !(session && typeof session.request === 'function')) return { ok: false, msg: 'verify.ready has an api check but the adapter cannot make requests (no session.request)' };
    const r = await session.act({ goto: { path: cfg.goto } });
    if (r && r.wall) return { ok: false, msg: `login wall: ${r.wall}` };
    if (r && r.missing) return { ok: false, msg: `ready page: ${r.missing}` };
    if (cfg.expect) {
      const cap = await session.capture();
      if (!present(cap.tree, cfg.expect)) return { ok: false, msg: `the ready page does not show a ${describeMatch(cfg.expect)}` };
    }
    if (cfg.api) {
      const method = String(cfg.api.method || '').toUpperCase();
      if (!['GET', 'HEAD'].includes(method)) return { ok: false, msg: `verify.ready api must be GET or HEAD, not ${cfg.api.method}` };
      const res = await session.request({ method, path: cfg.api.path });
      if (!res || !(res.status >= 200 && res.status < 300)) return { ok: false, msg: `${method} ${cfg.api.path} answered ${res && res.status}, not 2xx` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: `ready check failed: ${e.message}` };
  }
}

const cap = list => list.slice(0, MAX_FAILURES);

// One run on a fresh session. {outcome, failures, capture?, shot?}; close always runs.
async function runOne({ run, feature, adapter, params, cfg, allowWrites, screenshots, shots }) {
  const result = { journey: run.journey, entry: run.entry, outcome: 'pass', failures: [] };
  const stop = (outcome, step, kind, msg) => { result.outcome = outcome; result.failures.push({ step, kind, msg }); return result; };
  let session;
  try { session = await adapter.open({ params, readOnly: !allowWrites }); }
  catch (e) { return stop('could_not_run', 0, 'ready', `the ${adapter.name} adapter could not open the app: ${e.message}`); }
  try {
    const rd = await ready(session, cfg);
    if (!rd.ok) return stop('could_not_run', 0, 'ready', rd.msg);
    for (const [i, step] of run.steps.entries()) {
      const n = i + 1;
      const r = resolveStep(step, params);
      if (r.missingParam) return stop('could_not_run', n, 'step', `no param ${r.missingParam}`);
      if (!allowWrites && r.action === 'click' && COMMITS.test(r.args.name || '')) return stop('could_not_run', n, 'step', `"${r.args.name}" looks like it changes data; feature runs are read-only unless the person running them allows writes`);
      let res;
      try { res = await session.act({ [r.action]: r.args }); }
      catch (e) { return stop('fail', n, 'step', e.message); }
      if (res && res.wall) return stop('could_not_run', n, 'ready', `login wall: ${res.wall}`);
      if (res && res.missing) return stop('fail', n, 'step', res.missing);
    }
    const capture = await session.capture();
    result.capture = capture;
    if (screenshots) {
      const png = await session.screenshot();
      if (png) { result.shot = sha256(png); shots[result.shot] = png; }
    }
    const journey = (feature.journeys || []).find(j => j.id === run.journey) || {};
    const proves = isObj(journey.proves) ? journey.proves : {};
    for (const m of (isObj(proves.ui) && Array.isArray(proves.ui.contains) ? proves.ui.contains : [])) {
      if (!present(capture.tree, m)) { result.outcome = 'fail'; result.failures.push({ step: run.steps.length, kind: 'state', msg: `the final screen has no ${describeMatch(m)}` }); }
    }
    result.failures = cap(result.failures);
    if (proves.effect) result.effect = 'unchecked';
    return result;
  } finally {
    await session.close();
  }
}

// {feature, outcome, journeys: [{journey, entry, outcome, failures, capture?, shot?}], shots}
// proves.ui.state and proves.effect are not judged here: a spec state has no visible signature and the read-back is the
// Factory's job. A run with an effect is marked effect: 'unchecked'.
async function runFeature({ feature, adapter, params = {}, ready: cfg, journey, allowWrites = false, screenshots = true }) {
  const shots = {};
  const journeys = [];
  for (const run of runs(feature, journey)) journeys.push(await runOne({ run, feature, adapter, params, cfg, allowWrites, screenshots, shots }));
  const outcome = journeys.some(j => j.outcome === 'fail') ? 'fail' : journeys.some(j => j.outcome === 'could_not_run') ? 'could_not_run' : 'pass';
  return { feature: feature.id, outcome, journeys, shots };
}

module.exports = { ACTIONS, resolveStep, runs, findText, ready, runFeature };
