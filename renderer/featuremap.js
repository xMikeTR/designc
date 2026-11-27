/* designc desktop: the feature map (features/<id>.yaml). Pure, no I/O.
   Dual-load like renderer/work.js: <script src="featuremap.js"> in the renderer (after parity.js), require('./renderer/featuremap.js') from tests.
   A feature file says what a user can do, how they reach it and what end state proves it (docs/feature-map-contract.md).
   This module reads one file and checks a set of them (checks 1 to 4 of the contract, codes FM001 to FM004). It never runs
   app code and never writes. The codes are Problems rows, not Core.RULES and not gate clauses. */
const FeatureMap = (() => {
  const PA = typeof Parity !== 'undefined' ? Parity : require('./parity.js');
  const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  const STEP_KEYS = [...PA.ACTIONS, 'press', 'wait'];
  const CODES = { ids: 'FM001', states: 'FM002', grammar: 'FM003', proof: 'FM004' };
  const READ_ONLY = ['GET', 'HEAD'];

  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const isStr = v => typeof v === 'string' && v.trim() !== '';
  const baseName = p => String(p || '').replace(/\\/g, '/').split('/').pop().replace(/\.ya?ml$/i, '');
  const q = s => `"${s}"`;

  // ---------- read ----------
  // One file. {record, errors[{line, msg}]}: a YAML mapping, or why it is not one. Never throws.
  function parseFile(path, text, yamlLoad) {
    let o;
    try { o = yamlLoad(typeof text === 'string' ? text : String(text == null ? '' : text)); }
    catch (e) { return { record: null, errors: [{ line: (e && e.mark && Number.isFinite(e.mark.line) ? e.mark.line + 1 : 1), msg: `${path} does not parse: ${(e && (e.reason || e.message)) || 'invalid YAML'}` }] }; }
    if (!isObj(o)) return { record: null, errors: [{ line: 1, msg: `${path} is not a mapping. A feature file is one mapping with id, title, intent, screens, journeys.` }] };
    return { record: o, errors: [] };
  }

  // ---------- helpers shared by the checks ----------
  const specOf = (ctx, screen) => (ctx.specs && isObj(ctx.specs) && isObj(ctx.specs[screen]) ? ctx.specs[screen] : null);
  const statesOf = spec => (spec && isObj(spec.states) ? Object.keys(spec.states) : []);
  const transitionsOf = spec => (spec && Array.isArray(spec.transitions) ? spec.transitions.filter(isObj) : []);
  // The states reachable from the spec's one initial state over every transition; null when it has not exactly one (ui.js says so).
  function reachable(spec) {
    const names = statesOf(spec);
    const initial = names.filter(n => isObj(spec.states[n]) && spec.states[n].initial);
    if (initial.length !== 1) return null;
    const edges = new Map();
    for (const t of transitionsOf(spec)) edges.set(t.from, [...(edges.get(t.from) || []), t.to]);
    const seen = new Set(initial), todo = [...initial];
    while (todo.length) for (const n of edges.get(todo.pop()) || []) if (!seen.has(n)) { seen.add(n); todo.push(n); }
    return seen;
  }
  // "<screen>:<state>" or a bare state name.
  function ref(raw) {
    if (!isStr(raw)) return null;
    const s = raw.trim(), i = s.indexOf(':');
    return i < 0 ? { screen: null, state: s } : { screen: s.slice(0, i).trim(), state: s.slice(i + 1).trim() };
  }
  const stepState = st => (isObj(st) && isStr(st.state) ? st.state : null);
  const list = v => (Array.isArray(v) ? v : []);
  const screensOf = rec => list(rec.screens).filter(isStr).map(s => s.trim());

  // Walk a journey's states: where it starts and, per step that names a state, the state before and after.
  // `bad` collects references to a screen that is not one of the feature's screens (FM002's to report).
  function walk(rec, j) {
    const screens = screensOf(rec);
    const from = ref(j.from);
    let cur = from && from.screen ? { screen: from.screen, state: from.state } : null;
    const hops = [];
    list(j.steps).forEach((st, i) => {
      const s = stepState(st);
      if (s == null) return;
      const r = ref(s);
      const screen = r.screen || (cur ? cur.screen : null);
      const after = { screen, state: r.state, qualified: !!r.screen };
      hops.push({ index: i + 1, before: cur, after, raw: s });
      cur = { screen, state: r.state };
    });
    return { from, hops, end: cur, screens };
  }

  // ---------- the checks ----------
  function problems(features, ctx = {}) {
    const out = [];
    const C = ctx || {};
    const reach = new Map();
    const reachOf = screen => { if (!reach.has(screen)) reach.set(screen, reachable(specOf(C, screen))); return reach.get(screen); };
    const files = list(features).filter(f => f && isObj(f.record));
    const byId = new Map();
    for (const f of files) if (isStr(f.record.id)) byId.set(f.record.id.trim(), [...(byId.get(f.record.id.trim()) || []), f.path]);

    for (const f of files) {
      const rec = f.record;
      const id = isStr(rec.id) ? rec.id.trim() : '(no id)';
      const add = (check, msg) => out.push({ path: f.path, line: 1, code: CODES[check], msg: `${id}: ${msg}` });
      checkIds(rec, f, byId, C, add);
      checkJourneys(rec, C, reachOf, add);
    }
    return out;
  }

  // FM001: ids and references.
  function checkIds(rec, f, byId, C, add) {
    const base = baseName(f.path);
    if (!isStr(rec.id)) add('ids', 'the file has no id. Add id: ' + base + ' (a slug equal to the file name).');
    else {
      const id = rec.id.trim();
      if (!SLUG.test(id)) add('ids', `the id must be a slug of lower-case letters, digits and single hyphens, like export-bordereaux. Change ${q(id)}.`);
      else if (id !== base) add('ids', `the id must equal the file name. Rename the file to ${id}.yaml or change the id to ${base}.`);
      const same = byId.get(id) || [];
      if (same.length > 1) add('ids', `the id is used by more than one file (${same.join(' and ')}). Give each feature its own id and file.`);
    }
    for (const k of ['title', 'intent']) if (!isStr(rec[k])) add('ids', `${k} must be a non-empty sentence. Add ${k}.`);
    if (!Array.isArray(rec.screens) || !rec.screens.length || !rec.screens.every(isStr)) add('ids', 'screens must be a non-empty list of screen names (the files in ui/specs/).');
    else if (C.specs && isObj(C.specs)) for (const s of rec.screens) if (!Object.prototype.hasOwnProperty.call(C.specs, s.trim())) add('ids', `screen ${q(s)} has no spec in ui/specs/. Name a screen that has one or mint the spec first.`);
    if (rec.aliases != null && (!Array.isArray(rec.aliases) || !rec.aliases.every(isStr))) add('ids', 'aliases must be a list of the words a user would use for this feature.');
    const refs = (key, known, where) => {
      if (rec[key] == null) return;
      if (!Array.isArray(rec[key]) || !rec[key].every(isStr)) return add('ids', `${key} must be a list of ids.`);
      if (known == null) return;
      const set = known instanceof Set ? known : new Set(known.map(String));
      for (const x of rec[key]) if (!set.has(x.trim())) add('ids', `${key} names ${q(x.trim())}, which is not ${where}. Fix the id or remove it.`);
    };
    refs('elements', C.elements, 'an element in the model');
    refs('requirements', C.requirements, 'a requirement in requirements/');
    refs('acceptance', C.acceptance, 'a criterion in acceptance/');
    refs('test_scenarios', C.testScenarios, 'a scenario in test-scenarios/');
  }

  // A step is the bare word entry, or exactly one action. Returns what is wrong, or null.
  function stepProblem(step, { allowEntry = true } = {}) {
    if (step === 'entry') return allowEntry ? null : 'an entry point goes through one real step, not the word entry';
    if (!isObj(step)) return `a step is the word entry or a mapping with one of ${STEP_KEYS.join(', ')}`;
    const ks = STEP_KEYS.filter(k => step[k] !== undefined);
    if (ks.length !== 1) return `a step needs exactly one of ${STEP_KEYS.join(', ')}`;
    const [k] = ks;
    if (PA.ACTIONS.includes(k)) return PA.stepProblem(step);
    if (step.state != null && !isStr(step.state)) return 'state must be a name for the screen state after this step';
    const a = step[k];
    if (k === 'press') return isStr(a) ? null : 'press needs the keys to press, like Control+E';
    if (!isObj(a)) return 'wait needs a mapping with role and name, or text';
    for (const x of ['role', 'name', 'text']) if (a[x] != null && !isStr(a[x])) return `wait ${x} must be a non-empty string`;
    if (a.name == null && a.text == null) return 'wait needs a name or a text (text is for a status or live region, which has no accessible name)';
    if (a.name != null && a.text != null) return 'wait takes name or text, not both (text is not the accessible name)';
    if (a.name != null && a.role == null) return 'wait with a name needs a role';
    return null;
  }

  // Every {param: x} object anywhere under a value.
  function paramsIn(v, acc = []) {
    if (Array.isArray(v)) v.forEach(x => paramsIn(x, acc));
    else if (isObj(v)) { if (Object.keys(v).length === 1 && typeof v.param === 'string') acc.push(v.param); else Object.values(v).forEach(x => paramsIn(x, acc)); }
    return acc;
  }

  // FM002, FM003, FM004 over journeys and entry points.
  function checkJourneys(rec, C, reachOf, add) {
    const screens = screensOf(rec);
    const pre = rec.preconditions;
    let declared = new Set();
    if (pre != null) {
      if (!isObj(pre)) add('grammar', 'preconditions must be a mapping with role and data.');
      else {
        if (pre.role != null && !isStr(pre.role)) add('grammar', 'preconditions.role must be the sign-in the app runs as.');
        if (pre.data != null) {
          if (!isObj(pre.data)) add('grammar', 'preconditions.data must map each name to {param: name}.');
          else { declared = new Set(Object.keys(pre.data)); for (const [k, v] of Object.entries(pre.data)) if (!(isObj(v) && typeof v.param === 'string')) add('grammar', `preconditions.data.${k} must be {param: name}; values come from the environment, never the file.`); }
        }
      }
    }
    const useParams = (where, v) => { for (const p of new Set(paramsIn(v))) if (!declared.has(p)) add('grammar', `${where} uses {param: ${p}}, which preconditions.data does not declare. Declare ${p} there.`); };

    // a from: "<screen>:<state>", the screen one of the feature's, the state a state of its spec, reachable from the initial state.
    const fromProblem = (where, raw) => {
      const r = ref(raw);
      if (!r || !r.screen || !r.state) return add('states', `${where} from must be <screen>:<state>, like ${screens[0] || 'orders'}:ready.`);
      if (!screens.includes(r.screen)) return add('states', `${where} from names screen ${q(r.screen)}, which is not one of this feature's screens (${screens.join(', ') || 'none listed'}).`);
      const spec = specOf(C, r.screen);
      if (!spec) return;
      if (!statesOf(spec).includes(r.state)) return add('states', `${where} from names state ${q(r.state)}, which the ${r.screen} spec does not have. Its states are ${statesOf(spec).join(', ')}.`);
      const seen = reachOf(r.screen);
      if (seen && !seen.has(r.state)) add('states', `${where} from ${q(r.screen + ':' + r.state)} cannot be reached from the ${r.screen} spec's initial state. Add a transition into it or start from a state a user can reach.`);
    };
    const stateProblem = (where, screen, state, raw) => {
      if (!screen) return;
      if (!screens.includes(screen)) return add('states', `${where} names screen ${q(screen)}, which is not one of this feature's screens (${screens.join(', ') || 'none listed'}).`);
      const spec = specOf(C, screen);
      if (spec && !statesOf(spec).includes(state)) add('states', `${where} names state ${q(raw)}, which the ${screen} spec does not have. Its states are ${statesOf(spec).join(', ')}.`);
    };

    // entry points
    const eps = rec.entry_points;
    const epIds = new Set();
    if (eps != null && !Array.isArray(eps)) add('grammar', 'entry_points must be a list of {id, from?, via}.');
    list(eps).forEach((e, i) => {
      const where = `entry point ${isObj(e) && isStr(e.id) ? q(e.id) : i + 1}`;
      if (!isObj(e)) return add('grammar', `${where} must be a mapping with id, from and via.`);
      if (!isStr(e.id) || !SLUG.test(e.id.trim())) add('grammar', `${where} needs an id that is a slug, like header-button.`);
      else if (epIds.has(e.id.trim())) add('grammar', `${where} repeats an id. Entry point ids are unique in a feature.`);
      else epIds.add(e.id.trim());
      if (e.from != null) fromProblem(where, e.from);
      if (e.via == null) add('grammar', `${where} needs via: the one step that reaches the feature.`);
      else { const p = stepProblem(e.via, { allowEntry: false }); if (p) add('grammar', `${where} via: ${p}.`); useParams(`${where} via`, e.via); }
    });

    // journeys
    if (!Array.isArray(rec.journeys) || !rec.journeys.length) { add('grammar', 'journeys must be a non-empty list. Add at least one journey with from, steps and proves.'); return; }
    const jIds = new Set();
    rec.journeys.forEach((j, i) => {
      const where = `journey ${isObj(j) && isStr(j.id) ? q(j.id) : i + 1}`;
      if (!isObj(j)) return add('grammar', `${where} must be a mapping with id, from, steps and proves.`);
      if (!isStr(j.id) || !SLUG.test(j.id.trim())) add('grammar', `${where} needs an id that is a slug, like export-filtered.`);
      else if (jIds.has(j.id.trim())) add('grammar', `${where} repeats an id. Journey ids are unique in a feature.`);
      else jIds.add(j.id.trim());
      if (!isStr(j.from)) add('grammar', `${where} needs from: <screen>:<state>.`);
      else fromProblem(where, j.from);
      if (!Array.isArray(j.steps)) add('grammar', `${where} needs steps, a list.`);
      const steps = list(j.steps);
      steps.forEach((st, k) => { const p = stepProblem(st); if (p) add('grammar', `${where} step ${k + 1}: ${p}.`); });
      if (steps.filter(s => s === 'entry').length > 1) add('grammar', `${where} has the entry marker more than once. Keep one: every entry point runs there.`);
      useParams(`${where} steps`, steps);

      // FM002 over the states the steps leave the app in, and the entry-point rule.
      const w = walk(rec, j);
      for (const h of w.hops) stateProblem(`${where} step ${h.index}`, h.after.screen, h.after.state, h.raw);
      if (!steps.includes('entry') && isStr(j.from)) for (const e of list(eps)) if (isObj(e) && isStr(e.from) && e.from.trim() !== j.from.trim()) add('states', `${where} has no entry marker, but entry point ${isStr(e.id) ? q(e.id) : ''} starts from ${q(e.from.trim())}, not ${q(j.from.trim())}. Add the entry marker where the entry points apply, or start them from the same state.`);

      // FM004 proof.
      const pr = j.proves;
      if (!isObj(pr) || !isObj(pr.ui) || !isStr(pr.ui.state)) add('proof', `${where} needs proves.ui.state: the state of the screen that shows it worked.`);
      else {
        const r = ref(pr.ui.state), screen = r.screen || (w.end ? w.end.screen : null);
        stateProblem(`${where} proves.ui`, screen, r.state, pr.ui.state);
        if (pr.ui.contains != null) {
          if (!Array.isArray(pr.ui.contains)) add('proof', `${where} proves.ui.contains must be a list of {role, name} or {role, text}.`);
          else pr.ui.contains.forEach((c, k) => { if (!(isObj(c) && isStr(c.role) && (isStr(c.name) !== isStr(c.text)))) add('proof', `${where} proves.ui.contains item ${k + 1} needs a role and exactly one of name or text.`); });
        }
      }
      const crossed = w.hops.find(h => h.before && h.before.screen === h.after.screen && transitionsOf(specOf(C, h.after.screen)).some(t => t.from === h.before.state && t.to === h.after.state && t.commits === true));
      const eff = isObj(pr) ? pr.effect : undefined;
      if (crossed && eff == null) add('proof', `${where} step ${crossed.index} crosses the ${q(crossed.before.state)} to ${q(crossed.after.state)} transition, which commits. Add proves.effect with a read-only api (GET) that shows it saved.`);
      if (eff != null) {
        const api = isObj(eff) ? eff.api : null;
        if (!isObj(api)) add('proof', `${where} proves.effect needs api: {method: GET, path: /...}.`);
        else {
          if (!READ_ONLY.includes(String(api.method))) add('proof', `${where} proves.effect.api.method must be GET or HEAD (the proof is a read-only second view), not ${q(String(api.method))}.`);
          if (typeof api.path !== 'string' || !api.path.startsWith('/')) add('proof', `${where} proves.effect.api.path must start with /.`);
        }
        if (isObj(eff) && eff.expect != null && !isObj(eff.expect)) add('proof', `${where} proves.effect.expect must be a mapping (status and shape).`);
      }
    });
  }

  return { parseFile, problems, stepProblem, CODES, SLUG, baseName };
})();
if (typeof module !== 'undefined') module.exports = FeatureMap;
