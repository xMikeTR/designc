/* designc: QA bugs against recorded parity (docs/parity-contract.md "QA bugs", cases in docs/parity-qa-cases.json).
   Pure and dual-loaded like parity.js, after it: a classic script in the renderer, require() from Node.
   It answers, for one screen, how many of the parity bugs QA logged the recorded behaviour catches, and why the rest
   were missed. Matching is by fixed rules over stored baselines and reports: never a model, never page data, and the
   report copies no bug text (QA descriptions may hold real data). Nothing here is a gate input or a ledger row. */
const ParityQa = (() => {
  const P = typeof Parity !== 'undefined' ? Parity : require('./parity.js');

  const KINDS = ['missing', 'text', 'format', 'state', 'order', 'visibility', 'look'];
  const BUCKETS = ['caught', 'not_captured', 'state_not_recorded', 'not_flagged', 'triage'];
  // parity.js finding kind -> grouped diff.
  const GROUP_OF = { missing: 'missing', extra: 'newOnly', text: 'divergent', shape: 'divergent', state: 'divergent', order: 'divergent', spacing: 'divergent', sort: 'divergent', filter: 'divergent', step: 'divergent' };
  // QA kind -> the finding kinds that catch it. look has none: this layer does not compare how things look.
  const FITS = { missing: ['missing'], visibility: ['missing', 'extra', 'filter'], text: ['text'], format: ['shape'], state: ['state'], order: ['order', 'sort'], look: [] };
  // A cell, a grid cell and its column header are one thing to QA: "the Inception column".
  const COLUMN = new Set(['cell', 'gridcell', 'columnheader']);

  const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const nameKey = s => P.volatile(s).toLowerCase();
  const roleKey = r => (COLUMN.has(r) ? 'column' : String(r || ''));
  const same = (where, role, name) => roleKey(where.role) === roleKey(role) && nameKey(where.name) === nameKey(name);
  const stateOf = (scenario, i) => {
    const st = ((scenario && scenario.steps) || [])[i];
    return st && typeof st.state === 'string' && st.state.trim() ? clean(st.state) : `${(scenario && scenario.id) || 'scenario'} step ${i + 1}`;
  };

  // A snapshot (baseline or the new app's) as rows: one per control per recorded step. Present is visible.
  // order is the position among siblings; format is a data shape or a field's value shape, else null.
  function behaviour(snapshot, scenario) {
    const rows = [];
    for (const [i, st] of ((snapshot && snapshot.steps) || []).entries()) {
      if (st.status !== 'ok' || !Array.isArray(st.elements)) continue;
      const state = stateOf(scenario, (st.n || i + 1) - 1);
      (function walk(els, base) {
        els.forEach((e, order) => {
          const key = base + e.key;
          rows.push({ state, step: st.n || i + 1, side: snapshot.side, key, role: e.role, name: e.data ? (e.column || '') : (e.name || ''), enabled: e.enabled !== false, order, format: e.shape || e.valueShape || null });
          walk(e.children || [], key + '/');
        });
      })(st.elements, '');
    }
    return rows;
  }

  // A compare() result as missing / divergent / new-only, plus what a requirement covers. Each finding gains its
  // step's state.
  function group(result, scenario) {
    const out = { missing: [], divergent: [], newOnly: [], covered: [] };
    for (const st of (result && result.steps) || []) {
      for (const f of st.findings || []) {
        const g = { ...f, step: st.n, state: stateOf(scenario, st.n - 1) };
        if (f.severity === 'covered') out.covered.push(g);
        else out[GROUP_OF[f.kind] || 'divergent'].push(g);
      }
    }
    return out;
  }

  const needsTriage = b => !b || !b.where || typeof b.where.role !== 'string' || typeof b.where.name !== 'string' || !KINDS.includes(b.kind);

  // parity/qa/<screen>.yaml: {screen?, bugs: [{key, description, actual, expected, screenshots[], where?, kind?, state?}]}.
  // opts: {parseYaml, file}. The screen defaults to the file name.
  function read(text, { parseYaml, file = '' } = {}) {
    const fromName = (String(file).split('/').pop() || '').replace(/\.ya?ml$/, '');
    let doc;
    try { doc = parseYaml(text); } catch (e) { return { screen: fromName, bugs: [], problems: [`${file || 'the QA file'} does not parse: ${e.reason || e.message}`] }; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { screen: fromName, bugs: [], problems: ['the QA file is not a mapping with a bugs list'] };
    const problems = [];
    const screen = doc.screen == null ? fromName : clean(doc.screen);
    if (fromName && screen !== fromName) problems.push(`screen is ${screen} but the file is named ${fromName}; name it parity/qa/${screen}.yaml`);
    if (!Array.isArray(doc.bugs)) { problems.push('bugs must be a list'); return { screen, bugs: [], problems }; }
    const seen = new Set();
    const bugs = [];
    doc.bugs.forEach((b, i) => {
      if (!b || typeof b !== 'object' || b.key == null || !clean(b.key)) { problems.push(`bug ${i + 1} needs a key (the QA ticket)`); return; }
      const key = clean(b.key);
      if (seen.has(key)) problems.push(`${key} is repeated`);
      seen.add(key);
      if (b.where != null && !(typeof b.where === 'object' && typeof b.where.role === 'string' && b.where.role && typeof b.where.name === 'string')) problems.push(`${key}: where needs a role and a name (the control's accessible name)`);
      if (b.kind != null && !KINDS.includes(b.kind)) problems.push(`${key}: kind must be one of ${KINDS.join(', ')}`);
      if (b.state != null && !(typeof b.state === 'string' && b.state.trim())) problems.push(`${key}: state must be the name of a scenario step's state`);
      const shots = b.screenshots == null ? [] : b.screenshots;
      if (!Array.isArray(shots)) problems.push(`${key}: screenshots must be a list`);
      else for (const s of shots) if (typeof s !== 'string' || !/^shots\/[^/\\]+$/.test(s) || s.includes('..')) problems.push(`${key}: screenshots go under shots/ beside the QA file (git ignores it), got ${JSON.stringify(s)}`);
      bugs.push({ ...b, key, ...(typeof b.state === 'string' ? { state: clean(b.state) } : {}), screenshots: Array.isArray(shots) ? shots : [] });
    });
    return { screen, bugs, problems };
  }

  const where = w => `${w.role} "${clean(w.name)}"`;

  // The UI graph (facts.ui, designc.ui.graph/1) of one side, for one screen, joined to what that side recorded (rows:
  // behaviour() rows of that side, any state). A control whose role the source shows joins by role and name ('role');
  // one with role null joins by its literal name to the one recorded control with that name and takes the recorder's
  // role ('name'); several recorded roles under that name is 'ambiguous' and none is taken; no literal name (a t() key or
  // an expression) is 'unnamed'; nothing recorded is 'unrecorded'. Never a guessed role. null when the graph lacks the screen.
  function fromCode(graph, screen, rows = []) {
    if (!graph || !(graph.screens || []).some(s => s.name === screen)) return null;
    const controls = (graph.controls || []).filter(c => c.screen === screen).map(c => {
      const base = { id: c.id, file: c.file, line: c.line, tag: c.tag, role: c.role || null, basis: c.basis || null, name: c.name == null ? null : c.name, when: c.when || [], props: c.props || {}, format: c.format || null, library: c.library || null };
      if (base.name == null || !clean(base.name)) return { ...base, join: 'unnamed', recorded: null };
      if (base.role) {
        const r = rows.find(x => same({ role: base.role, name: base.name }, x.role, x.name));
        return { ...base, join: r ? 'role' : 'unrecorded', recorded: r ? { role: r.role, name: r.name } : null };
      }
      const by = new Map();
      for (const x of rows) if (x.name && nameKey(x.name) === nameKey(base.name) && !by.has(roleKey(x.role))) by.set(roleKey(x.role), { role: x.role, name: x.name });
      if (by.size === 1) return { ...base, join: 'name', recorded: [...by.values()][0] };
      return { ...base, join: by.size ? 'ambiguous' : 'unrecorded', recorded: null, ...(by.size ? { candidates: [...by.values()].map(v => v.role) } : {}) };
    });
    const formats = (graph.formats || []).filter(f => f.screen === screen);
    const count = k => controls.filter(c => c.join === k).length;
    return { repo: graph.repo || null, controls, formats, joined: { role: count('role'), name: count('name'), ambiguous: count('ambiguous'), unnamed: count('unnamed'), unrecorded: count('unrecorded') } };
  }

  // The roles the UI graph lists controls for (extract/ui-roles.js WIDGET_ROLES): only for these does finding none in code say
  // anything; a heading, text or dialog is never a control there.
  const WIDGET = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'gridcell', 'scrollbar']);
  const fmtText = f => (f.pattern != null ? `${f.call} ${f.pattern}` : `${f.call}(${f.args || ''})`);
  // A control in code as text: file:line, the conditions it is shown under and its state props as source text, its format.
  function codeText(c) {
    const bits = [`${c.file}:${c.line}`];
    if (c.join === 'name') bits.push(`<${c.tag}> takes role ${c.recorded.role} from the recording`);
    if (c.when.length) bits.push(`shown when ${c.when.map(w => w.expr).join(' && ')}`);
    for (const [k, v] of Object.entries(c.props)) bits.push(v === true ? k : `${k} if ${v}`);
    if (c.format) bits.push(`format ${fmtText(c.format)}`);
    return bits.join(', ');
  }
  // What the code of each side says about a bug's control (and, for a format bug on a column, the screen's formats).
  function codeCite(b, code) {
    const out = {}, text = [];
    for (const [side, label] of [['legacy', 'legacy'], ['next', 'new']]) {
      const g = code[side];
      if (!g) continue;
      const cs = g.controls.filter(c => c.join !== 'ambiguous' && c.join !== 'unnamed' && same(b.where, c.role || (c.recorded && c.recorded.role), c.name));
      const fs = b.kind === 'format' && roleKey(b.where.role) === 'column' && !cs.some(c => c.format) ? g.formats : [];
      out[side] = { controls: cs.map(c => ({ file: c.file, line: c.line, join: c.join, when: c.when, props: c.props, format: c.format })), formats: fs.map(f => ({ file: f.file, line: f.line, lib: f.lib, call: f.call, pattern: f.pattern })) };
      if (cs.length) text.push(`${label} ${cs.slice(0, 2).map(codeText).join('; ')}`);
      else if (WIDGET.has(b.where.role)) text.push(`${label} code has no ${where(b.where)} on this screen`);
      if (fs.length) text.push(`${label} formats on the screen: ${fs.slice(0, 3).map(f => `${fmtText(f)} at ${f.file}:${f.line}`).join('; ')}`);
    }
    return text.length ? { code: out, text: `; in code: ${text.join('; ')}` } : null;
  }
  const parentOf = key => { const i = key.lastIndexOf('/'); return i < 0 ? '/' : key.slice(0, i + 1); };

  // One screen: {screen, scenarios, baselines {id: snapshot}, reports {id: {next, result}}, qa: read(), ui?}.
  // ui (optional) is the UI graph per side, {legacy, next}: facts.ui of each repo. With it, a bug that is not caught (state
  // not recorded, captured but not flagged) cites what the code of each side says about the control, and the result
  // carries code {legacy, next} from fromCode(). Without it the result is as before.
  // -> {screen, states, counts {bucket: n}, bugs [{key, bucket, reason, finding?, seen?, code?}], problems, code?}.
  function report({ screen, scenarios = [], baselines = {}, reports = {}, qa = { bugs: [], problems: [] }, ui = null }) {
    const problems = [...(qa.problems || [])];
    const mine = scenarios.filter(s => s && s.screen === screen);
    if (!mine.length) problems.push(`no scenario has screen: ${screen}, so nothing on it was recorded`);
    const steps = []; // {scenario, n, state, compared, reason}
    const rows = [];
    const findings = [];
    for (const s of mine) {
      (s.steps || []).forEach((_, i) => {
        const rs = (((reports[s.id] || {}).result || {}).steps || []).find(x => x.n === i + 1);
        steps.push({ scenario: s.id, n: i + 1, state: stateOf(s, i), compared: !!rs && rs.status === 'compared', reason: rs ? rs.reason || rs.status : baselines[s.id] ? 'no report from the new app' : 'no baseline' });
      });
      if (!baselines[s.id]) problems.push(`${s.id} has no baseline`);
      if (!reports[s.id] || !reports[s.id].result) problems.push(`${s.id} has no report from the new app`);
      const compared = new Set(steps.filter(x => x.scenario === s.id && x.compared).map(x => x.n));
      for (const r of [...behaviour(baselines[s.id], s), ...behaviour((reports[s.id] || {}).next, s)]) if (compared.has(r.step)) rows.push({ ...r, scenario: s.id });
      const g = group((reports[s.id] || {}).result, s);
      for (const f of [...g.missing, ...g.divergent, ...g.newOnly, ...g.covered]) findings.push({ ...f, scenario: s.id });
    }
    const states = [...new Set(steps.map(x => x.state))];

    const judge = b => {
      if (needsTriage(b)) return { bucket: 'triage', reason: 'needs where (role and name) and kind from a person before it can be matched' };
      if (b.kind === 'look') return { bucket: 'not_captured', reason: 'how it looks is not recorded by this layer; evidence for the vision checklist' };
      if (b.state && !states.includes(b.state)) return { bucket: 'state_not_recorded', reason: `no step on screen ${screen} has state: ${b.state}; add one to a scenario` };
      const inState = x => !b.state || x.state === b.state;
      const ran = steps.filter(x => inState(x) && x.compared);
      if (!ran.length) {
        const why = steps.filter(inState).map(x => `${x.scenario} step ${x.n}: ${x.reason}`).join('; ');
        return { bucket: 'state_not_recorded', reason: `${b.state ? `state ${b.state}` : 'no step'} was not compared on both apps (could not run: ${why || 'nothing recorded'})` };
      }
      const here = rows.filter(r => inState(r) && same(b.where, r.role, r.name));
      const hit = f => {
        if (!inState(f) || !FITS[b.kind].includes(f.kind)) return false;
        if (f.kind === 'order') return here.some(r => parentOf(r.key) === f.key && r.scenario === f.scenario && r.step === f.step);
        return f.role != null && (same(b.where, f.role, f.name) || (f.was != null && same(b.where, f.role, f.was)));
      };
      const fail = findings.find(f => f.severity !== 'covered' && hit(f));
      const pick = f => ({ scenario: f.scenario, step: f.step, state: f.state, kind: f.kind, key: f.key, msg: f.msg });
      if (fail) return { bucket: 'caught', reason: `${fail.scenario} step ${fail.step} (${fail.state}): ${fail.msg}`, finding: pick(fail) };
      const cov = findings.find(f => f.severity === 'covered' && hit(f));
      if (cov) return { bucket: 'not_flagged', reason: `recorded, but ${cov.by} allows it, so it is covered rather than failing: ${cov.msg}`, finding: pick(cov) };
      if (!here.length) {
        const near = [...new Set(rows.filter(r => inState(r) && (nameKey(r.name) === nameKey(b.where.name) || (roleKey(r.role) === roleKey(b.where.role) && r.name))).map(r => `${r.role} "${r.name}"`))].slice(0, 3);
        return { bucket: 'state_not_recorded', reason: `no ${where(b.where)} on either app${b.state ? ` in state ${b.state}` : ''}, so the scenario never reached it${near.length ? `; nearest: ${near.join(', ')}` : ''}` };
      }
      const side = s => { const r = here.find(x => x.side === s); return r ? { enabled: r.enabled, format: r.format, order: r.order } : null; };
      const seen = { legacy: side('legacy'), next: side('next') };
      const show = v => (v ? `${v.enabled ? 'enabled' : 'disabled'}${v.format ? `, ${v.format}` : ''}` : 'absent');
      return { bucket: 'not_flagged', reason: `${where(b.where)} was recorded (legacy ${show(seen.legacy)}; new ${show(seen.next)}) but no ${b.kind} rule flagged it`, seen };
    };

    let code = null;
    if (ui && (ui.legacy || ui.next)) {
      const all = { legacy: [], next: [] };
      for (const s of mine) {
        all.legacy.push(...behaviour(baselines[s.id], s));
        all.next.push(...behaviour((reports[s.id] || {}).next, s));
      }
      code = { legacy: fromCode(ui.legacy, screen, all.legacy), next: fromCode(ui.next, screen, all.next) };
    }
    const bugs = (qa.bugs || []).map(b => {
      const j = { key: b.key, ...judge(b) };
      if (!code || (j.bucket !== 'state_not_recorded' && j.bucket !== 'not_flagged') || needsTriage(b)) return j;
      const c = codeCite(b, code);
      return c ? { ...j, reason: j.reason + c.text, code: c.code } : j;
    });
    const counts = Object.fromEntries(BUCKETS.map(k => [k, bugs.filter(b => b.bucket === k).length]));
    return { screen, states, counts, bugs, problems, ...(code ? { code } : {}) };
  }

  return { KINDS, BUCKETS, GROUP_OF, FITS, WIDGET, behaviour, group, read, report, needsTriage, fromCode, codeText };
})();

if (typeof module !== 'undefined') module.exports = ParityQa;
