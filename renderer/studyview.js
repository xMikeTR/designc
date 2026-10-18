/* designc desktop: Study (step 0, learn before deciding). Classic script after reviewview.js, shares the renderer's
   global scope with app.js. A study registry (designc.json "kind": "study") holds topics in study/<id>.yaml: a
   question, the sources and findings the Researcher appended (approved one by one in the agent panel), the person's
   own questions, PoCs and opinion. Status, opinion, question text and PoC results are the person's; no agent tool
   reaches them. The exit is in a project registry: New decision from a study drafts a minted decision from a
   settled topic. Every HTML string passes file content through esc(). */
const STV = { sel: null, opinion: {} };
const STUDY_TAG = { open: 'open', settled: 'bound', abandoned: 'superseded' };
const GOB_TAG = { good: 'pass', bad: 'fail', tradeoff: 'warning' };

const studyTopic = id => (A.studies || []).find(t => t.id === id);

function studySidebar() {
  const ts = A.studies || [];
  const row = t => `<div class="item ${t.id === STV.sel ? 'active' : ''}" data-st="sel" data-id="${esc(t.id)}"><div class="l1"><span class="id">${esc(t.id)}</span><span class="tag ${STUDY_TAG[t.status] || ''}">${esc(t.status)}</span></div><div class="l2">${esc(trunc(t.question, 90))}</div></div>`;
  const group = s => ts.filter(t => t.status === s).map(row).join('');
  return section('study', `Topics (${ts.length})`, ts.length ? group('open') + group('settled') + group('abandoned') : '<div class="hint">No topics yet. New topic writes study/&lt;id&gt;.yaml with the question you want to learn about.</div>',
    '<button title="New topic" data-st="new">+</button>') +
    '<div class="hint">Learn before you decide: the Researcher finds exemplar code and sources, you read them, try things, and write what you think. Decisions are made in a project registry, from a settled topic.</div>';
}

function renderStudy() {
  const el = $('#special'), ts = A.studies || [];
  if (!STV.sel || !studyTopic(STV.sel)) STV.sel = (ts.find(t => t.status === 'open') || ts[0] || {}).id || null;
  const t = studyTopic(STV.sel);
  if (!t) {
    el.innerHTML = `<div class="st"><h2>Study</h2><div class="note">${A.kind === 'study' ? 'No topics yet. Start with the question you do not know how to approach.' : 'This folder is not a study registry. Set "kind": "study" in designc.json, or use Set up this folder and choose Study notebook.'}</div>${A.kind === 'study' ? '<div class="acts"><button class="btn primary" data-st="new">New topic</button></div>' : ''}</div>`;
    return;
  }
  const open = t.status === 'open';
  const src = t.sources.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.url)}</a>${s.note ? ` <span class="muted">${esc(s.note)}</span>` : ''}</li>`).join('');
  const fnd = t.findings.map(f => `<li><span class="tag ${GOB_TAG[f.good_or_bad] || ''}">${esc(f.good_or_bad)}</span> <b>${esc(f.pattern)}</b>${f.corrects ? ` <span class="stcorr">corrects finding ${esc(String(f.corrects))}</span>` : ''}<div>${esc(f.why)}</div><div class="muted">Sources ${esc((f.sources || []).join(', '))}</div></li>`).join('');
  const qs = t.questions.map(q => `<li>${esc(q.text)} <span class="muted">${q.asked ? `asked ${esc(String(q.asked))}` : ''}${(q.answer_in || []).length ? ` · answered in finding ${esc(q.answer_in.join(', '))}` : ' · not answered yet'}</span></li>`).join('');
  const pocs = t.pocs.map((p, i) => `<li>${esc(p.question)}<div class="muted">${p.where ? `Where: ${esc(p.where)}` : 'Where: not said'} · ${p.result ? `Result: ${esc(p.result)}` : 'No result yet'}</div><button class="lnk" data-st="poc-edit" data-i="${i}">Record where and result</button></li>`).join('');
  const opinion = STV.opinion[t.id] ?? t.opinion;
  el.innerHTML = `<div class="st">
    <h2>${esc(t.question)}</h2>
    <div class="stq"><span class="id">${esc(t.id)}</span> <span class="tag ${STUDY_TAG[t.status] || ''}">${esc(t.status)}</span> ${plural(t.sources.length, 'source')} · ${plural(t.findings.length, 'finding')} · ${plural(t.questions.length, 'question')} · ${plural(t.pocs.length, 'PoC')}</div>
    <div class="acts">${open
      ? `<button class="btn primary" data-st="research">Ask the Researcher</button><button class="btn" data-st="question">Add question</button><button class="btn" data-st="poc">Add PoC</button><button class="btn" data-st="settle">Mark settled</button><button class="btn" data-st="abandon">Abandon</button>`
      : '<button class="btn" data-st="reopen">Reopen</button>'}<button class="btn" data-st="file">Open file</button></div>
    <div class="block"><h3>Sources</h3>${src ? `<ol class="stl">${src}</ol>` : '<div class="note">None yet. The Researcher adds them, each one approved by you.</div>'}<div class="note">Citations are not checked by designc. Open them and judge for yourself.</div></div>
    <div class="block"><h3>Findings</h3>${fnd ? `<ol class="stl">${fnd}</ol>` : '<div class="note">None yet.</div>'}</div>
    <div class="block"><h3>Your questions</h3>${qs ? `<ol class="stl">${qs}</ol>` : '<div class="note">None yet. Add what you still do not understand; the Researcher links the findings that answer it.</div>'}</div>
    <div class="block"><h3>PoCs</h3>${pocs ? `<ol class="stl">${pocs}</ol>` : '<div class="note">None yet. A PoC is something you try yourself to find out.</div>'}</div>
    <div class="block"><h3>Your opinion</h3><div class="note">What you now think, in your own words. Settling the topic needs it, and a decision drafted from the topic carries it as its rationale.</div>
      <textarea class="stopinion" id="stOpinion" aria-label="Your opinion" ${open ? '' : 'disabled'}>${esc(opinion)}</textarea>
      ${open ? '<div class="acts"><button class="btn" data-st="opinion">Save opinion</button></div>' : ''}</div>
  </div>`;
}

// Every write rewrites the whole file through Study.toYaml, after checking the file has no unsaved edits.
async function studyWrite(t, topic, what) {
  const b = A.buffers.get(t._path);
  if (b && b.dirty) { toast(`${t._path} has unsaved edits. Save or close it first, then ${what} again.`, 'warning'); return false; }
  await host.write(t._path, Study.toYaml(topic, jsyaml.dump));
  A.tree = await host.tree(); await loadRegistry(); recompile(); renderAll({ keepEditor: true });
  return true;
}
const studyApply = async (t, r, what) => (r.error ? (toast(r.error, 'warning'), false) : studyWrite(t, r.topic, what));

async function newStudyTopic() {
  const q = await askText('What do you want to learn? Write the question you do not know how to approach.', ''); if (q == null) return;
  const t = Study.newTopic(q, (A.studies || []).map(x => x.id));
  if (t.error) return toast(t.error, 'warning');
  const path = `study/${t.id}.yaml`;
  await host.write(path, Study.toYaml(t, jsyaml.dump));
  STV.sel = t.id; A.tree = await host.tree(); await loadRegistry(); recompile();
  openSpecial('special:study'); renderAll({ keepEditor: true });
}

async function studyAction(a, t, el) {
  if (a === 'question') { const q = await askText('Your question about this topic', ''); if (q == null) return; return studyApply(t, Study.addQuestion(t, q, new Date().toISOString().slice(0, 10)), 'add the question'); }
  if (a === 'poc') { const q = await askText('What is the PoC to find out?', ''); if (q == null) return; return studyApply(t, Study.addPoc(t, { question: q }), 'add the PoC'); }
  if (a === 'poc-edit') {
    const i = +el.dataset.i, p = t.pocs[i]; if (!p) return;
    const where = await askText('Where is it? A folder, repository or commit', p.where || ''); if (where == null) return;
    const result = await askText('What did you find out?', p.result || ''); if (result == null) return;
    const topic = JSON.parse(JSON.stringify(t)); topic.pocs[i] = { ...p, where: where.trim(), result: result.trim() };
    return studyWrite(t, topic, 'record the PoC');
  }
  if (a === 'opinion') { const text = $('#stOpinion').value; if (await studyApply(t, Study.setOpinion(t, text), 'save the opinion')) delete STV.opinion[t.id]; return; }
  if (a === 'settle') {
    const typed = STV.opinion[t.id];
    const base = typed != null ? Study.setOpinion(t, typed).topic : t;
    const r = Study.setStatus(base, 'settled'); if (r.error) return toast(r.error, 'warning');
    if (!confirm(`Mark ${t.id} settled? It records that you, ${A.user}, have formed your opinion. A project registry can then draft a decision from it.`)) return;
    if (await studyWrite(t, r.topic, 'settle it')) delete STV.opinion[t.id];
    return;
  }
  if (a === 'abandon') { if (!confirm(`Abandon ${t.id}? It stays in the folder, and you can reopen it.`)) return; return studyApply(t, Study.setStatus(t, 'abandoned'), 'abandon it'); }
  if (a === 'reopen') return studyApply(t, Study.setStatus(t, 'open'), 'reopen it');
  if (a === 'file') return openFile(t._path);
  if (a === 'research') return typeof askResearcher === 'function' ? askResearcher(t) : toast('The Researcher is not available.', 'warning');
}

// The exit, in a project registry: settled topics of the study registries in designc.json registries, read-only.
async function settledStudies() {
  const out = [], problems = [];
  let keys = []; try { keys = await host.registries(); } catch (e) { problems.push(e.message); }
  for (const r of keys) {
    if (!r.exists) continue;
    let files = []; try { files = await host.registryList(r.key, 'study', ['.yaml', '.yml']); } catch { files = []; }
    for (const f of files) {
      const p = Study.parse(f.text, jsyaml.load);
      if (p.error) { problems.push(`${r.key}: ${f.path} does not parse: ${p.error}`); continue; }
      const t = { ...p.topic, id: p.topic.id || f.path.split('/').pop().replace(/\.ya?ml$/, '') };
      if (t.status === 'settled') out.push({ registry: r.key, topic: t });
    }
  }
  return { topics: out, problems };
}
async function newDecisionFromStudy() {
  const { topics, problems } = await settledStudies();
  for (const p of problems) toast(p, 'warning');
  if (!topics.length) return toast('No settled topic in the registries listed in designc.json registries. Settle a topic in your study registry first.', 'warning');
  const pick = await askChoice('Which settled topic informs this decision?', topics.map(x => ({ label: `${x.registry}: ${trunc(x.topic.question, 70)}`, value: x })));
  if (!pick) return;
  const d = Study.decisionDraft(pick.topic, pick.registry);
  if (d.error) return toast(d.error, 'warning');
  const statement = await askText(`What did you decide? Your opinion on "${trunc(pick.topic.question, 60)}" becomes the rationale. Leave blank to fill in later.`, ''); if (statement == null) return;
  return recordDecision({ statement: statement.trim(), rationale: d.rationale, informed_by: d.informed_by, idFrom: statement.trim() || pick.topic.id });
}

document.addEventListener('input', e => { if (e.target.id === 'stOpinion' && STV.sel) STV.opinion[STV.sel] = e.target.value; });
document.addEventListener('click', e => {
  const el = e.target.closest('[data-st]'); if (!el) return;
  const a = el.dataset.st;
  if (a === 'new') return newStudyTopic();
  if (a === 'sel') { STV.sel = el.dataset.id; openSpecial('special:study'); return renderAll({ keepEditor: true }); }
  const t = studyTopic(STV.sel); if (t) studyAction(a, t, el);
});
