/* designc desktop: git UI (slice 1, read-only). Classic script, shares the renderer's global scope with app.js.
   app.js calls gitRefresh(), gitStatusButton(), gitHistorySection() and renderCompare(); everything git-shaped
   in the renderer lives here. All git output is untrusted text: it goes through esc() before innerHTML. */
const G = { state: { repo: false }, log: [], logFor: null, compare: null, diff: null, msg: '', busy: false, askedUnion: false, branches: [] };

async function gitRefresh() {
  if (!A.root) { G.state = { repo: false }; G.log = []; G.logFor = null; return; }
  try { G.state = await host.gitStatus(); } catch { G.state = { repo: false }; }
  G.logFor = null;
  if (G.state.trusted && !G.state.error) { const r = await host.gitRefs(); G.branches = r.branches || []; }
  renderStatus(); renderBadges();
  if ((A.activity === 'explorer' || A.activity === 'scm') && document.activeElement !== $('#gitMsg')) renderSidebar();
}
const gitRefreshSoon = debounce(gitRefresh, 400);

function gitStatusButton() {
  const s = G.state;
  if (!s.repo) return '';
  if (!s.trusted) return `<button data-git="trust" title="designc runs git only in folders you trust">Git: trust this folder</button>`;
  if (s.error) return `<button data-git="status" title="${esc(s.error)}">Git: error</button>`;
  const where = s.detached ? `detached at ${esc(String(s.head || '').slice(0, 7))}` : esc(s.branch || 'no commits yet');
  const sync = s.upstream ? ` ↑${s.ahead} ↓${s.behind}` : '';
  const n = (s.files || []).length;
  return `<button data-git="status" title="${esc(s.upstream ? 'Tracking ' + s.upstream : 'No upstream branch')}">${where}${sync}${n ? ` · ${n} changed` : ''}</button>`;
}

function gitFileFor(id) {
  return id && !id.startsWith('special:') && !id.startsWith('code:') ? id : null;
}

// History of the open file, shown under the explorer tree. The log is fetched lazily and the sidebar
// repaints when it arrives.
function gitHistorySection() {
  const s = G.state, rel = gitFileFor(A.active);
  if (!s.repo || !s.trusted || !rel) return '';
  if (G.logFor !== rel) {
    G.logFor = rel; G.log = null;
    host.gitLog(rel, 30).then(r => { if (G.logFor === rel) { G.log = r; if (A.activity === 'explorer') renderSidebar(); } });
  }
  let body;
  if (G.log == null) body = '<div class="hint">Loading history…</div>';
  else if (G.log.error) body = `<div class="hint">${esc(G.log.error)}</div>`;
  else if (!G.log.length) body = '<div class="hint">No commits touch this file yet.</div>';
  else body = G.log.map(c => `<div class="row" data-git="compare" data-hash="${esc(c.hash)}" data-rel="${esc(rel)}" title="Compare ${esc(rel)} with ${esc(c.short)}"><span class="lbl">${esc(c.subject)}</span><span class="desc">${esc(c.short)} · ${esc(c.author)} · ${esc(String(c.date).slice(0, 10))}</span></div>`).join('');
  return section('history', `History · ${rel.split('/').pop()}`, body);
}

// Compare the model with the copy in the newest handover. Needs no git: the handover folder holds the model
// as frozen, so this works in a folder that is not a repository.
function handoverCompareSection() {
  const h = Core.latestHandoverModel(A.handovers || []);
  if (!h || A.active !== A.cfg.model) return '';
  return section('hvcompare', 'Handover', `<div class="row" data-hv="compare" title="Compare ${esc(A.cfg.model)} with handover ${esc(h.id)}"><span class="lbl">Compare with last handover</span><span class="desc">${esc(h.id)}</span></div>`);
}

async function handoverOpenCompare() {
  const h = Core.latestHandoverModel(A.handovers || []);
  if (!h) return toast('No handover has been frozen yet.', 'warning');
  const text = await host.read(h.path);
  if (text == null) return toast(`${h.path} is missing. Restore the handover folder or freeze a new one.`, 'warning');
  G.compare = { rel: A.cfg.model, hash: h.id, short: `handover ${h.id}`, subject: 'Model as frozen in the last handover', left: text };
  if (A.active === 'special:compare') renderSpecial(); else openSpecial('special:compare');
}

async function gitOpenCompare(rel, hash) {
  const r = await host.gitShow(hash, rel);
  if (r.error) return toast(r.error, 'warning');
  const c = (Array.isArray(G.log) ? G.log : []).find(x => x.hash === hash);
  G.compare = { rel, hash, short: hash.slice(0, 7), subject: c ? c.subject : '', left: r.text };
  if (A.active === 'special:compare') renderSpecial(); else openSpecial('special:compare');
}

// Monaco diff editor: the revision on the left, the working copy on the right. Read-only on both sides.
// What changed in meaning, for a model file: elements and rels added, removed or changed, from
// Core.diffModels. Every name and value comes from file text, so all of it goes through esc().
function semanticDiffHtml(leftText, rightText) {
  const b = Core.parse(leftText), a = Core.parse(rightText);
  if (b.errors.length || a.errors.length) return `<div class="note">Semantic summary unavailable: ${b.errors.length ? 'the committed' : 'the working'} model has parse errors.</div>`;
  const d = Core.diffModels(b, a), S = d.summary;
  if (d.elements.length + d.rels.length === 0) return '<div class="note">No change in meaning: only descriptions, tags, order or whitespace differ.</div>';
  const val = v => (v == null ? '<em>none</em>' : esc(v));
  const fields = f => f.map(x => `${esc(x.field)}: ${val(x.from)} → ${val(x.to)}`).join('; ');
  const item = (kind, x) => `<li>${esc(x.change)} ${esc(kind)} <b>${esc(x.label || x.name)}</b>${x.renamedFrom ? ` (was ${esc(x.renamedFrom)})` : ''}${x.fields.length ? ` · ${fields(x.fields)}` : ''}</li>`;
  const head = `${plural(S.added, 'element')} added, ${S.removed} removed, ${S.changed} changed · ${plural(S.relsAdded, 'relationship')} added, ${S.relsRemoved} removed, ${S.relsChanged} changed`;
  const I = Core.changeImpact(b, a, { decisions: A.decisions, requirements: A.requirements, chainHops: A.cfg.chainHops || 4 });
  const imp = [
    ...I.decisions.map(x => `decision ${esc(x.id)}: ${esc(x.reason)}`),
    ...I.requirements.map(x => `requirement ${esc(x)} touched`),
    ...I.introduced.map(f => `new ${esc(f.code)} on ${esc(f.label)}`),
    ...I.resolved.map(f => `resolved ${esc(f.code)} on ${esc(f.label)}`),
  ];
  const impact = imp.length ? `<div class="note">Impact</div><ul class="semdiff">${imp.map(x => `<li>${x}</li>`).join('')}</ul>` : '';
  return `<div class="note">${esc(head)}</div><ul class="semdiff">${d.elements.map(x => item('element', x)).join('')}${d.rels.map(x => item('relationship', x)).join('')}</ul>${impact}`;
}

async function renderCompare() {
  const el = $('#special'), C = G.compare;
  if (G.diff) { G.diff.dispose(); G.diff = null; }
  if (!C) { el.innerHTML = '<div class="hint">Pick a commit in History to compare the open file with it.</div>'; return; }
  el.innerHTML = `<div class="block"><h3>${esc(C.rel)} · ${esc(C.short)} → working copy</h3><div class="note">${esc(C.subject)}</div></div><div id="semHost"></div><div id="cmpHost" style="height:calc(100% - 250px);min-height:240px"></div>`;
  const buf = A.buffers.get(C.rel);
  const right = buf ? buf.model.getValue() : (await host.read(C.rel)) || '';
  if (/\.dsl$/.test(C.rel)) $('#semHost').innerHTML = semanticDiffHtml(C.left, right);
  const lang = langFor(C.rel);
  const left = monacoRef.editor.createModel(C.left, lang), rightModel = monacoRef.editor.createModel(right, lang);
  G.diff = monacoRef.editor.createDiffEditor($('#cmpHost'), { readOnly: true, originalEditable: false, automaticLayout: true, renderSideBySide: true });
  G.diff.setModel({ original: left, modified: rightModel });
  const d = G.diff, dispose = d.dispose.bind(d);
  d.dispose = () => { dispose(); left.dispose(); rightModel.dispose(); };
}

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-git]'); if (!t) return;
  const k = t.dataset.git;
  if (k === 'trust') { if (await host.gitTrust()) await gitRefresh(); return; }
  if (k === 'status') { setActivity('scm'); return gitRefresh(); }
  if (k === 'compare') return gitOpenCompare(t.dataset.rel, t.dataset.hash);
});
document.addEventListener('click', e => { if (e.target.closest('[data-hv="compare"]')) handoverOpenCompare(); });

// ---------------------------------------------------------------- source control (slice 2)
const GIT_LETTER = { M: 'M', A: 'A', D: 'D', T: 'T', U: 'U', '?': 'U' };
const dirtyBuffers = () => [...A.buffers.values()].some(b => b.dirty);

function gitSidebar() {
  const s = G.state;
  if (!s.repo) return '<div class="hint">This folder is not in a git repository. Run <code>git init</code> in a terminal to version it.</div>';
  if (!s.trusted) return '<div class="hint">designc runs git only in folders you trust.</div><button class="btn primary block" data-git="trust">Trust this folder</button>';
  if (s.error) return `<div class="hint">${esc(s.error)}</div>`;
  const files = s.files || [];
  const staged = files.filter(f => f.index !== '.' && f.index !== '?'), changes = files.filter(f => f.worktree !== '.');
  const row = (f, letter, act, label) => `<div class="row" ${letter === 'D' ? '' : `data-file="${esc(f.path)}"`} title="${esc(f.path)}"><span class="lbl">${esc(f.path.split('/').pop())}</span><span class="desc">${esc(f.path.split('/').slice(0, -1).join('/'))}</span><span class="spacer"></span><button class="lnk" data-git="${act}" data-path="${esc(f.path)}" title="${label}">${act === 'stage' ? '+' : '−'}</button><span class="desc">${esc(GIT_LETTER[letter] || letter)}</span></div>`;
  const opts = G.branches.map(b => `<option value="${esc(b.name)}" ${b.current ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
  const branchBar = `<div class="hint" style="display:flex;gap:6px;align-items:center"><select data-git-switch aria-label="Branch" ${s.detached ? '' : ''}>${s.detached ? `<option selected>detached at ${esc(String(s.head || '').slice(0, 7))}</option>` : ''}${opts}</select><button class="btn" data-git="branch">New branch</button></div>
    <div class="hint" style="display:flex;gap:6px"><button class="btn" data-git="fetch" ${G.busy ? 'disabled' : ''}>Fetch</button><button class="btn" data-git="pull" ${G.busy ? 'disabled' : ''}>Pull${s.behind ? ` ↓${s.behind}` : ''}</button><button class="btn" data-git="push" ${G.busy ? 'disabled' : ''}>${s.upstream ? `Push${s.ahead ? ` ↑${s.ahead}` : ''}` : 'Publish'}</button></div>`;
  const commitBox = `<div class="hint"><textarea id="gitMsg" rows="3" style="width:100%;box-sizing:border-box" placeholder="Commit message">${esc(G.msg)}</textarea><button class="btn primary block" data-git="commit" ${staged.length && !G.busy ? '' : 'disabled'}>Commit ${staged.length ? plural(staged.length, 'file') : ''}</button></div>`;
  return section('scmbranch', 'Branch', branchBar) + section('scmmsg', 'Commit', commitBox)
    + section('scmstaged', `Staged · ${staged.length}`, staged.map(f => row(f, f.index, 'unstage', 'Unstage')).join('') || '<div class="hint">Nothing staged.</div>', staged.length ? '' : '')
    + section('scmchanges', `Changes · ${changes.length}`, changes.map(f => row(f, f.worktree, 'stage', 'Stage')).join('') || '<div class="hint">No changes.</div>');
}

async function gitDo(label, fn, { reload = false } = {}) {
  if (G.busy) return;
  G.busy = true; renderSidebar();
  const r = await fn();
  G.busy = false;
  if (r && r.error) toast(`${label}: ${r.error}`, 'warning'); else if (label) toast(`${label}: done`);
  if (reload && !(r && r.error)) { await onFolder(A.root); setActivity('scm'); }
  await gitRefresh();
  return r;
}

async function gitCommitFlow() {
  const staged = (G.state.files || []).filter(f => f.index !== '.' && f.index !== '?');
  if (!staged.length) return toast('Stage at least one file first.', 'warning');
  if (!G.msg.trim()) return toast('Write a commit message first.', 'warning');
  if (!G.askedUnion) {
    G.askedUnion = true;
    const a = await host.gitAttrs();
    if (a && a.union === false && A.ledgerRaw.length && confirm('Add "ledger/*.jsonl merge=union" to .gitattributes?\n\nThe ledger is append-only, so two branches that both appended merge without a conflict. It takes effect once this file is committed on every branch.')) {
      const r = await host.gitAddUnion();
      if (r.error) toast(`.gitattributes: ${r.error}`, 'warning'); else await host.gitStage(['.gitattributes']);
    }
  }
  const r = await gitDo('Commit', () => host.gitCommit(G.msg));
  if (r && r.ok) { G.msg = ''; renderSidebar(); await recordGate('local'); }
}

document.addEventListener('input', e => { if (e.target.id === 'gitMsg') G.msg = e.target.value; });
document.addEventListener('change', async e => {
  if (!e.target.matches('[data-git-switch]')) return;
  const name = e.target.value;
  if (dirtyBuffers()) { toast('Save or close your unsaved edits before switching branch.', 'warning'); return gitRefresh(); }
  await gitDo(`Switch to ${name}`, () => host.gitSwitch(name), { reload: true });
});
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-git]'); if (!t || t.disabled) return;
  const k = t.dataset.git;
  if (k === 'stage') return gitDo('', () => host.gitStage([t.dataset.path]));
  if (k === 'unstage') return gitDo('', () => host.gitUnstage([t.dataset.path]));
  if (k === 'commit') return gitCommitFlow();
  if (k === 'branch') { const n = (prompt('New branch name') || '').trim(); if (n) await gitDo(`Branch ${n}`, () => host.gitBranch(n)); return; }
  if (k === 'fetch') return gitDo('Fetch', () => host.gitFetch());
  if (k === 'pull') {
    if (dirtyBuffers()) return toast('Save or close your unsaved edits before pulling.', 'warning');
    return gitDo('Pull', () => host.gitPull(), { reload: true });
  }
  if (k === 'push') {
    if (G.state.upstream) return gitDo('Push', () => host.gitPush());
    if (!confirm(`Publish branch ${G.state.branch} to its remote? This creates the branch there and sets it as the upstream.`)) return;
    return gitDo('Publish', () => host.gitPublish());
  }
});
