'use strict';
// The parity recorder: replays one scenario on one side (legacy or next) through an adapter and returns what each step
// showed. It knows nothing about browsers. An adapter opens a session that acts on a step and captures the screen as a
// raw tree; normalising and diffing are renderer/parity.js's job, so a capture stays as the adapter saw it.
//
// Adapter: { name, open({params}) -> session }
// Session: { act(step) -> {ok: true} | {missing: reason}, capture() -> {tree, viewport, url?}, screenshot() -> Buffer | null, close() }
// Raw tree node: { role, name, value?, testId?, disabled?, box: {x, y, w, h} | null, children[] }
const crypto = require('crypto');
const Parity = require('../renderer/parity.js');

const { ACTIONS } = Parity;

// Legacy is recorded live, so a scenario must not change anything there. A click on an element whose accessible name
// starts with a committing verb ("Apply", "Save changes", "Delete program"; not "Bulk apply", which opens a dialog) is refused (status blocked) unless the person running the recorder allows writes; the scenario file
// cannot allow it. Adapters add their own hard guard on top (the web adapter aborts every request that is not a read).
const COMMITS = /^\s*(save|submit|delete|remove|apply|approve|reject|send|confirm|bind|post|publish|import|upload|archive|cancel policy|transfer|pay)\b/i;
const TARGETED = ['click', 'fill', 'select'];

// Step and scenario rules are the contract's (renderer/parity.js): a step has exactly one action; goto takes {path},
// the others {role, name}, an optional index (position among the matches) and, for fill and select, a value, which may
// be {param: name} read from the side's params.
const { stepProblem, scenarioProblems } = Parity;

// The step with its params filled in. A param the side does not have is null, which the caller reports as could not run.
function resolve(step, params) {
  const [k] = Object.keys(step).filter(x => ACTIONS.includes(x));
  const a = { ...step[k] };
  if (a.value && typeof a.value === 'object' && 'param' in a.value) {
    const v = (params || {})[a.value.param];
    if (v == null) return { action: k, args: a, missingParam: a.value.param };
    a.value = String(v);
  }
  return { action: k, args: a };
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// {scenario, side, adapter, steps: [{n, action, args, status: ok | could_not_run | error, reason?, capture?, shot?}], shots}
// A click that would commit is blocked unless allowWrites, and the steps after it could not run.
// A step that cannot run on this side (its element or param is missing) is could_not_run, not a failure, and every
// later step is too, because the screen is no longer the one the scenario expects. shots maps sha256 to the image bytes.
async function record({ scenario, side, adapter, params = {}, screenshots = true, allowWrites = false, allowRequests = [] }) {
  const problems = scenarioProblems(scenario);
  if (problems.length) return { error: `Scenario ${scenario && scenario.id || '?'} cannot run: ${problems.join('; ')}.` };
  const out = { scenario: scenario.id, side, adapter: adapter.name, steps: [], shots: {} };
  let session;
  try { session = await adapter.open({ params, readOnly: !allowWrites, allowRequests }); }
  catch (e) { return { error: `The ${adapter.name} adapter could not open ${side}: ${e.message}` }; }
  let stopped = null;
  try {
    for (const [i, step] of scenario.steps.entries()) {
      const r = resolve(step, params);
      const row = { n: i + 1, action: r.action, args: r.args };
      out.steps.push(row);
      if (stopped) { row.status = 'could_not_run'; row.reason = `an earlier step could not run (step ${stopped})`; continue; }
      if (r.missingParam) { row.status = 'could_not_run'; row.reason = `${side} has no param ${r.missingParam}`; stopped = row.n; continue; }
      if (!allowWrites && r.action === 'click' && COMMITS.test(r.args.name)) {
        row.status = 'blocked';
        row.reason = `"${r.args.name}" looks like it changes data; recording is read-only unless the person running it allows writes`;
        stopped = row.n;
        continue;
      }
      let res;
      try { res = await session.act({ [r.action]: r.args }); }
      catch (e) { row.status = 'error'; row.reason = e.message; stopped = row.n; continue; }
      if (res && res.missing) { row.status = 'could_not_run'; row.reason = res.missing; stopped = row.n; continue; }
      row.status = 'ok';
      row.capture = await session.capture();
      if (screenshots) {
        const png = await session.screenshot();
        if (png) { row.shot = sha256(png); out.shots[row.shot] = png; }
      }
    }
  } finally {
    await session.close();
  }
  return out;
}

// Finds the index-th node with this role and accessible name, depth first in document order. Shared by adapters that
// hold a tree (the fixture adapter) so they pick records the way a browser's getByRole(...).nth(index) does.
function findNode(tree, role, name, index = 0) {
  const hits = [];
  (function walk(n) {
    if (!n) return;
    if (n.role === role && (n.name || '') === name) hits.push(n);
    for (const c of n.children || []) walk(c);
  })(tree);
  return hits[index] || null;
}

module.exports = { ACTIONS, COMMITS, TARGETED, stepProblem, scenarioProblems, resolve, record, findNode, sha256 };
