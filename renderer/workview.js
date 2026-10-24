/* designc desktop: Work view. Classic script after gitview.js, shares the renderer's global scope with app.js.
   Work items are files in work/ (renderer/work.js holds the rules). This file loads them, draws the Work view
   and runs Start, Run gates and Done. Done is refused unless designc can check the evidence itself: an agent's
   claim is never evidence. Every HTML string passes file content through esc(). */
const WK = { refused: {}, busy: false, recheck: {}, models: {}, modelRef: null, rechecking: false,
  digest: null, onMain: {}, sig: null, digesting: false };

const WORK_TEMPLATE = id => `id: ${id}
title: ""
# A repo item names a requirement (or several: [HRE-1, HRE-2]) and the design elements it changes.
requirement: TODO
elements: []
# repo: ../my-repo            # defaults to designc.json codebase
writes: []                    # path patterns this item changes, for the conflict check
depends_on: []
done_when:
  - gate: "TODO a command that exits 0 when this is done"
# For work with no repo, replace requirement and elements with one of:
# target: { document: "https://..." }   or   { jira: "HRE-123" }   or   { investigation: "the question" }
`;

async function loadWork() {
  A.work = []; A.workErrors = []; A.workWarnings = [];
  await loadParityScenarios();
  let files = [];
  try { files = await host.list('work', ['.yaml', '.yml']); } catch { files = []; }
  for (const f of files) {
    try {
      const o = jsyaml.load(textOf(f.path) ?? f.text) || {};
      if (typeof o !== 'object' || Array.isArray(o)) throw new Error('expected a mapping at the top level');
      A.work.push({ ...o, id: o.id || f.path.split('/').pop().replace(/\.ya?ml$/, ''), _path: f.path });
    } catch (e) { A.workErrors.push({ path: f.path, line: (e.mark && e.mark.line + 1) || 1, msg: e.reason || e.message }); }
  }
  A.work.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const ids = A.work.map(i => String(i.id));
  const seen = new Set();
  for (const it of A.work) {
    for (const m of Work.validate(it, { requirements: A.requirements, items: ids.filter(x => x !== String(it.id)), scenarios: A.parityIds })) A.workErrors.push({ path: it._path, line: 1, msg: m });
    if (seen.has(it.id)) A.workErrors.push({ path: it._path, line: 1, msg: `${it.id}: duplicate work item id` });
    seen.add(it.id);
  }
  for (const u of Work.coverage(A.work, A.requirements)) {
    const r = A.requirements.find(x => x.id === u.requirement);
    A.workWarnings.push({ ...u, path: r && r._path || `requirements/${u.requirement}.yaml`, msg: `Requirement ${u.requirement} lists ${u.element} but no work item covers it. Add it to an item or make a new item.` });
  }
  refreshDigest();
}

const workStates = () => Work.states(A.work || [], A.ledger || []);
const workRel = it => it.repo || (Work.isRepo(it) ? null : '.');
const entryText = e => { const k = Work.KINDS.find(x => e && e[x] !== undefined); return k ? `${k}: ${e[k]}` : '(empty entry)'; };

const workFrozen = () => Work.frozenBy(A.ledger || []);
// designc.json work.wip: how many items may be active at once (default 3). The freeze horizon is that plus two.
const workWip = () => { const n = Number((A.cfg.work || {}).wip); return Number.isInteger(n) && n >= 0 ? n : 3; };
function horizonNote() {
  const h = Work.horizon(A.work || [], workStates(), workFrozen(), workWip());
  return `<div class="hint"${h.over ? ' style="color:var(--warn)"' : ''}>${h.frozen} frozen and not done. The freeze horizon is the WIP limit plus two (${h.limit}). ${h.over ? 'You are past it: finish or re-plan before freezing more, because frozen designs go stale.' : 'Freeze small; the rest of the design can wait.'}</div>`;
}

// ---------------------------------------------------------------- digest 
const lastLookKey = () => `designc.lastLook:${A.root ? (A.root.root || A.root.name) : ''}`;
function lastLook() { try { return Number(localStorage.getItem(lastLookKey())) || 0; } catch { return 0; } }
function markLooked() { try { localStorage.setItem(lastLookKey(), String(Date.now())); } catch { /* no storage: the digest keeps everything */ } }

// Recomputes the four buckets, checks "on main" for the commits claimed done, and notifies when the first two
// buckets (needs a decision, failed a gate) hold something new. The first computation only sets the baseline.
async function refreshDigest() {
  if (WK.digesting || !A.work || !A.ledger) return;
  WK.digesting = true;
  try {
    const st = workStates();
    for (const it of A.work.filter(i => st[i.id] === 'done' && Work.isRepo(i))) {
      const dn = A.ledger.filter(e => e.kind === 'item_done' && e.item === it.id).pop();
      if (!dn || !dn.commit || WK.onMain[dn.commit] === true) continue;
      try { const r = await host.workOnMain(workRel(it), dn.commit); WK.onMain[dn.commit] = r && !r.error ? r.onMain : null; } catch { WK.onMain[dn.commit] = null; }
    }
    const d = Work.digest({ items: A.work, states: st, events: A.ledger, onMain: WK.onMain, wip: workWip(), lastLook: lastLook(), scenarios: A.parityIds || [] });
    const sig = Work.digestSignature(d), changed = WK.sig !== null && sig !== WK.sig;
    const had = WK.digest && JSON.stringify(WK.digest) !== JSON.stringify(d);
    WK.digest = d;
    if (changed && (d.needs.length || d.failed.length)) {
      try { new Notification('designc', { body: `${plural(d.needs.length, 'item')} need a decision, ${plural(d.failed.length, 'item')} failed a gate.` }); } catch { /* no notifications here */ }
    }
    WK.sig = sig;
    renderBadges();
    if (had !== false && A.active === 'special:work') renderAll({ keepEditor: true });
  } finally { WK.digesting = false; }
}

function digestHtml() {
  const d = WK.digest;
  if (!d) return '';
  const row = (inner) => `<li>${inner}</li>`;
  const open = it => it ? ` <button class="lnk" data-file="work/${esc(it)}.yaml">Open ${esc(it)}</button>` : '';
  const needs = d.needs.map(n => row(`${esc(n.text)}${n.element ? ` <span class="desc">on ${esc(n.element)}</span>` : ''} <span class="desc">${esc(when(n.ts))}</span>${n.kind === 'needs_decision' ? `${ndOptionsHtml(n.id)} <button class="lnk" data-ndans="${esc(n.id)}">Answer with a decision</button> <button class="lnk" data-ndres="${esc(n.id)}">Mark resolved</button>` : n.kind === 'parked_run' ? ` ${resumeButton(n.id)}<button class="lnk" data-a="builddash">Show in Build</button>${n.handover ? ` <button class="lnk" data-hvclose="${esc(n.handover)}" data-outcome="abandoned" title="The run will not be resumed: its handover's spend becomes final">Close handover</button>` : ''}` : open(n.item)}`)).join('');
  const failed = d.failed.map(f => row(`${esc(f.text)}${open(f.item)}`)).join('');
  const done = d.done.map(x => row(`${esc(x.item)}${x.commit ? ` <span class="desc">at ${esc(String(x.commit).slice(0, 7))}</span>` : ''}${open(x.item)}`)).join('');
  const waiting = d.waiting.map(w => row(`${esc(w.text)}${open(w.item)}`)).join('');
  const sec = (title, body, hint) => `<div class="note"><b>${esc(title)}</b>${body ? `<ul>${body}</ul>` : `<div class="desc">${esc(hint)}</div>`}</div>`;
  return `<div class="block"><h3>Digest<span class="spacer"></span><button class="btn" data-work="seen" title="Clears Done since last look. What needs you stays until it is answered or closed">Mark as seen</button></h3>
    ${sec(`Needs a decision (${d.needs.length})`, needs, 'Nothing waits for you.')}
    ${sec(`Failed a gate (${d.failed.length})`, failed, 'No gate is failing and no claimed done is unproven.')}
    ${sec(`Done since last look (${d.done.length})`, done, 'Nothing finished since you last looked.')}
    ${sec(`Waiting (${d.waiting.length})`, waiting, `Nothing is held back. ${d.wip.active} active, WIP limit ${d.wip.limit}.`)}</div>`;
}

// Has the design moved under each frozen item ? Runs after render, re-renders once when a
// result changed, and records `item_recheck` only when the answer for that handover differs from the last one.
const recheckKey = (it, frozen) => `${frozen[it.id].handover}|${JSON.stringify([it.elements, it.requirement])}|${A.decisions.map(d => d.id + d.status).join()}`;
async function refreshRecheck() {
  if (WK.rechecking || !A.work || !A.model) return;
  if (WK.modelRef !== A.model) { WK.modelRef = A.model; WK.recheck = {}; }
  const frozen = workFrozen(), st = workStates();
  const todo = A.work.filter(i => Work.isRepo(i) && frozen[i.id] && st[i.id] !== 'done' && (WK.recheck[i.id] || {}).key !== recheckKey(i, frozen));
  if (!todo.length) return;
  WK.rechecking = true;
  try {
    for (const it of todo) {
      const key = recheckKey(it, frozen);
      const h = A.handovers.find(x => x.id === frozen[it.id].handover);
      if (!h || !h.model || !Array.isArray(h.in_scope)) { WK.recheck[it.id] = { unknown: true, key }; continue; }
      if (!WK.models[h.id]) { const t = await host.read(`handovers/${h.id}/${h.model}`); WK.models[h.id] = t ? Core.parse(t) : null; }
      if (!WK.models[h.id]) { WK.recheck[it.id] = { unknown: true, key }; continue; }
      const r = Core.workRecheck({ item: it, frozen: { model: WK.models[h.id], inScope: h.in_scope, requirements: h.requirements || [] },
        model: A.model, decisions: A.decisions, requirements: A.requirements });
      WK.recheck[it.id] = { ...r, handover: h.id, key };
      const text = JSON.stringify(r.reasons.map(x => x.text));
      const last = (A.ledger || []).filter(e => e.kind === 'item_recheck' && e.item === it.id).pop();
      if (!last || last.handover !== h.id || last.stale !== r.stale || JSON.stringify(last.reasons) !== text) {
        await recordEvent('item_recheck', { item: it.id, handover: h.id, stale: r.stale, reasons: r.reasons.map(x => x.text) });
      }
    }
  } finally { WK.rechecking = false; }
  renderAll({ keepEditor: true });
}

// The gate as this item sees it, or null when the item cannot be judged yet (no gate, not a repo item, problems in its file).
function itemGate(it) {
  if (!A.gate || !A.model || !Work.isRepo(it)) return null;
  return Core.scopedGate(A.gate, { model: A.model, elements: it.elements || [], requirement: Work.reqs(it), decisions: A.decisions });
}

function workSidebar() {
  if (!A.work) return '<div class="hint">Loading work items…</div>';
  const st = workStates(), n = s => A.work.filter(i => st[i.id] === s).length;
  const rows = A.work.map(i => `<div class="item" data-file="${esc(i._path)}"><div class="l1"><span class="id">${esc(i.id)}</span><span class="tag">${esc(st[i.id])}</span></div><div class="l2">${esc(i.title || (i.target ? `${Object.keys(i.target)[0] || 'target'}` : Work.reqs(i).join(', ')) || '')}</div></div>`).join('');
  return section('work', `Work items (${A.work.length})`, rows || '<div class="hint">No work items yet. New item writes work/&lt;id&gt;.yaml.</div>',
    '<button title="New work item" data-work="new">+</button>') +
    horizonNote() +
    `<div class="hint">${n('backlog')} backlog · ${n('active')} active · ${n('done')} done. Done is accepted only when the commit is on main and every gate passed at it.</div>`;
}

// The requirement files an item names that exist.
const itemReqs = it => Work.isRepo(it) ? Work.reqs(it).map(id => (A.requirements || []).find(x => x.id === id)).filter(Boolean) : [];

// Elements this item names that none of its requirements lists.
function outOfScope(it) {
  const rs = itemReqs(it);
  return rs.length ? (it.elements || []).filter(el => !rs.some(r => (r.elements || []).includes(el))) : [];
}

function scopeBlockHtml() {
  const w = A.workWarnings || [];
  if (!w.length) return '';
  const rows = w.map(u => `<li>${esc(u.element)} <span class="desc">of ${esc(u.requirement)}, in no item</span> <button class="btn" data-work="additem" data-req="${esc(u.requirement)}" data-el="${esc(u.element)}">Add to item</button> <button class="btn" data-work="newfor" data-req="${esc(u.requirement)}" data-el="${esc(u.element)}">New item</button></li>`).join('');
  return `<div class="block"><h3>Not covered by any item (${w.length})</h3><div class="note">These requirement elements have no work item. Nothing will build them until one does.</div><ul>${rows}</ul></div>`;
}

function recheckHtml(it, froze) {
  const r = froze && WK.recheck[it.id];
  if (!r) return '';
  if (r.unknown) return '<div class="note">Cannot re-check: the handover this item was frozen as has no model copy or scope record.</div>';
  if (!r.stale) return '<div class="note">Design unchanged for this item since it was frozen.</div>';
  return `<div class="note" style="color:var(--warn)"><b>The design moved since this item was frozen (${plural(r.reasons.length, 'reason')}).</b><ul>${r.reasons.map(x => `<li>${esc(x.text)}</li>`).join('')}</ul>Review the change, then Freeze again.</div>`;
}

function judgeNote(itemId, judge, doneCommit) {
  const j = Work.judgeScore(A.ledger || [], itemId, String(judge), doneCommit || null);
  if (!j) return ' <span class="desc">shown, never required</span>';
  return ` <span class="desc">score ${esc(String(j.score))} against ${esc(String(j.threshold))}, ${esc(j.outcome)}${j.stale ? ' (taken at another commit, stale)' : ''}; shown, never required</span>`;
}

function workItemHtml(it, st, active) {
  const state = st[it.id] || 'backlog';
  const problems = A.workErrors.filter(e => e.path === it._path).map(e => e.msg);
  const refused = WK.refused[it.id] || [];
  const clashes = state === 'backlog' ? Work.conflicts(it, active) : [];
  const deps = (it.depends_on || []).filter(d => st[d] !== 'done');
  const done = (A.ledger || []).filter(e => e.kind === 'item_done' && e.item === it.id).pop();
  const gateLast = cmd => (A.ledger || []).filter(e => e.kind === 'item_gate' && e.item === it.id && e.gate === cmd).pop();
  const dw = (Array.isArray(it.done_when) ? it.done_when : []).map(e => {
    const text = entryText(e), g = e && e.gate !== undefined ? gateLast(e.gate) : null;
    const note = g ? ` <span class="desc">last run ${esc(g.outcome)} at ${esc(String(g.commit || 'no commit').slice(0, 7))}${g.dirty ? ' (uncommitted changes, does not count)' : ''}</span>`
      : e && e.judge !== undefined ? judgeNote(it.id, e.judge, done && done.commit)
      : e && e.parity !== undefined ? parityNote(e) : '';
    return `<li>${esc(text)}${note}</li>`;
  }).join('');
  const what = it.target ? `${esc(Object.keys(it.target)[0] || '')} ${esc(Object.values(it.target)[0] || '')}` : `${esc(Work.reqs(it).join(', '))} · ${esc((it.elements || []).join(', '))}`;
  const sg = !problems.length ? itemGate(it) : null;
  const froze = workFrozen()[it.id];
  const btn = [`<button class="btn" data-file="${esc(it._path)}">Open file</button>`];
  const ds = froze && state !== 'done' ? dispatchSetting() : null;
  if (ds) btn.unshift(ds.error ? `<button class="btn" disabled title="${esc(ds.error)}">Dispatch</button>`
    : `<button class="btn" data-work="dispatch" data-id="${esc(it.id)}" title="${esc(dispatchTitle(ds, froze.handover))}">${esc(ds.label)}</button>`);
  if (sg && state !== 'done') btn.unshift(`<button class="btn" data-work="freeze" data-id="${esc(it.id)}" ${sg.ready ? '' : 'disabled title="Clear the blocking items below first"'}>${froze ? 'Freeze again' : 'Freeze item'}</button>`);
  if (state === 'backlog') btn.unshift(`<button class="btn primary" data-work="start" data-id="${esc(it.id)}" ${problems.length ? 'disabled title="Fix the problems in the file first"' : ''}>Start</button>`);
  if (state === 'active') btn.unshift(`<button class="btn" data-work="gates" data-id="${esc(it.id)}" ${WK.busy ? 'disabled' : ''}>Run gates</button>`, `<button class="btn primary" data-work="done" data-id="${esc(it.id)}">Done</button>`);
  return `<div class="block" data-workitem="${esc(it.id)}"><h3><span class="id">${esc(it.id)}</span> ${esc(it.title || '')}<span class="spacer"></span><span class="tag">${esc(state)}</span></h3>
    <div class="note">${what}${it.repo ? ` · repo ${esc(it.repo)}` : ''}</div>
    ${dw ? `<ul>${dw}</ul>` : ''}
    ${problems.map(m => `<div class="note" style="color:var(--err)">${esc(m)}</div>`).join('')}
    ${outOfScope(it).map(el => `<div class="note"><button class="btn" data-work="addreq" data-id="${esc(it.id)}" data-el="${esc(el)}">Add ${esc(el)} to ${esc(Work.reqs(it).length === 1 ? Work.reqs(it)[0] : 'a requirement')}</button></div>`).join('')}
    ${recheckHtml(it, froze)}
    ${froze ? `<div class="note">Frozen as <button class="lnk" data-file="handovers/${esc(froze.handover)}/handover.yaml">${esc(froze.handover)}</button> at ${esc(froze.revision)}.</div>` : ''}
    ${sg && state !== 'done' ? (sg.ready
      ? `<div class="note">Gate for this item: ready.${sg.outside ? ` ${plural(sg.outside, 'blocking clause')} elsewhere in the design ${sg.outside === 1 ? 'does' : 'do'} not touch it.` : ''}</div>`
      : `<div class="note" style="color:var(--warn)"><b>Gate for this item: ${plural(sg.clauses.length, 'blocking clause')}.</b><ul>${sg.clauses.slice(0, 6).map(c => `<li>${esc(c.text)}</li>`).join('')}</ul>${sg.clauses.length > 6 ? `and ${sg.clauses.length - 6} more. ` : ''}<button class="btn" data-work="gate">Show gate</button></div>`) : ''}
    ${clashes.map(c => `<div class="note" style="color:var(--warn)">Conflicts with ${esc(c.with)}: ${esc(c.detail)}</div>`).join('')}
    ${deps.map(d => `<div class="note" style="color:var(--warn)">Depends on ${esc(d)}, which is not done.</div>`).join('')}
    ${refused.length ? `<div class="note" style="color:var(--err)"><b>Not done yet:</b><ul>${refused.map(m => `<li>${esc(m)}</li>`).join('')}</ul></div>` : ''}
    ${done ? `<div class="note">Done by ${esc(done.by || '')}${done.commit ? ` at commit ${esc(String(done.commit).slice(0, 7))}` : ''}.</div>` : ''}
    <div class="ta">${btn.join('')}</div></div>`;
}

function renderWork() {
  const el = $('#special');
  if (!A.work) { el.innerHTML = '<div class="note">Loading work items…</div>'; return; }
  const st = workStates();
  const group = (s, title) => {
    const items = A.work.filter(i => st[i.id] === s);
    const active = A.work.filter(i => st[i.id] === 'active');
    return `<h2>${esc(title)} (${items.length})</h2>${items.map(i => workItemHtml(i, st, active)).join('') || '<div class="note">None.</div>'}`;
  };
  el.innerHTML = `<div class="dash"><div class="block"><h3>Work<span class="spacer"></span><button class="btn primary" data-work="new">New item</button></h3>
    <div class="note">One file per request in <code>work/</code>. Start pulls an item into active work and warns about clashes. Done is accepted only when the commit is on <code>${esc((A.cfg.work || {}).mainBranch || 'main')}</code> and every gate passed at that commit: what an agent says is never evidence.</div></div>
    ${digestHtml()}${scopeBlockHtml()}${group('active', 'Active')}${group('backlog', 'Backlog')}${group('done', 'Done')}</div>`;
  refreshRecheck();
  refreshDigest();
}

async function workNew(prefill) {
  const title = await askText('What is this work? (a short title)', prefill ? `Build ${prefill.elements.join(', ')}` : ''); if (title == null) return;
  const id = Core.slugId(`W ${title}`.trim(), new Set((A.work || []).map(i => i.id)));
  let text = WORK_TEMPLATE(id).replace('title: ""', `title: ${yamlStr(title.trim())}`);
  if (prefill) text = text.replace('requirement: TODO', `requirement: ${prefill.requirement}`).replace('elements: []', `elements: ${JSON.stringify(prefill.elements)}`);
  await host.write(`work/${id}.yaml`, text); A.tree = await host.tree();
  await openFile(`work/${id}.yaml`); await loadWork(); recompile(); renderAll({ keepEditor: true });
}

// Human only, like binding: it edits a requirement, which the gate reads.
async function workAddToRequirement(id, el) {
  const it = (A.work || []).find(i => i.id === id), rs = it ? itemReqs(it) : [];
  const rid = rs.length === 1 ? rs[0].id : rs.length ? await askChoice(`Which requirement should list ${el}?`, rs.map(r => ({ label: `${r.id}${r.title ? `: ${trunc(r.title, 50)}` : ''}`, value: r.id }))) : null;
  const r = rs.find(x => x.id === rid);
  if (!r || !r._path) return;
  if (!confirm(`Add ${el} to requirement ${r.id}?\n\nThis changes ${r._path}. If the requirement now means something different, bump its version yourself so decisions promoted against it are checked again.`)) return;
  const done = await editYaml(r._path, t => Work.addToList(t, 'elements', el));
  if (done === null) toast(`Could not edit the elements list in ${r._path}. Add ${el} by hand.`, 'warning');
}

async function workAddToItem(req, el) {
  const st = workStates();
  const open = (A.work || []).filter(i => Work.isRepo(i) && Work.reqs(i).includes(req) && st[i.id] !== 'done');
  if (!open.length) return toast(`Every item of ${req} is done. Make a new item for ${el}.`, 'warning');
  const id = open.length === 1 ? open[0].id : await askChoice(`Which item should change ${el}?`, open.map(i => ({ label: `${i.id}${i.title ? `: ${trunc(i.title, 50)}` : ''}`, value: i.id })));
  const it = open.find(i => i.id === id); if (!it) return;
  const done = await editYaml(it._path, t => Work.addToList(t, 'elements', el));
  if (done === null) toast(`Could not edit the elements list in ${it._path}. Add ${el} by hand.`, 'warning');
}

async function workStart(id) {
  const it = (A.work || []).find(i => i.id === id); if (!it) return;
  if (A.workErrors.some(e => e.path === it._path)) return toast(`${id} has problems. Fix the file first, see Problems.`, 'warning');
  const st = workStates();
  const clashes = Work.conflicts(it, A.work.filter(i => st[i.id] === 'active'));
  const deps = (it.depends_on || []).filter(d => st[d] !== 'done');
  if (clashes.length || deps.length) {
    const lines = [...clashes.map(c => `Conflicts with ${c.with}: ${c.detail}`), ...deps.map(d => `Depends on ${d}, which is not done`)];
    if (!confirm(`${id} may clash with work in progress:\n\n${lines.join('\n')}\n\nStart it anyway?`)) return;
  }
  await recordEvent('item_pulled', { item: id });
  toast(`Started ${id}.`, 'info');
}

// Repo state for an item, or null after saying what to do.
async function workHead(it) {
  if (!Work.isRepo(it) && !it.repo) return { commit: null, branch: null, dirty: false };
  const h = await host.workHead(workRel(it));
  if (h.error) { toast(h.error, 'warning', /Trust this folder/.test(h.error) ? [{ label: 'Trust folder', run: async () => { await host.gitTrust(); renderAll({ keepEditor: true }); } }] : []); return null; }
  return h;
}

async function workRunGates(id) {
  const it = (A.work || []).find(i => i.id === id); if (!it || WK.busy) return;
  const gates = (it.done_when || []).filter(e => e && e.gate !== undefined).map(e => String(e.gate));
  if (!gates.length) return toast(`${id} has no gate to run.`, 'warning');
  const h = await workHead(it); if (!h) return;
  WK.busy = true; showPanel('output'); renderAll({ keepEditor: true });
  try {
    appendOutput(`\n── ${new Date().toLocaleTimeString()}  gates for ${id}${h.commit ? ` at ${h.commit.slice(0, 7)}` : ''}${h.dirty ? ' (uncommitted changes: results will not count)' : ''}\n`);
    for (const cmd of gates) {
      const problem = Policy.checkProblem(cmd);
      if (problem) { appendOutput(`\n⚠ ${cmd}\nNot run. ${problem}\n`); continue; }
      appendOutput(`\n▶ $ ${cmd}\n`);
      const r = await host.workRun(`work-${id}-${Date.now()}`, workRel(it), cmd);
      if (r.error) { appendOutput(`${r.error}\n`); toast(r.error, 'warning'); return; }
      if (r.cancelled) { appendOutput('Cancelled: folder not trusted.\n'); return; }
      const ok = r.code === 0;
      appendOutput(`${ok ? '✓ passed' : `✗ failed (exit ${r.code})`} in ${(r.ms / 1000).toFixed(1)}s\n`);
      await recordEvent('item_gate', { item: id, gate: cmd, outcome: ok ? 'pass' : 'fail', source: 'local', commit: h.commit, dirty: h.dirty, ms: r.ms, ...(ok ? {} : { exit_code: r.code }) });
    }
  } finally { WK.busy = false; renderAll({ keepEditor: true }); }
}

async function workDone(id) {
  const it = (A.work || []).find(i => i.id === id); if (!it) return;
  const repo = Work.isRepo(it);
  let commit = null, onMain = null; const notes = [];
  if (repo) {
    const h = await workHead(it); if (!h) return;
    const c = await askText(`Which commit finished ${id}? Full or short hash. It must be on ${(A.cfg.work || {}).mainBranch || 'main'}.`, h.commit || '');
    if (c == null) return;
    commit = c.trim();
    const r = commit ? await host.workOnMain(workRel(it), commit) : { error: null };
    if (r.error) notes.push(r.error); else if (commit) { onMain = r.onMain; commit = r.commit; }
  }
  const ticks = [];
  for (const e of (it.done_when || [])) {
    const k = Work.KINDS.find(x => e && e[x] !== undefined);
    if (k !== 'checklist' && k !== 'review') continue;
    if (confirm(`${id}\n\n${k === 'review' ? `Has ${e[k]} reviewed this?` : `Is this true: ${e[k]}?`}\n\nOK records that you checked it.`)) ticks.push(Work.entryKey(e));
  }
  const problems = [...notes, ...Work.doneProblems(it, { events: A.ledger, commit, onMain, ticks, scenarios: A.parityIds || [] })];
  WK.refused[id] = problems;
  if (problems.length) {
    toast(`${id} is not done: ${problems.length} thing${problems.length === 1 ? '' : 's'} missing. See the Work view.`, 'warning');
    if (A.active !== 'special:work') openSpecial('special:work');
    return renderAll({ keepEditor: true });
  }
  const evidence = [...(it.done_when || []).filter(e => e && e.gate !== undefined).map(e => `gate:${e.gate}${commit ? `@${commit.slice(0, 7)}` : ''}`),
    ...(it.done_when || []).filter(e => e && e.parity !== undefined).flatMap(e => Work.parityIds(e, A.parityIds || [])).map(sc => `parity:${sc}${commit ? `@${commit.slice(0, 7)}` : ''}`), ...ticks];
  await recordEvent('item_done', { item: id, commit: repo ? commit : null, evidence });
  toast(`${id} is done.`, 'info');
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-work]'); if (!t || t.disabled) return;
  const id = t.dataset.id;
  if (t.dataset.work === 'new') workNew();
  else if (t.dataset.work === 'start') workStart(id);
  else if (t.dataset.work === 'gates') workRunGates(id);
  else if (t.dataset.work === 'done') workDone(id);
  else if (t.dataset.work === 'freeze') { const it = (A.work || []).find(i => i.id === id); if (it) freezeHandover(it); }
  else if (t.dataset.work === 'dispatch') { const it = (A.work || []).find(i => i.id === id), f = workFrozen()[id]; if (it && f) dispatchHandover(f.handover, it); }
  else if (t.dataset.work === 'gate') setActivity('design');
  else if (t.dataset.work === 'seen') { markLooked(); WK.digest = null; refreshDigest(); }
  else if (t.dataset.work === 'addreq') workAddToRequirement(id, t.dataset.el);
  else if (t.dataset.work === 'additem') workAddToItem(t.dataset.req, t.dataset.el);
  else if (t.dataset.work === 'newfor') workNew({ requirement: t.dataset.req, elements: [t.dataset.el] });
});
