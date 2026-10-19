// ===== designc core: scenarios, agent topology and agent evals =====
// Part of Core, split out of core.js with no behaviour change. Dual-loaded like core.js: a classic script in the
// renderer (after core.js) and required by core.js under Node. It reads what it needs from Core and adds its functions to it.
(Core => {
  const { hash16, get, structural, RATINGS } = Core._shared;
  const { interaction } = Core;
  // Called at run time, after every part has loaded.
  const fingerprint = (...a) => Core.fingerprint(...a);
  // ---------- quality attribute scenarios and fitness functions ----------
  // A scenario (scenarios/*.yaml) is a quality attribute scenario: stimulus, artifact (an element name),
  // response and a measure. Availability scenarios are checked analytically against the model: the
  // artifact's availability times that of everything it depends on through declared sync relationships
  // (async and undeclared ones are left out, as in blastRadius). Every other attribute is judged only by
  // its fitness function: shell commands run like decision checks, recorded as `fitness` ledger events.
  function latestFitness(ledger, id) {
    return ledger.filter(e => e.kind === 'fitness' && e.scenario === id).sort((a, b) => (b._ts || 0) - (a._ts || 0))[0] || null;
  }
  const rating = v => (RATINGS.includes(v) ? v : null);
  function scenarioReport({ model, scenarios = [], ledger = [] }) {
    const byName = n => [...model.elements.values()].find(e => e.name === n) || null;
    return scenarios.map(s => {
      const row = { id: s.id, title: s.title || '', attribute: s.attribute, artifact: s.artifact, measure: s.measure || null, importance: rating(s.importance), difficulty: rating(s.difficulty) };
      const el = byName(s.artifact);
      const cmds = (s.fitness || []).filter(c => c && !/^TODO/.test(c));
      const last = latestFitness(ledger, s.id);
      row.fitness = { status: !cmds.length ? 'none' : !last ? 'unchecked' : last.outcome === 'pass' ? 'passing' : 'failing', commands: cmds };
      if (!el) { row.status = 'unresolved'; row.analytic = { status: 'n/a' }; return row; }
      row.status = 'resolved';
      const m = s.measure || {};
      if (s.attribute !== 'availability' || m.metric !== 'availability' || typeof m.value !== 'number') { row.analytic = { status: 'n/a' }; return row; }
      const seen = new Set([el.id]), queue = [el.id];
      for (let i = 0; i < queue.length; i++) for (const r of model.rels) {
        if (r.src !== queue[i] || seen.has(r.dst) || structural(model, r) || interaction(r) !== 'sync') continue;
        seen.add(r.dst); queue.push(r.dst);
      }
      const els = [...seen].map(id => model.elements.get(id));
      const missing = els.filter(e => get(e, 'd.availability') == null).map(e => e.name);
      if (missing.length) { row.analytic = { status: 'unknown', missing }; return row; }
      const value = els.reduce((a, e) => a * Number(get(e, 'd.availability')), 1) * 100;
      const ok = m.op === '<=' ? value <= m.value : value >= m.value;
      row.analytic = { status: ok ? 'met' : 'not-met', value, elements: els.map(e => e.name) };
      return row;
    });
  }

  // The utility tree: scenarios grouped by quality attribute, most important and hardest first, unrated last.
  // It only orders; nothing here reaches the gate.
  function utilityTree(rows) {
    const weight = v => 3 - RATINGS.indexOf(v), key = r => [r.importance ? weight(r.importance) : 0, r.difficulty ? weight(r.difficulty) : 0];
    const cmp = (a, b) => { const x = key(a), y = key(b); return y[0] - x[0] || y[1] - x[1] || String(a.id).localeCompare(String(b.id)); };
    const groups = new Map();
    for (const r of rows) { const k = r.attribute || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    const out = [...groups].map(([attribute, scenarios]) => ({ attribute, scenarios: scenarios.sort(cmp) }));
    return out.sort((a, b) => cmp(a.scenarios[0], b.scenarios[0]) || a.attribute.localeCompare(b.attribute));
  }

  // ---------- agent topology ----------
  // The agents in a model, what they call and who calls them, for the topology view. Only elements one declared
  // relationship away from an agent appear. An agent has the Agent tag or declares d.agent.autonomy (as the evals do). An irreversible call with no human approval is `unguarded`.
  function agentTopology(model) {
    const agents = new Set([...model.elements.values()].filter(e => e.tags.has('Agent') || get(e, 'd.agent.autonomy') != null).map(e => e.id));
    const edges = model.rels.filter(r => (agents.has(r.src) || agents.has(r.dst)) && r.src !== r.dst && model.elements.has(r.src) && model.elements.has(r.dst) && !structural(model, r)).map(r => {
      const effect = get(r, 'd.tool.effect'), approval = get(r, 'd.approval');
      return { id: r.id, src: r.src, dst: r.dst, description: r.description || '', effect: effect == null ? null : effect, approval: approval == null ? null : approval,
        protocol: get(r, 'd.protocol') == null ? null : get(r, 'd.protocol'), unguarded: effect === 'irreversible' && approval !== 'human' };
    });
    const ids = new Set([...agents, ...edges.flatMap(e => [e.src, e.dst])]);
    const nodes = [...ids].map(id => model.elements.get(id)).filter(Boolean).map(e => ({ id: e.id, name: e.name, kind: e.kind, agent: agents.has(e.id),
      pattern: agents.has(e.id) && get(e, 'd.agent.pattern') != null ? get(e, 'd.agent.pattern') : null, autonomy: agents.has(e.id) && get(e, 'd.agent.autonomy') != null ? get(e, 'd.agent.autonomy') : null }));
    return { nodes: agents.size ? nodes : [], edges: agents.size ? edges : [], agents: agents.size, unguarded: edges.filter(e => e.unguarded).length };
  }

  // ---------- agent evals ----------
  // evals/<id>.yaml names an agent, a command that writes a results file, and thresholds on its metrics.
  // The runner only reports numbers; designc applies the thresholds, so the same results always give the same verdict.
  const THRESHOLD = /^\s*([A-Za-z_][\w.-]*)\s*(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)\s*$/;
  function parseThreshold(text) {
    const m = typeof text === 'string' ? THRESHOLD.exec(text) : null;
    if (!m) return { error: `"${text}" is not "<metric> <op> <number>", e.g. task_success >= 0.85` };
    return { metric: m[1], op: m[2], value: Number(m[3]) };
  }
  const THRESHOLD_OPS = { '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b, '==': (a, b) => a === b };
  function scoreEval(evalDef, results) {
    const list = (evalDef && evalDef.thresholds) || [];
    if (!list.length) return { error: `eval ${evalDef && evalDef.id} has no thresholds` };
    const parsed = list.map(parseThreshold);
    const bad = parsed.find(t => t.error);
    if (bad) return { error: bad.error };
    if (!results || typeof results !== 'object' || Array.isArray(results)) return { error: 'results must be an object with metrics and cases' };
    const metrics = results.metrics;
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics) || !Object.values(metrics).every(v => typeof v === 'number' && Number.isFinite(v)))
      return { error: 'results.metrics must be an object of numbers' };
    if (!Number.isInteger(results.cases) || results.cases < 0) return { error: 'results.cases must be a whole number, 0 or more' };
    const thresholds = parsed.map(t => {
      const actual = Object.prototype.hasOwnProperty.call(metrics, t.metric) ? metrics[t.metric] : null;
      return { ...t, actual, ok: actual !== null && THRESHOLD_OPS[t.op](actual, t.value) };
    });
    const reasons = thresholds.filter(t => !t.ok).map(t => t.actual === null ? `${t.metric} is missing from the results` : `${t.metric} ${t.actual} is not ${t.op} ${t.value}`);
    const out = { outcome: reasons.length ? 'fail' : 'pass', metrics, cases: results.cases, thresholds };
    if (reasons.length) out.reason = reasons.join('; ');
    return out;
  }

  // The hash of an eval file's text, line endings normalised so a Windows checkout hashes like the commit.
  const evalHash = e => hash16(String((e && e._text) || '').replace(/\r\n/g, '\n'));
  const elementsOf = model => (model && model.elements ? [...model.elements.values()] : []);
  const AGE = /^(\d+)\s*([mhd])$/i;
  const AGE_MS = { m: 60000, h: 3600000, d: 86400000 };
  const insideRegistry = p => !/^([A-Za-z]:|[\\/])/.test(p) && !p.split(/[\\/]/).includes('..');
  function evalProblems(e) {
    const out = [];
    const missing = ['agent', 'command', 'results'].filter(k => typeof e[k] !== 'string' || !e[k].trim());
    if (missing.length) out.push(`needs ${missing.join(', ')}`);
    const list = Array.isArray(e.thresholds) ? e.thresholds : [];
    if (!list.length) out.push('needs thresholds');
    else { const bad = list.map(parseThreshold).find(t => t.error); if (bad) out.push(bad.error); }
    if (e.maxAge != null && !AGE.test(String(e.maxAge))) out.push(`maxAge "${e.maxAge}" is not like 30m, 12h or 7d`);
    if (typeof e.results === 'string' && e.results.trim() && !insideRegistry(e.results)) out.push('results must be a path inside the registry');
    return out;
  }
  // One row per element that declares d.agent.autonomy. approve-writes and autonomous agents block the gate
  // unless the latest result for their eval passes and is current: run under this eval file, against this agent
  // (Core.fingerprint), and within maxAge when the eval sets one. A suggest agent gets a row but never blocks.
  function evalReport({ model, evals = [], ledger = [], now = Date.now() }) {
    const byId = new Map();
    for (const e of evals) if (e && e.id != null && !byId.has(String(e.id))) byId.set(String(e.id), e);
    const rows = [];
    for (const el of elementsOf(model)) {
      const autonomy = get(el, 'd.agent.autonomy');
      if (!autonomy) continue;
      const evalId = get(el, 'd.agent.eval');
      const row = { agent: el.name, agentId: el.id, autonomy, evalId, status: 'missing', reason: '', latest: null, thresholds: [], defInvalid: false };
      const done = (status, reason) => { row.status = status; row.reason = reason; row.blocking = autonomy !== 'suggest' && status !== 'passing'; rows.push(row); };
      if (!evalId) { done('missing', 'd.agent.eval names no eval'); continue; }
      const d = byId.get(String(evalId));
      if (!d) { done('missing', `eval ${evalId} is not in evals/`); continue; }
      row.evalHash = evalHash(d);
      if (evalProblems(d).length) { row.defInvalid = true; done('invalid', `eval ${evalId} is invalid`); continue; }
      if (d.agent !== el.name) { done('invalid', `eval ${evalId} is for "${d.agent}", not ${el.name}`); continue; }
      const mine = ledger.filter(e => e.kind === 'eval' && e.eval === String(d.id)).sort((a, b) => (b._ts || 0) - (a._ts || 0));
      const current = mine.filter(e => e.eval_hash === row.evalHash);
      const latest = row.latest = current[0] || null;
      row.thresholds = (d.thresholds || []).map(parseThreshold).map(t => {
        const actual = latest && Object.prototype.hasOwnProperty.call(latest.metrics || {}, t.metric) ? latest.metrics[t.metric] : null;
        return { ...t, actual, ok: actual !== null && THRESHOLD_OPS[t.op](actual, t.value) };
      });
      if (!mine.length) done('unchecked', `eval ${evalId} has no result recorded yet`);
      else if (!latest) done('stale', `eval ${evalId}: the last result was run under a different version of the eval file`);
      else if (latest.fingerprint !== fingerprint(model, el.id).hash) done('stale', `eval ${evalId}: the agent changed since the last result`);
      else if (d.maxAge != null && now - (latest._ts || 0) > Number(AGE.exec(String(d.maxAge))[1]) * AGE_MS[AGE.exec(String(d.maxAge))[2].toLowerCase()])
        done('stale', `eval ${evalId}: the last result is older than ${d.maxAge}`);
      else if (latest.outcome !== 'pass') done('failing', `eval ${evalId} failed: ${latest.reason || 'a threshold was not met'}`);
      else done('passing', '');
    }
    return rows;
  }
  function evalClauses({ model, evals, ledger, now }) {
    const clauses = [], said = new Set(), seen = new Set(), names = new Set(elementsOf(model).map(e => e.name));
    for (const e of evals) {
      if (!e || typeof e !== 'object') continue;
      if (seen.has(e.id) && !said.has(e.id)) { said.add(e.id); clauses.push({ kind: 'duplicate', text: `duplicate id ${e.id}`, eval: e.id }); }
      seen.add(e.id);
      const problems = evalProblems(e);
      if (problems.length) clauses.push({ kind: 'eval', text: `eval ${e.id} is invalid: ${problems.join('; ')}`, evalId: e.id });
      if (typeof e.agent === 'string' && e.agent.trim() && !names.has(e.agent)) clauses.push({ kind: 'eval', text: `eval ${e.id}: agent "${e.agent}" is not in the model`, evalId: e.id, about: [e.agent] });
    }
    for (const r of evalReport({ model, evals, ledger, now })) {
      if (!r.blocking || r.defInvalid) continue;
      clauses.push({ kind: 'eval', text: `${r.agent} (${r.autonomy}) needs a passing eval: ${r.reason}`, agent: r.agent, evalId: r.evalId || null, about: [r.agent] });
    }
    return clauses;
  }

  Object.assign(Core, { scenarioReport, utilityTree, agentTopology, latestFitness, parseThreshold, scoreEval, evalHash, evalReport, evalClauses });
})(typeof module === 'object' && typeof require === 'function' ? require('./core.js') : Core);
