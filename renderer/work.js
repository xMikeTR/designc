/* designc desktop: work items. Pure, no I/O, no dependencies.
   Dual-load like renderer/policy.js: <script src="work.js"> in the renderer, require('./renderer/work.js')
   from tests. A work item is a file in work/: one request, tracked by hand. designc never trusts a claim
   that it is done: Done is judged here from recorded evidence (gate runs at a commit, ticks) and from
   whether that commit is on main (checked by git, passed in as `onMain`). */
const Work = (() => {
  const PP = typeof PathPattern !== 'undefined' ? PathPattern : require('./pathpattern.js');
  const KINDS = ['gate', 'checklist', 'review', 'judge'];
  const TARGETS = ['document', 'jira', 'investigation'];

  const isRepo = item => !item.target;
  const entryKind = e => KINDS.filter(k => e && e[k] !== undefined);
  const entryKey = e => { const [k] = entryKind(e); return `${k}:${String(e[k]).trim()}`; };
  const short = c => String(c).slice(0, 7);
  const list = v => (Array.isArray(v) ? v : []);

  // What is wrong with this work item file. Plain sentences, each saying what to change.
  function validate(item, { requirements = [], items = [] } = {}) {
    const out = [];
    const id = item && item.id ? item.id : '(no id)';
    if (!item || typeof item !== 'object') return ['The work item is not a mapping.'];
    if (!item.id) out.push('The work item has no id.');
    const hasReq = item.requirement != null && item.requirement !== '';
    const hasTarget = item.target != null;
    if (hasReq === hasTarget) out.push(`${id}: name either a requirement (with elements) or a target, not both and not neither.`);
    if (hasTarget) {
      const keys = item.target && typeof item.target === 'object' ? Object.keys(item.target) : [];
      if (keys.length !== 1 || !TARGETS.includes(keys[0]) || !String(item.target[keys[0]] || '').trim()) {
        out.push(`${id}: target must have one of document, jira or investigation, with a value.`);
      }
    }
    if (hasReq) {
      if (!requirements.some(r => r.id === item.requirement)) out.push(`${id}: requirement ${item.requirement} does not exist in requirements/.`);
      if (!list(item.elements).length) out.push(`${id}: a repo item needs elements, the design elements it changes.`);
    }
    for (const d of list(item.depends_on)) {
      if (!items.includes(d)) out.push(`${id}: depends_on ${d} is not a work item.`);
    }
    for (const w of list(item.writes)) {
      const r = PP.create(w);
      if (!r.ok) out.push(`${id}: writes entry is not a path pattern: ${r.error}`);
    }
    const dw = list(item.done_when);
    if (!dw.length) out.push(`${id}: done_when is empty; say what done means with at least one gate, checklist or review entry.`);
    let kinds = [];
    dw.forEach((e, i) => {
      const ks = e && typeof e === 'object' ? Object.keys(e) : [];
      const known = ks.filter(k => KINDS.includes(k));
      const unknown = ks.filter(k => !KINDS.includes(k));
      if (unknown.length) out.push(`${id}: done_when entry ${i + 1} has unknown kind ${unknown.join(', ')}; use gate, checklist, review or judge.`);
      else if (known.length !== 1) out.push(`${id}: done_when entry ${i + 1} must have exactly one of gate, checklist, review or judge.`);
      else if (!String(e[known[0]] == null ? '' : e[known[0]]).trim()) out.push(`${id}: done_when entry ${i + 1} (${known[0]}) is empty.`);
      else kinds.push(known[0]);
    });
    if (kinds.includes('judge') && kinds.every(k => k === 'judge')) {
      out.push(`${id}: a judge cannot be the only done_when entry; add a gate, checklist or review (a judge is a gradient, not a decision).`);
    }
    if (hasReq && dw.length && !kinds.includes('gate') && !(kinds.length && kinds.every(k => k === 'judge'))) {
      out.push(`${id}: a repo item needs a gate in done_when (a command that passes at the commit).`);
    }
    return out;
  }

  // backlog until pulled, active until done. The ledger decides; the file does not carry state.
  function states(items, events) {
    const out = {};
    const ev = list(events).slice().sort((a, b) => (a._ts || 0) - (b._ts || 0));
    for (const it of items) {
      let s = 'backlog';
      for (const e of ev) {
        if (e.item !== it.id) continue;
        if (e.kind === 'item_pulled') s = 'active';
        else if (e.kind === 'item_done') s = 'done';
      }
      out[it.id] = s;
    }
    return out;
  }

  // Which of the other items clash with this one, and why.
  function conflicts(item, others) {
    const out = [];
    for (const o of list(others)) {
      if (o.id === item.id) continue;
      const aw = list(item.writes).map(w => PP.create(w)).filter(r => r.ok).map(r => r.value);
      const bw = list(o.writes).map(w => PP.create(w)).filter(r => r.ok).map(r => r.value);
      const hit = aw.flatMap(a => bw.filter(b => PP.mayOverlap(a, b)).map(b => `${a} and ${b}`))[0];
      if (hit) { out.push({ with: o.id, reason: 'writes', detail: `writes may overlap: ${hit}` }); continue; }
      const el = list(item.elements).find(e => list(o.elements).includes(e));
      if (el) { out.push({ with: o.id, reason: 'element', detail: `both change ${el}` }); continue; }
      if (item.target && o.target) {
        const [k] = Object.keys(item.target);
        if (o.target[k] !== undefined && String(o.target[k]) === String(item.target[k])) {
          out.push({ with: o.id, reason: 'target', detail: `both target ${k} ${item.target[k]}` });
        }
      }
    }
    return out;
  }

  // Everything still missing before this item may be recorded done. [] means it may.
  // events: ledger events; commit: the commit being declared done (repo items); onMain: true, false or
  // null (could not be checked); ticks: entryKey strings a person ticked.
  function doneProblems(item, { events = [], commit = null, onMain = null, ticks = [] } = {}) {
    const out = [];
    const repo = isRepo(item);
    if (repo) {
      if (!commit) out.push('No commit given: say which commit finished this item.');
      else if (onMain === false) out.push(`Commit ${short(commit)} is not on main. Merge it first; if it is merged, fetch in the repo and try again.`);
      else if (onMain !== true) out.push(`Could not check that commit ${short(commit)} is on main. Check the repo path and branch in the work item or designc.json.`);
    }
    const ev = list(events).filter(e => e.kind === 'item_gate' && e.item === item.id)
      .sort((a, b) => (a._ts || 0) - (b._ts || 0));
    for (const e of list(item.done_when)) {
      const [k] = entryKind(e);
      if (k === 'gate') {
        const mine = ev.filter(g => g.gate === e.gate && (!repo || g.commit === commit));
        const last = mine[mine.length - 1];
        const ok = last && last.outcome === 'pass' && !last.dirty;
        if (!ok) out.push(`${e.gate} has no passing run${repo && commit ? ` at ${short(commit)}` : ''}. Run it from the Work view.`);
      } else if (k === 'checklist' || k === 'review') {
        if (!list(ticks).includes(entryKey(e))) out.push(`${k === 'review' ? 'Review by' : 'Checklist'}: ${e[k]} is not ticked.`);
      }
    }
    return out;
  }

  return { KINDS, TARGETS, isRepo, entryKey, validate, states, conflicts, doneProblems };
})();
if (typeof module !== 'undefined') module.exports = Work;
