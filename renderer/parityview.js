/* designc desktop: Parity (legacy UI parity). Classic script after workview.js, shares the renderer's global scope with
   app.js. Baselines and reports are written by scripts/parity-record.js outside the app, results reach the ledger as
   parity_result, and the screenshots (parity/shots/<sha>.png, not in git) are shown only, never compared. The buttons
   type the recorder's line into the Terminal without Enter, like Dispatch; the app writes only a new scenario file and
   the two URLs in designc.json. Every HTML string passes file and ledger content through esc(). */
const PV = { sel: null, reports: {}, baselines: {}, shots: {}, tools: null };
const PARITY_DIR = 'parity/scenarios';

// The scenarios in parity/scenarios/. A file with no id is a problem, never named after its file (python/designc
// cli.py parity_scenarios says the same): a scenario is recorded and judged by its id. Problems go to Problems
// through A.workErrors; parity is a done_when entry of a work item, never a gate input.
async function loadParityScenarios() {
  A.parity = []; A.parityIds = [];
  let files = [];
  try { files = await host.list(PARITY_DIR, ['.yaml', '.yml']); } catch { files = []; }
  for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
    let o;
    try { o = jsyaml.load(textOf(f.path) ?? f.text); } catch (e) { A.workErrors.push({ path: f.path, line: (e.mark && e.mark.line + 1) || 1, msg: `${f.path} does not parse: ${e.reason || e.message}` }); continue; }
    if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !o.id.trim()) { A.workErrors.push({ path: f.path, line: 1, msg: `${f.path} has no id; a parity scenario is recorded and judged by its id.` }); continue; }
    const problems = Parity.scenarioProblems(o);
    for (const p of problems) A.workErrors.push({ path: f.path, line: 1, msg: `${o.id}: ${p}` });
    A.parity.push({ ...o, id: o.id.trim(), _path: f.path, problems });
    A.parityIds.push(o.id.trim());
  }
  PV.reports = {}; PV.baselines = {};
  for (const s of A.parity) {
    try { PV.baselines[s.id] = await host.exists(`parity/baselines/${s.id}/legacy.json`); } catch { PV.baselines[s.id] = false; }
    try { PV.reports[s.id] = JSON.parse(await host.read(`parity/reports/${s.id}.json`)); } catch { PV.reports[s.id] = null; }
  }
}

const parityResults = id => (A.ledger || []).filter(e => e.kind === 'parity_result' && e.scenario === id);
const parityLast = id => parityResults(id).pop() || null;
const c7 = c => (c ? String(c).slice(0, 7) : 'no commit');
const outcomeTag = o => `<span class="tag ${o === 'pass' ? 'pass' : o === 'fail' ? 'fail' : 'open'}">${esc(String(o || 'no result').replace(/_/g, ' '))}</span>`;

// A work card's note for one parity entry: the latest result of each scenario it names.
function parityNote(e) {
  const ids = Work.parityIds(e, A.parityIds || []);
  if (!ids.length) return ' <span class="desc">no scenarios in parity/scenarios/, so this cannot pass</span>';
  return ` <span class="desc">${ids.map(id => { const r = parityLast(id); return `${esc(id)} ${r ? `${esc(r.outcome.replace(/_/g, ' '))} at ${esc(c7(r.commit))}` : 'no result'}`; }).join(' · ')}</span> <button class="lnk" data-pv="open" data-id="${esc(ids[0])}">Show parity</button>`;
}

function stepText(st) {
  const k = Parity.ACTIONS.find(x => st && st[x] !== undefined);
  if (!k) return '(no action)';
  const a = st[k] || {};
  if (k === 'goto') return `go to ${a.path || ''}`;
  const v = a.value === undefined ? '' : ` with ${typeof a.value === 'object' && a.value && a.value.param ? `param ${a.value.param}` : JSON.stringify(a.value)}`;
  return `${k} ${a.role || ''} "${a.name || ''}"${a.index ? ` #${a.index}` : ''}${v}`;
}

function paritySidebar() {
  if (!A.parity || (!A.parity.length && !A.workErrors.some(e => e.path.startsWith(PARITY_DIR)))) {
    return section('parity', 'Scenarios', `<div class="hint">No scenarios yet. A scenario is a YAML file in ${PARITY_DIR}/ listing role and name steps, replayed on the legacy app and the new one. See docs/parity-contract.md.</div>`);
  }
  const rows = A.parity.map(s => {
    const r = parityLast(s.id);
    return `<div class="row ${PV.sel === s.id ? 'active' : ''}" data-pv="sel" data-id="${esc(s.id)}"><span class="lbl">${esc(s.id)}</span><span class="desc">${PV.baselines[s.id] ? '' : 'no baseline · '}${r ? esc(r.outcome.replace(/_/g, ' ')) : 'no result'}</span></div>`;
  }).join('');
  const bad = A.workErrors.filter(e => e.path.startsWith(PARITY_DIR)).map(e => `<div class="row" data-file="${esc(e.path)}"><span class="lbl" style="color:var(--err)">${esc(e.msg)}</span></div>`).join('');
  return section('parity', `Scenarios (${A.parity.length})`, rows + bad);
}

const parityUrl = side => ((A.cfg.parity || {})[side] || {}).baseUrl || '';
const SIDE_NAME = { legacy: 'legacy app', next: 'new app' };

// Whether this machine can record: the scripts, Playwright and Chromium, and the two URLs. Says what to do about each.
function parityToolsHtml() {
  const t = PV.tools;
  if (!t) return '<div class="note">Checking this machine…</div>';
  const url = side => `<div class="note">${esc(SIDE_NAME[side][0].toUpperCase() + SIDE_NAME[side].slice(1))}: ${parityUrl(side) ? esc(parityUrl(side)) : 'no URL yet'} <button class="lnk" data-pr="url" data-side="${side}">${parityUrl(side) ? 'Change' : 'Set URL'}</button></div>`;
  const tool = !t.record ? '<div class="note" style="color:var(--err)">This installed designc does not include the recorder. Run designc from its source folder with npm start to record.</div>'
    : !t.playwright ? '<div class="note" style="color:var(--err)">Playwright is not installed. Run npm install in the designc folder, then Check again. <button class="lnk" data-pr="recheck">Check again</button></div>'
    : !t.chromium ? '<div class="note" style="color:var(--err)">Chromium is not installed. <button class="btn" data-pr="chromium">Install Chromium</button> <button class="lnk" data-pr="recheck">Check again</button></div>'
    : '';
  return tool + url('legacy') + url('next');
}

// The buttons for one scope: this scenario or all of them. Each types its line into the Terminal and stops before Enter.
function parityButtons(scope, suffix) {
  const off = PV.tools && PV.tools.record ? '' : 'disabled';
  const scn = `data-scope="${esc(scope)}"`;
  return `<button class="btn" data-pr="record" data-side="legacy" ${scn} ${off}>Record legacy${suffix}</button> <button class="btn" data-pr="record" data-side="next" ${scn} ${off}>Compare new app${suffix}</button>`;
}

function parityCommands(s) {
  const off = PV.tools && PV.tools.record ? '' : 'disabled';
  return `<div class="note">Each button types the command into the Terminal and stops. Read it, then press Enter. Both are read-only on the apps: committing clicks and requests that change data are blocked. Compare shows you the gaps and records nothing as evidence.</div>
    ${parityToolsHtml()}
    <p>${parityButtons(s.id, '')}</p>
    <p>${parityButtons('all', ', all scenarios')}</p>
    <p><button class="btn" data-pr="result" ${off}>Record result for Done</button> <span class="desc">Run this after the build is merged, on the merged commit.</span></p>
    <p><button class="btn" data-pr="import" ${off}>Draft from legacy tests</button> <button class="btn" data-pr="new">New scenario</button></p>`;
}

// The page before any scenario exists: the whole path, then how to start it.
function parityStartHtml() {
  const off = PV.tools && PV.tools.import ? '' : 'disabled';
  return `<div class="block"><h3>Start here</h3>
      <ol class="pvsteps"><li>Add scenarios: the screens and clicks to replay.</li><li>Record legacy once. That is the baseline.</li><li>Compare the new app to see the gaps.</li><li>Sort the gaps against the requirements: a difference a requirement asks for gets an acceptance criterion or a bound business decision, and the rest gets built.</li><li>After the merge, record the result for Done.</li></ol>
      ${parityToolsHtml()}
      <p><button class="btn primary" data-pr="import" ${off}>Draft from legacy tests</button> <button class="btn" data-pr="new">New scenario</button></p>
      <div class="note">A scenario looks like this:</div>
      <pre class="rvpre">${esc('id: tags-list\ntitle: The tags list\nscreen: tags\nsteps:\n  - goto: { path: /tags }\n  - click: { role: button, name: Bulk apply }')}</pre></div>`;
}

// Saved in designc.json, so the recorder reads it and the person is asked once.
async function setParityUrl(side) {
  const url = await askText(`The ${SIDE_NAME[side]}'s address, for example https://app.example.com`, parityUrl(side));
  if (url == null) return null;
  const clean = url.trim();
  if (!/^https?:\/\/\S+$/.test(clean)) { toast('That is not an address. Start it with https:// or http://.', 'warning'); return null; }
  let cfg = {}; const t = await readText('designc.json');
  if (t) { try { cfg = JSON.parse(t); } catch { toast('designc.json is not valid JSON; fix it first.', 'error'); return null; } }
  const parity = { ...(cfg.parity || {}), [side]: { ...((cfg.parity || {})[side] || {}), baseUrl: clean } };
  await host.write('designc.json', JSON.stringify({ ...cfg, parity }, null, 2) + '\n');
  A.cfg.parity = parity;
  renderSpecial();
  return clean;
}

const typeParity = line => {
  if (line.error) { toast(line.error, 'error'); return; }
  return typeInTerminal(line, 'the button');
};

async function recordParity(side, scope, extra = {}) {
  const baseUrl = parityUrl(side) || await setParityUrl(side);
  if (!baseUrl) return;
  return typeParity(Dispatch.parityRecord({ script: PV.tools.record, registry: A.root.root, scenario: scope, side, ...extra }, A.platform));
}

// Evidence for a work item's parity entry: the comparison at the merged commit, recorded to the ledger.
async function recordParityResult() {
  const items = (A.work || []).filter(i => (i.done_when || []).some(e => e && e.parity !== undefined));
  if (!items.length) { toast('No work item has a parity entry in done_when. Add one on the item first.', 'warning'); return; }
  const item = items.length === 1 ? items[0] : await askChoice('Record the result for which work item?', items.map(i => ({ label: i.id, value: i })));
  if (!item) return;
  let head = {}; try { head = await host.workHead(item.repo || null); } catch { /* the person types the commit */ }
  const commit = await askText(`Which merged commit is this result for? Use the same one you declare ${item.id} done at.`, head.commit || '');
  if (!commit || !commit.trim()) return;
  // Done stores the full hash and a result counts only at that exact commit, so a short hash is resolved here.
  let full = {}; try { full = await host.workOnMain(item.repo || null, commit.trim()); } catch (err) { full = { error: err.message }; }
  if (full.error || !full.commit) { toast(`Nothing was typed. ${full.error || 'That commit could not be checked.'}`, 'error'); return; }
  return recordParity('next', 'all', { item: item.id, commit: full.commit });
}

async function draftParityScenarios() {
  const refs = Dispatch.references(A.cfg.references);
  const lg = refs && !refs.error ? Dispatch.legacy(refs.refs) : null;
  const from = await askText('The folder holding the legacy app\'s Playwright tests', lg && lg.path ? dispatchAbs(lg.path) : '');
  if (!from || !from.trim()) return;
  return typeParity(Dispatch.parityImport({ script: PV.tools.import, registry: A.root.root, from: from.trim() }, A.platform));
}

async function newParityScenario() {
  const id = await askText('A short name for the scenario, for example tags-list');
  if (!id || !id.trim()) return;
  const clean = id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(clean)) { toast('Use letters, digits, dots, dashes and underscores in the name.', 'warning'); return; }
  const rel = `${PARITY_DIR}/${clean}.yaml`;
  if (await host.exists(rel)) { toast(`${rel} already exists.`, 'warning'); return; }
  await host.write(rel, `id: ${clean}\ntitle: ${clean}\nsteps:\n  - goto: { path: / }\n`);
  openFile(rel);
}

function shotImg(sha, label) {
  if (!sha) return `<div class="pvshot none">${esc(label)}: no screenshot</div>`;
  return `<figure class="pvshot"><figcaption>${esc(label)}</figcaption><img alt="${esc(label)} screenshot" data-shot="${esc(sha)}"></figure>`;
}

function parityReportHtml(s) {
  const rep = PV.reports[s.id];
  if (!rep || !rep.result) return '<div class="note">No report yet. Record the new app with --side next to compare it with the baseline.</div>';
  const res = rep.result, c = res.counts || {};
  const steps = (res.steps || []).map(st => {
    const fs = (st.findings || []).map(f => `<li><span class="tag ${f.severity === 'covered' ? 'pass' : 'fail'}">${esc(f.severity)}</span> <span class="code">${esc(f.kind)}</span> ${esc(f.msg)}${f.by ? ` <span class="desc">covered by ${esc(f.by)}</span>` : ''}</li>`).join('');
    return `<div class="runhead"><b>Step ${esc(String(st.n))}</b> ${esc(stepText((s.steps || [])[st.n - 1]))} <span class="desc">${esc(String(st.status || '').replace(/_/g, ' '))}${st.reason ? `: ${esc(st.reason)}` : ''}</span></div>
      ${fs ? `<ul class="pvfind">${fs}</ul>` : '<div class="note">No differences.</div>'}
      <div class="pvshots">${shotImg(st.legacyShot, 'Legacy')}${shotImg(st.nextShot, 'New app')}</div>`;
  }).join('');
  return `<div class="note">${outcomeTag(res.outcome)} at ${esc(c7(rep.commit))}${rep.item ? ` for ${esc(rep.item)}` : ''} · ${c.fail || 0} failing, ${c.covered || 0} covered by a requirement, ${c.could_not_run || 0} could not run. Screenshots are for looking only; the comparison never reads them.</div>${steps}`;
}

function renderParity() {
  const el = $('#special');
  if (!PV.sel || !(A.parity || []).some(s => s.id === PV.sel)) PV.sel = A.parity && A.parity.length ? A.parity[0].id : null;
  const s = (A.parity || []).find(x => x.id === PV.sel);
  const head = `<h1>Legacy parity</h1><p class="lede">The new app should look and behave like the legacy one, unless a requirement says otherwise. Each scenario is replayed on both; structure, interface text and the shape of data are compared, never the data. A pass is a work item's done_when entry (parity: &lt;id&gt; or all).</p>`;
  if (!PV.tools) host.parityTools().then(t => { PV.tools = t; if (A.active === 'special:parity') renderSpecial(); }).catch(() => { PV.tools = {}; });
  if (!s) { el.innerHTML = `<div class="dash">${head}${parityStartHtml()}</div>`; return; }
  const results = parityResults(s.id).slice(-8).reverse().map(r => `<tr><td>${outcomeTag(r.outcome)}</td><td class="code">${esc(c7(r.commit))}</td><td>${esc(r.item || '')}</td><td>${esc(when(r._ts))}</td><td>${(r.failures || []).slice(0, 3).map(f => esc(`step ${f.step}: ${f.msg}`)).join('<br>')}${(r.failures || []).length > 3 ? `<br><span class="desc">and ${(r.failures.length - 3)} more</span>` : ''}</td></tr>`).join('');
  el.innerHTML = `<div class="dash">${head}
    <div class="block"><h3>${esc(s.id)}${s.title ? ` · ${esc(s.title)}` : ''}<span class="spacer"></span><button class="btn" data-file="${esc(s._path)}">Open file</button></h3>
      <div class="note">${s.screen ? `Screen ${esc(s.screen)}. ` : ''}${PV.baselines[s.id] ? 'Baseline recorded.' : 'No baseline yet: record the legacy app first.'}${s.problems.length ? ` <span style="color:var(--err)">${esc(s.problems.join('; '))}</span>` : ''}</div>
      <ol class="pvsteps">${(s.steps || []).map(st => `<li>${esc(stepText(st))}</li>`).join('')}</ol></div>
    <div class="block"><h3>Results in the ledger</h3>${results ? `<div class="tw2"><table class="t"><tr><th>Outcome</th><th>Commit</th><th>Item</th><th>When</th><th>Failures</th></tr>${results}</table></div>` : '<div class="note">No parity_result yet.</div>'}</div>
    <div class="block"><h3>Latest report</h3>${parityReportHtml(s)}</div>
    <div class="block"><h3>Record</h3>${parityCommands(s)}</div></div>`;
  loadShots(el);
}

// Fills each screenshot from the confined parity:shot channel; a shot missing on this machine says so.
async function loadShots(el) {
  for (const img of el.querySelectorAll('img[data-shot]')) {
    const sha = img.dataset.shot;
    if (!(sha in PV.shots)) { try { PV.shots[sha] = await host.parityShot(sha); } catch { PV.shots[sha] = null; } }
    if (PV.shots[sha]) img.src = PV.shots[sha];
    else img.replaceWith(Object.assign(document.createElement('div'), { className: 'desc', textContent: 'Not on this machine (shots are not in git).' }));
  }
}

// The recording buttons. Human only: no agent tool reaches them, and designc runs nothing. They only type a line.
document.addEventListener('click', e => {
  const t = e.target.closest('[data-pr]'); if (!t || t.disabled) return;
  const act = t.dataset.pr;
  if (act === 'record') recordParity(t.dataset.side, t.dataset.scope);
  else if (act === 'result') recordParityResult();
  else if (act === 'import') draftParityScenarios();
  else if (act === 'new') newParityScenario();
  else if (act === 'url') setParityUrl(t.dataset.side);
  else if (act === 'chromium') typeInTerminal(`node ${A.platform === 'win32' ? `'${PV.tools.install.replace(/'/g, "''")}'` : `'${PV.tools.install.replace(/'/g, "'\\''")}'`} install chromium`, 'the button');
  else if (act === 'recheck') { PV.tools = null; renderSpecial(); }
});

document.addEventListener('click', e => {
  const t = e.target.closest('[data-pv]'); if (!t) return;
  PV.sel = t.dataset.id || PV.sel;
  // From a work card, switch the activity too, so the sidebar lists the scenarios beside the view.
  if (A.activity !== 'parity' || !A.sidebarOpen) setActivity('parity');
  if (A.active !== 'special:parity') openSpecial('special:parity'); else renderAll({ keepEditor: true });
});
