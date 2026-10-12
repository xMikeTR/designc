/* designc desktop: Work view. Classic script after gitview.js, shares the renderer's global scope with app.js.
   Work items are files in work/ (renderer/work.js holds the rules). This file loads them, draws the Work view
   and runs Start, Run gates and Done. Done is refused unless designc can check the evidence itself: an agent's
   claim is never evidence. Every HTML string passes file content through esc(). */
const WK = { refused: {}, busy: false };

const WORK_TEMPLATE = id => `id: ${id}
title: ""
# A repo item names a requirement and the design elements it changes.
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
  A.work = []; A.workErrors = [];
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
    for (const m of Work.validate(it, { requirements: A.requirements, items: ids.filter(x => x !== String(it.id)) })) A.workErrors.push({ path: it._path, line: 1, msg: m });
    if (seen.has(it.id)) A.workErrors.push({ path: it._path, line: 1, msg: `${it.id}: duplicate work item id` });
    seen.add(it.id);
  }
}

const workStates = () => Work.states(A.work || [], A.ledger || []);
const workRel = it => it.repo || (Work.isRepo(it) ? null : '.');
const entryText = e => { const k = Work.KINDS.find(x => e && e[x] !== undefined); return k ? `${k}: ${e[k]}` : '(empty entry)'; };

function workSidebar() {
  if (!A.work) return '<div class="hint">Loading work items…</div>';
  const st = workStates(), n = s => A.work.filter(i => st[i.id] === s).length;
  const rows = A.work.map(i => `<div class="item" data-file="${esc(i._path)}"><div class="l1"><span class="id">${esc(i.id)}</span><span class="tag">${esc(st[i.id])}</span></div><div class="l2">${esc(i.title || (i.target ? `${Object.keys(i.target)[0] || 'target'}` : i.requirement) || '')}</div></div>`).join('');
  return section('work', `Work items (${A.work.length})`, rows || '<div class="hint">No work items yet. New item writes work/&lt;id&gt;.yaml.</div>',
    '<button title="New work item" data-work="new">+</button>') +
    `<div class="hint">${n('backlog')} backlog · ${n('active')} active · ${n('done')} done. Done is accepted only when the commit is on main and every gate passed at it.</div>`;
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
      : e && e.judge !== undefined ? ' <span class="desc">shown, never required</span>' : '';
    return `<li>${esc(text)}${note}</li>`;
  }).join('');
  const what = it.target ? `${esc(Object.keys(it.target)[0] || '')} ${esc(Object.values(it.target)[0] || '')}` : `${esc(it.requirement || '')} · ${esc((it.elements || []).join(', '))}`;
  const btn = [`<button class="btn" data-file="${esc(it._path)}">Open file</button>`];
  if (state === 'backlog') btn.unshift(`<button class="btn primary" data-work="start" data-id="${esc(it.id)}" ${problems.length ? 'disabled title="Fix the problems in the file first"' : ''}>Start</button>`);
  if (state === 'active') btn.unshift(`<button class="btn" data-work="gates" data-id="${esc(it.id)}" ${WK.busy ? 'disabled' : ''}>Run gates</button>`, `<button class="btn primary" data-work="done" data-id="${esc(it.id)}">Done</button>`);
  return `<div class="block" data-workitem="${esc(it.id)}"><h3><span class="id">${esc(it.id)}</span> ${esc(it.title || '')}<span class="spacer"></span><span class="tag">${esc(state)}</span></h3>
    <div class="note">${what}${it.repo ? ` · repo ${esc(it.repo)}` : ''}</div>
    ${dw ? `<ul>${dw}</ul>` : ''}
    ${problems.map(m => `<div class="note" style="color:var(--err)">${esc(m)}</div>`).join('')}
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
    ${group('active', 'Active')}${group('backlog', 'Backlog')}${group('done', 'Done')}</div>`;
}

async function workNew() {
  const title = await askText('What is this work? (a short title)'); if (title == null) return;
  const id = Core.slugId(`W ${title}`.trim(), new Set((A.work || []).map(i => i.id)));
  const text = WORK_TEMPLATE(id).replace('title: ""', `title: ${yamlStr(title.trim())}`);
  await host.write(`work/${id}.yaml`, text); A.tree = await host.tree();
  await openFile(`work/${id}.yaml`); await loadWork(); renderAll({ keepEditor: true });
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
  const problems = [...notes, ...Work.doneProblems(it, { events: A.ledger, commit, onMain, ticks })];
  WK.refused[id] = problems;
  if (problems.length) {
    toast(`${id} is not done: ${problems.length} thing${problems.length === 1 ? '' : 's'} missing. See the Work view.`, 'warning');
    if (A.active !== 'special:work') openSpecial('special:work');
    return renderAll({ keepEditor: true });
  }
  const evidence = [...(it.done_when || []).filter(e => e && e.gate !== undefined).map(e => `gate:${e.gate}${commit ? `@${commit.slice(0, 7)}` : ''}`), ...ticks];
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
});
