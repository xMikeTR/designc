/* designc desktop: Review (error analysis). Classic script after workview.js, shares the renderer's global scope with
   app.js. A person reads one task attempt of a pipeline run at a time, from telemetry, and records a verdict and a
   note (`trace_review`, human only: no agent tool reaches it). Failed attempts come first. Every HTML string passes
   telemetry content through esc(). */
const RV = { sel: null, steps: {}, loading: null, drafts: {}, open: {} };

const FOLD = 600;
const reviewQueueNow = () => Ledger.reviewQueue((A.tel.tasks && A.tel.tasks.spans) || [], A.ledger);
const OUTCOME_TAG = { passed: 'pass', failed: 'fail' };

function reviewBlock(id, label, body, cls = '') {
  if (body == null || body === '') return '';
  const long = body.length > FOLD, key = `${RV.sel}:${id}`, open = RV.open[key];
  return `<div class="rvblock ${cls}"><div class="rvlabel">${esc(label)}${long ? ` <button class="lnk" data-act="rvfold" data-key="${esc(key)}">${open ? 'Fold' : `Show all ${fmtN(body.length)} characters`}</button>` : ''}</div><pre class="rvpre">${esc(long && !open ? body.slice(0, FOLD) + ' …' : body)}</pre></div>`;
}
const partText = p => (p.type === 'tool_call' ? `→ ${p.name}(${p.arguments || ''})` : p.type === 'tool_call_response' ? `← ${p.response || ''}` : p.text || '');
const msgsText = ms => (ms || []).map(m => `[${m.role}]\n${m.parts.map(partText).join('\n')}`).join('\n\n');

function stepHtml(s, i) {
  const head = `<span class="rvn">${i + 1}</span>`;
  if (s.kind === 'model') {
    return `<div class="rvstep model ${s.error ? 'err' : ''}"><div class="rvhead">${head}<b>Model</b> ${esc(s.model || s.name)} <span class="rvmeta">${fmtN(s.tokensIn)} in · ${fmtN(s.tokensOut)} out · ${fmtN(s.ms)} ms</span></div>
      ${reviewBlock(`${s.id}:in`, i === 0 ? 'Brief' : 'Said to the model since its last turn', s.fresh && s.fresh.length ? msgsText(s.fresh) : '')}
      ${reviewBlock(`${s.id}:out`, 'Answer', msgsText(s.output))}
      ${s.error ? `<div class="rverr">${esc(s.error)}</div>` : ''}</div>`;
  }
  if (s.kind === 'tool') {
    return `<div class="rvstep tool ${s.error ? 'err' : ''}"><div class="rvhead">${head}<b>Tool</b> <span class="code">${esc(s.name)}</span> <span class="rvmeta">${fmtN(s.ms)} ms</span></div>
      ${reviewBlock(`${s.id}:args`, 'Arguments', s.arguments || '')}
      ${reviewBlock(`${s.id}:res`, 'Result', s.result || '')}
      ${s.error ? `<div class="rverr">${esc(s.error)}</div>` : ''}</div>`;
  }
  return '';
}

async function loadSteps(row) {
  if (!row || RV.steps[row.id] || RV.loading === row.id) return;
  RV.loading = row.id;
  const r = await host.telemetryTrace(row.traceId, row.id);
  RV.loading = null;
  RV.steps[row.id] = r;
  if (A.active === 'special:review' && RV.sel === row.id) renderReview();
}

function reviewViewer(row) {
  const r = RV.steps[row.id], rv = row.review;
  const draft = RV.drafts[row.id] ?? (rv ? rv.note : '');
  let h = `<div class="rvtop"><div class="rvtitle"><span class="tag ${OUTCOME_TAG[row.outcome] || 'open'}">${esc(row.outcome)}</span> <b>${esc(row.task)}</b>${row.attempt != null ? ` · attempt ${esc(String(row.attempt))}` : ''}${row.run ? ` · run <span class="code">${esc(row.run)}</span>` : ''}${row.element ? ` · ${esc(elementLabel(row.element))}` : ''}</div>
    <div class="rvmeta">${esc(when(row.start))} · ${fmtN(Math.round(row.durationMs / 1000))} s · ${plural(row.steps, 'step')}${row.errors ? ` · ${plural(row.errors, 'error')}` : ''}${row.tokens ? ` · ${fmtN(row.tokens)} tokens` : ''}${row.url ? ` · <a href="${esc(row.url)}">Open in Langfuse</a>` : ''}</div>
    <div class="rvverdict"><textarea id="rvnote" rows="2" aria-label="Note" placeholder="What went wrong, in your own words (the first thing you see; one failure per note)">${esc(draft)}</textarea>
      <div class="rvbtns"><button class="btn ${rv && rv.verdict === 'pass' ? 'primary' : ''}" data-act="rvverdict" data-v="pass" title="p">Pass</button><button class="btn ${rv && rv.verdict === 'fail' ? 'primary' : ''}" data-act="rvverdict" data-v="fail" title="f">Fail</button>${rv ? `<span class="rvmeta">${esc(rv.verdict)} by ${esc(rv.by)}, ${esc(when(rv._ts))}</span>` : ''}</div></div></div>`;
  if (!r) return h + '<div class="note">Loading the steps…</div>';
  if (r.error) return h + `<div class="note">${esc(r.error === 'auth' || r.error === 'http' ? r.message : r.error === 'no_keys' ? `Set ${r.env.join(' and ')} to read Langfuse.` : r.error === 'not_configured' ? 'Langfuse is not set up for this folder.' : r.error)}</div>`;
  if (!r.captured) h += '<div class="note rvwarn">This run did not capture content: you can see which steps ran and their errors, but not what was said. Run the pipeline with content capture on to review it properly.</div>';
  if (r.system) h += reviewBlock('system', 'Instructions', r.system, 'sys');
  h += r.steps.map(stepHtml).join('');
  return h;
}

function renderReview() {
  const el = $('#special'), q = reviewQueueNow(), c = q.counts;
  if (!RV.sel || !q.rows.some(r => r.id === RV.sel)) RV.sel = q.rows.length ? q.rows[0].id : null;
  const row = q.rows.find(r => r.id === RV.sel);
  const T = A.tel, empty = (T.tasks && T.tasks.empty) || 0;
  const head = `<div class="rvbar"><b>Review</b> <span class="rvmeta">${c.toReview} to review · ${c.reviewed} reviewed (${c.fail} fail, ${c.pass} pass) · ${plural(c.total, 'attempt')}${empty ? `, ${empty} with no steps not listed` : ''}</span><span class="rvkeys">j/k move · p pass · f fail</span><button class="btn" data-act="rvrefresh">Refresh</button></div>`;
  if (!q.rows.length) {
    const why = T.loading ? 'Loading telemetry…' : T.error ? 'Telemetry is not available. Set up Langfuse for this folder (Help → Open settings), then refresh.' : 'No task attempts in telemetry yet. Spans that carry the task field (designc.json langfuse.fields.task) are listed here.';
    el.innerHTML = `<div class="rv">${head}<div class="dash"><div class="note">${esc(why)}</div></div></div>`;
    return;
  }
  const list = q.rows.map(r => `<div class="rvrow ${r.id === RV.sel ? 'sel' : ''}" data-act="rvsel" data-id="${esc(r.id)}"><span class="tag ${r.review ? (r.review.verdict === 'pass' ? 'pass' : 'fail') : OUTCOME_TAG[r.outcome] || 'open'}">${r.review ? esc(r.review.verdict) : esc(r.outcome)}</span> <b>${esc(r.task)}</b>${r.attempt != null ? ` <span class="rvmeta">a${esc(String(r.attempt))}</span>` : ''}<div class="rvmeta">${esc(when(r.start))} · ${plural(r.steps, 'step')}${r.errors ? ` · ${plural(r.errors, 'error')}` : ''}${r.review ? ' · reviewed' : ''}</div>${r.review && r.review.note ? `<div class="rvnote">${esc(trunc(r.review.note, 80))}</div>` : ''}</div>`).join('');
  const scroll = $('#rvview') ? $('#rvview').scrollTop : 0;
  el.innerHTML = `<div class="rv">${head}<div class="rvmain"><div class="rvlist" role="list">${list}</div><div class="rvview" id="rvview">${reviewViewer(row)}</div></div></div>`;
  if (RV.keepScroll) $('#rvview').scrollTop = scroll;
  RV.keepScroll = false;
  loadSteps(row);
}

// The Improve view's entry: what is left to review, and the way in.
function reviewSummaryHtml() {
  const c = reviewQueueNow().counts;
  if (!c.total && !A.tel.error) return '';
  const body = c.total
    ? `<div class="stats"><div class="stat"><div class="v">${c.toReview}</div><div class="l">To review</div></div><div class="stat"><div class="v">${c.failed}</div><div class="l">Failed attempts</div></div><div class="stat"><div class="v">${c.fail}</div><div class="l">Marked failed</div></div><div class="stat"><div class="v">${c.pass}</div><div class="l">Marked passed</div></div></div>`
    : '<div class="note">Telemetry is not available, so there is nothing to review yet.</div>';
  return `<div class="block"><h3>Error analysis</h3><div class="note">Read pipeline task attempts one at a time, failed first, and say in a note what went wrong. The notes become the failure modes and the judges' examples.</div>${body}<div class="acts"><button class="btn primary" data-act="rvopen">Review attempts</button></div></div>`;
}

function reviewMove(d) {
  const rows = reviewQueueNow().rows, i = rows.findIndex(r => r.id === RV.sel);
  const n = rows[Math.max(0, Math.min(rows.length - 1, i + d))];
  if (n) { RV.sel = n.id; renderReview(); }
}

async function reviewVerdict(verdict) {
  const row = reviewQueueNow().rows.find(r => r.id === RV.sel);
  if (!row) return;
  const note = ($('#rvnote') ? $('#rvnote').value : RV.drafts[row.id] || '').trim();
  if (verdict === 'fail' && !note) { toast('Say what went wrong in the note, then mark it failed.', 'error'); if ($('#rvnote')) $('#rvnote').focus(); return; }
  const prev = row.review;
  const fields = { trace_id: row.traceId, observation: row.id, verdict, note, task: row.task };
  if (row.run) fields.run_id = row.run;
  if (row.attempt != null) fields.attempt = row.attempt;
  if (prev && prev.failure_mode !== undefined && verdict === 'fail') fields.failure_mode = prev.failure_mode;
  const r = await recordEvent('trace_review', fields);
  if (!r.ok) return;
  delete RV.drafts[row.id];
  await loadLedger();
  // Move to the next attempt still to review, if any.
  const next = reviewQueueNow().rows.find(x => !x.review);
  if (next) RV.sel = next.id;
  renderReview();
}

document.addEventListener('input', e => { if (e.target.id === 'rvnote' && RV.sel) RV.drafts[RV.sel] = e.target.value; });
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (t && t.dataset.act === 'rvopen') return openSpecial('special:review');
  if (!t || A.active !== 'special:review') return;
  const a = t.dataset.act;
  if (a === 'rvsel') { RV.sel = t.dataset.id; renderReview(); }
  if (a === 'rvverdict') reviewVerdict(t.dataset.v);
  if (a === 'rvfold') { RV.open[t.dataset.key] = !RV.open[t.dataset.key]; RV.keepScroll = true; renderReview(); }
  if (a === 'rvrefresh') { RV.steps = {}; loadTelemetry(); }
});
document.addEventListener('keydown', e => {
  if (A.active !== 'special:review' || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && t.closest && t.closest('input, textarea, select, [contenteditable], .monaco-editor, .xterm')) {
    if (e.key === 'Escape' && t.id === 'rvnote') t.blur();
    return;
  }
  const k = { j: () => reviewMove(1), k: () => reviewMove(-1), p: () => reviewVerdict('pass'), f: () => reviewVerdict('fail'), n: () => $('#rvnote') && $('#rvnote').focus() }[e.key];
  if (k) { e.preventDefault(); k(); }
});
