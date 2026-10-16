/* designc desktop: work items. Pure, no I/O, no dependencies.
   Dual-load like renderer/policy.js: <script src="work.js"> in the renderer, require('./renderer/work.js')
   from tests. A work item is a file in work/: one request, tracked by hand. designc never trusts a claim
   that it is done: Done is judged here from recorded evidence (gate runs at a commit, ticks) and from
   whether that commit is on main (checked by git, passed in as `onMain`). */
const Work = (() => {
  const PP = typeof PathPattern !== 'undefined' ? PathPattern : require('./pathpattern.js');
  const LG = typeof Ledger !== 'undefined' ? Ledger : require('./ledger.js');
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
      const req = requirements.find(r => r.id === item.requirement);
      if (!req) out.push(`${id}: requirement ${item.requirement} does not exist in requirements/.`);
      if (!list(item.elements).length) out.push(`${id}: a repo item needs elements, the design elements it changes.`);
      if (req) {
        for (const el of list(item.elements)) {
          if (!list(req.elements).includes(el)) out.push(`${id}: ${el} is not an element of requirement ${item.requirement}. Add it to the requirement, or take it out of this item.`);
        }
      }
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

  // Requirement elements no work item of that requirement covers (done items count). Only requirements
  // that already have a repo item are judged, so a registry that does not use work items stays quiet.
  function coverage(items, requirements) {
    const out = [];
    for (const r of list(requirements)) {
      const mine = list(items).filter(i => isRepo(i) && i.requirement === r.id);
      if (!mine.length) continue;
      for (const el of list(r.elements)) {
        if (!mine.some(i => list(i.elements).includes(el))) out.push({ requirement: r.id, element: el, items: mine.map(i => i.id) });
      }
    }
    return out;
  }

  // Adds value to the YAML list at top-level `key` in a file's text, changing no other line. Returns the
  // text, or null when the list is written in a way that cannot be edited safely (the caller says so).
  function addToList(text, key, value) {
    const v = /^[A-Za-z0-9][A-Za-z0-9 _./()-]*$/.test(value) ? value : JSON.stringify(value);
    const lines = String(text).split('\n');
    const at = lines.findIndex(l => l.startsWith(`${key}:`));
    if (at < 0) return String(text).replace(/\s*$/, '') + `\n${key}: [${v}]\n`;
    const rest = lines[at].slice(key.length + 1).replace(/\s+#.*$/, '').trim();
    if (rest.startsWith('[')) {
      if (!rest.endsWith(']')) return null;
      const inner = rest.slice(1, -1).trim();
      const have = inner ? inner.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(x => x.trim().replace(/^"(.*)"$/, '$1')) : [];
      if (have.includes(value)) return text;
      lines[at] = `${key}: [${inner ? `${inner}, ` : ''}${v}]`;
      return lines.join('\n');
    }
    if (rest === '') {
      let end = at + 1, have = [];
      while (end < lines.length && /^\s*-\s/.test(lines[end])) { have.push(lines[end].replace(/^\s*-\s+/, '').trim().replace(/^"(.*)"$/, '$1')); end++; }
      if (have.includes(value)) return text;
      const ind = end > at + 1 ? lines[end - 1].match(/^\s*/)[0] : '  ';
      lines.splice(end, 0, `${ind}- ${v}`);
      return lines.join('\n');
    }
    return null;
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

  // The handover each item was last frozen into: handover events that name an item (ROADMAP slice 24).
  function frozenBy(events) {
    const out = {};
    for (const e of list(events).filter(x => x.kind === 'handover' && x.item != null).sort((a, b) => (a._ts || 0) - (b._ts || 0)))
      out[e.item] = { handover: e.handover, revision: e.revision };
    return out;
  }

  // Frozen and not done: plan big, freeze small. The horizon is the WIP limit plus two, so a frozen design is
  // never far ahead of what people are building and does not go stale waiting.
  function horizon(items, st, frozen, wip) {
    const n = list(items).filter(i => isRepo(i) && frozen[i.id] && st[i.id] !== 'done').length;
    const limit = Number(wip) + 2;
    return { frozen: n, limit, over: n > limit };
  }


  // The four buckets a person looks at (ROADMAP slice 26), from the ledger and from what designc could check.
  // `events` is the derived ledger (a needs_decision already carries its resolved status); `onMain` maps a
  // commit to true, false or null (could not be checked, then it is not judged); `lastLook` is epoch ms.
  // An agent's claim is never evidence: a done item whose commit is not on main, or that names no evidence,
  // is shown as failed rather than done.
  function digest({ items = [], states = {}, events = [], onMain = {}, wip = 3, lastLook = 0 } = {}) {
    const ev = list(events).slice().sort((a, b) => (a._ts || 0) - (b._ts || 0));
    const after = (kinds, item, ts) => ev.some(e => kinds.includes(e.kind) && e.item === item && (e._ts || 0) > ts);
    const c7 = c => String(c || '').slice(0, 7);
    const needs = [];
    for (const e of ev) {
      if (e.kind === 'needs_decision' && e.status === 'open') needs.push({ kind: 'needs_decision', id: e.id, item: e.task || null, element: e.element || null, text: e.question, ts: e._ts || 0 });
      if (e.kind === 'item_awaiting_human' && !after(['item_pulled', 'item_gate', 'item_done'], e.item, e._ts || 0)) {
        needs.push({ kind: 'awaiting_human', id: null, item: e.item, element: null, text: `${e.item} is waiting for a person${e.reason ? `: ${e.reason}` : ''}`, ts: e._ts || 0 });
      }
      // A pipeline run that stopped for a person (`parked`), until the run starts again, ends another way or its handover is closed.
      if (e.kind === 'run_ended' && e.status === 'parked' && !ev.some(x => (((x.kind === 'run_started' || x.kind === 'run_ended') && x.run === e.run) || (x.kind === 'handover_closed' && x.handover === e.handover)) && (x._ts || 0) > (e._ts || 0))) {
        // Parked on a needs-decision a person has since answered: the run can resume.
        const answered = LG.parkedOn(ev, e.reason).find(x => x.status === 'resolved');
        const text = answered ? `Run ${e.run} of ${e.handover} is parked on ${answered.id}, which has been answered: resume the run, or close its handover if it will not be resumed`
          : `Run ${e.run} of ${e.handover} is parked${e.reason ? `: ${e.reason}` : ''}`;
        needs.push({ kind: 'parked_run', id: e.run, handover: e.handover || null, item: null, element: null, answered: answered ? answered.id : null, text, ts: e._ts || 0 });
      }
    }
    const failed = [];
    for (const it of list(items)) {
      const st = states[it.id];
      if (st === 'active') {
        for (const d of list(it.done_when)) {
          if (!d || d.gate === undefined) continue;
          const last = ev.filter(e => e.kind === 'item_gate' && e.item === it.id && e.gate === d.gate).pop();
          if (last && last.outcome === 'fail') failed.push({ item: it.id, kind: 'gate', text: `${it.id}: gate "${d.gate}" failed${last.commit ? ` at ${c7(last.commit)}` : ''}`, ts: last._ts || 0 });
        }
      }
      if (st === 'done') {
        const dn = ev.filter(e => e.kind === 'item_done' && e.item === it.id).pop();
        if (!dn) continue;
        if (dn.commit && onMain[dn.commit] === false) failed.push({ item: it.id, kind: 'not_on_main', text: `${it.id}: Claimed merged, not on main (${c7(dn.commit)})`, ts: dn._ts || 0 });
        else if (!list(dn.evidence).length) failed.push({ item: it.id, kind: 'no_evidence', text: `${it.id}: Claimed done without evidence`, ts: dn._ts || 0 });
      }
    }
    // A pipeline's UI acceptance failure stands until the same task later passes a gate or is done. The task id is the item id.
    const latestAc = new Map();
    for (const e of ev) if (e.kind === 'ui_acceptance_failed') latestAc.set(`${e.task}\0${e.ac}`, e);
    for (const e of latestAc.values()) {
      const cleared = ev.some(x => x.item === e.task && (x.kind === 'item_done' || (x.kind === 'item_gate' && x.outcome === 'pass')) && (x._ts || 0) > (e._ts || 0));
      if (!cleared) failed.push({ item: e.task, kind: 'acceptance', text: `${e.task}: acceptance ${e.ac} failed on ${e.element} at ${c7(e.commit)}`, ts: e._ts || 0 });
    }
    const failedItems = new Set(failed.map(f => f.item));
    const done = ev.filter(e => e.kind === 'item_done' && (e._ts || 0) > lastLook && states[e.item] === 'done' && !failedItems.has(e.item))
      .map(e => ({ item: e.item, commit: e.commit || null, ts: e._ts || 0 }));
    const limitEv = ev.filter(e => e.kind === 'wip_limit_changed' && Number.isFinite(Number(e.limit))).pop();
    const limit = limitEv ? Number(limitEv.limit) : Number(wip);
    const active = list(items).filter(i => states[i.id] === 'active');
    const backlog = list(items).filter(i => (states[i.id] || 'backlog') === 'backlog');
    const waiting = [];
    for (const it of backlog) {
      for (const c of conflicts(it, active)) waiting.push({ item: it.id, kind: 'conflict', text: `${it.id} conflicts with ${c.with}: ${c.detail}` });
      for (const d of list(it.depends_on).filter(x => states[x] !== 'done')) waiting.push({ item: it.id, kind: 'dependency', text: `${it.id} depends on ${d}, which is not done` });
      const def = ev.filter(e => e.kind === 'item_conflict_deferred' && e.item === it.id).pop();
      if (def && !after(['item_pulled'], it.id, def._ts || 0)) waiting.push({ item: it.id, kind: 'deferred', text: `${it.id} was deferred${def.reason ? `: ${def.reason}` : ''}` });
    }
    // A pipeline's budget row: the latest per item decides; a later item_pulled clears it. Never needs-you or failed.
    const latestBudget = new Map();
    for (const e of ev) if (e.kind === 'item_budget') latestBudget.set(e.item, e);
    for (const e of latestBudget.values()) {
      if (e.status === 'within' || after(['item_pulled'], e.item, e._ts || 0)) continue;
      const spent = e.spent_tokens !== undefined && e.limit_tokens !== undefined ? ` (${e.spent_tokens} of ${e.limit_tokens} tokens)` : '';
      waiting.push({ item: e.item, kind: 'budget', text: `${e.item} budget ${e.status}${spent}${e.reason ? `: ${e.reason}` : ''}` });
    }
    if (backlog.length && active.length >= limit) waiting.push({ item: null, kind: 'wip', text: `${active.length} active against a WIP limit of ${limit}: ${backlog.length} ${backlog.length === 1 ? 'item waits' : 'items wait'}` });
    return { needs, failed, done, waiting, wip: { limit, active: active.length } };
  }

  // The latest pipeline judge score for one item and judge entry. A judge is a gradient: shown, never a gate.
  // `stale` when the score was taken at a commit other than the one the item was declared done at.
  function judgeScore(events, item, judge, doneCommit) {
    const e = list(events).filter(x => x.kind === 'item_judge' && x.item === item && x.judge === judge)
      .sort((a, b) => (a._ts || 0) - (b._ts || 0)).pop();
    if (!e) return null;
    return { score: e.score, threshold: e.threshold, outcome: e.outcome, commit: e.commit === undefined ? null : e.commit, stale: !!doneCommit && e.commit !== doneCommit };
  }

  // What a desktop notification is allowed to react to: only the first two buckets.
  function digestSignature(d) {
    return JSON.stringify([d.needs.map(n => [n.kind, n.id, n.item, n.ts]), d.failed.map(f => [f.item, f.kind, f.ts])]);
  }

  return { KINDS, TARGETS, isRepo, entryKey, validate, states, conflicts, coverage, addToList, doneProblems, frozenBy, horizon, digest, digestSignature, judgeScore };
})();
if (typeof module !== 'undefined') module.exports = Work;
