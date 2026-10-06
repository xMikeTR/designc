/* designc desktop: "Set up this folder" (special:setup). Classic script after app.js, sharing its global scope.
   app.js calls openSetup() and renderSetup(); the rules live in setup.js. designc.json gets env var names only:
   this page asks main whether each name is set (true or false) and never sees a value. */
const SU = { current: {}, invalid: null, exists: false, modelExists: true, starter: true, draft: null, skip: { llm: false, langfuse: false }, env: {}, results: {}, errors: [], busy: '' };

const SU_PROVIDERS = [['openai', 'OpenAI-compatible gateway (LiteLLM and similar)'], ['anthropic', 'Anthropic API (a key on this machine)'], ['vertex', 'Claude on Vertex AI (Google ADC, for work)']];
// The llm fields depend on the provider; langfuse has one set.
const SU_LLM_FIELDS = {
  openai: [['baseUrl', 'Base URL', 'https://your-gateway/v1', 'An OpenAI-compatible endpoint, such as a LiteLLM gateway.'],
    ['model', 'Model', 'claude-sonnet', 'The model name your gateway expects.'],
    ['apiKeyEnv', 'API key variable', Setup.DEFAULTS.apiKeyEnv, 'The name of the environment variable that holds the key.']],
  anthropic: [['model', 'Model', 'claude-sonnet-5-5', 'An Anthropic model name.'],
    ['apiKeyEnv', 'API key variable', 'ANTHROPIC_API_KEY', 'The name of the environment variable that holds your Anthropic key.'],
    ['baseUrl', 'Base URL (optional)', 'https://api.anthropic.com', 'Leave blank for api.anthropic.com. Set it only for a proxy.']],
  vertex: [['project', 'Google Cloud project', 'my-project-123', 'The project id that has Claude enabled in Vertex AI. Falls back to GOOGLE_CLOUD_PROJECT.'],
    ['region', 'Region', 'global', 'Leave blank for global, or enter a region like europe-west1 (some Claude models are regional).'],
    ['model', 'Model', 'claude-sonnet-4-5@20250929', 'The Vertex AI model id.']],
};
const SU_FIELDS = {
  get llm() { return SU_LLM_FIELDS[Llm.provider(SU.draft && SU.draft.llm) || 'openai']; },
  langfuse: [['baseUrl', 'Base URL', 'https://cloud.langfuse.com', 'The Langfuse host, without /api.'],
    ['publicKeyEnv', 'Public key variable', Setup.DEFAULTS.publicKeyEnv, 'The name of the variable that holds the public key.'],
    ['secretKeyEnv', 'Secret key variable', Setup.DEFAULTS.secretKeyEnv, 'The name of the variable that holds the secret key.']],
};

async function openSetup() {
  if (!A.root) return;
  const t = await readText('designc.json');
  SU.exists = t != null; SU.invalid = null; SU.current = {};
  if (t != null) { try { SU.current = JSON.parse(t) || {}; } catch (e) { SU.invalid = e.message; } }
  const c = SU.current, pick = (o, ks) => Object.fromEntries(ks.map(k => [k, (o && o[k]) || '']));
  SU.draft = { model: c.model || 'model/workspace.dsl', llm: pick(c.llm, ['provider', 'baseUrl', 'model', 'apiKeyEnv', 'project', 'region']), langfuse: pick(c.langfuse, ['baseUrl', 'publicKeyEnv', 'secretKeyEnv']) };
  SU.skip = { llm: false, langfuse: false }; SU.results = {}; SU.errors = []; SU.busy = '';
  await setupCheckModel();
  await setupRefreshEnv();
  openSpecial('special:setup');
}

async function setupCheckModel() { SU.modelExists = !!SU.draft.model && Setup.validate({ model: SU.draft.model }).length === 0 && await host.exists(SU.draft.model.trim()); }
async function setupRefreshEnv() {
  try { SU.env = await host.setupEnv(Setup.envNames(SU.draft)); } catch { SU.env = {}; }
  SU.adc = !SU.skip.llm && Llm.provider(SU.draft.llm) === 'vertex' ? await host.setupAdc().catch(e => ({ error: 'no_adc', hint: e.message })) : null;
}
const setupDraft = () => ({ model: SU.draft.model, llm: SU.skip.llm ? null : SU.draft.llm, langfuse: SU.skip.langfuse ? null : SU.draft.langfuse });

function setupAdcHtml() {
  const a = SU.adc; if (!a) return '';
  if (a.ok) return '<div class="su-env ok"><span class="dot pass"></span>Google credentials are available through <code>gcloud</code>.</div>';
  const cmd = a.error === 'no_gcloud' ? '' : '<pre>gcloud auth application-default login</pre>';
  return `<div class="su-env"><span class="dot fail"></span>${a.error === 'no_gcloud' ? '<code>gcloud</code> is not installed. Install the Google Cloud CLI, then run:<pre>gcloud auth application-default login</pre>' : `Google credentials are not set up. Run this in a terminal, then choose Check again:${cmd}`}<button class="l" data-su-adc>Check again</button></div>`;
}
function setupEnvHtml(kind) {
  if (SU.skip[kind]) return '';
  if (kind === 'llm' && Llm.provider(SU.draft.llm) === 'vertex') return setupAdcHtml();
  return Setup.envNames({ [kind]: SU.draft[kind] }).map(n => SU.env[n]
    ? `<div class="su-env ok"><span class="dot pass"></span><code>${esc(n)}</code> is set</div>`
    : `<div class="su-env"><span class="dot fail"></span><code>${esc(n)}</code> is not set. Add this line to <code>~/.profile</code>, then log out and in (or restart designc from a shell that has it):<pre>${esc(Setup.exportLine(n) || '')}</pre></div>`).join('');
}
function setupResultHtml(kind) {
  const r = SU.results[kind];
  if (SU.busy === kind) return '<div class="su-res">Testing…</div>';
  if (!r) return '';
  if (r.ok) return `<div class="su-res ok">${esc(r.detail)}</div>`;
  const head = { missing: 'A key is not set.', incomplete: 'Not ready to test.', invalid: 'Check the fields above.' }[r.error] || r.error;
  return `<div class="su-res err">${esc(head)}${r.hint ? ` ${esc(r.hint)}` : ''}</div>`;
}
function setupProviderRow() {
  const cur = Llm.provider(SU.draft.llm) || 'openai';
  const err = SU.errors.find(e => e.field === 'llm.provider');
  return `<label class="su-row"><span>Provider</span><select data-su="llm.provider" ${SU.skip.llm ? 'disabled' : ''}>${SU_PROVIDERS.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
    <small>${esc(err ? err.msg : 'Where the model runs. The key never goes in designc.json.')}</small></label>`;
}
function setupSection(kind, title, about) {
  const errs = new Map(SU.errors.map(e => [e.field, e.msg]));
  const rows = (kind === 'llm' ? setupProviderRow() : '') + SU_FIELDS[kind].map(([f, label, ph, help]) => `<label class="su-row"><span>${esc(label)}</span>
    <input data-su="${kind}.${f}" value="${esc(SU.draft[kind][f])}" placeholder="${esc(ph)}" spellcheck="false" ${SU.skip[kind] ? 'disabled' : ''}>
    <small>${esc(errs.get(`${kind}.${f}`) || help)}</small></label>`).join('');
  return `<div class="block su-sec${SU.skip[kind] ? ' skipped' : ''}"><h3>${esc(title)}<span class="spacer"></span><label class="su-skip"><input type="checkbox" data-su-skip="${kind}" ${SU.skip[kind] ? 'checked' : ''}> Skip</label></h3>
    <div class="note">${about}</div><div class="su-body">${rows}<div id="suEnv-${kind}">${setupEnvHtml(kind)}</div>
    <div class="su-act"><button class="btn" data-su-test="${kind}" ${SU.skip[kind] || SU.busy ? 'disabled' : ''}>Test connection</button><div id="suRes-${kind}">${setupResultHtml(kind)}</div></div></div></div>`;
}

function renderSetup() {
  const el = $('#special');
  if (!SU.draft) { el.innerHTML = '<div class="dash"><h1>Set up this folder</h1></div>'; openSetup(); return; }
  const modelErr = SU.errors.find(e => e.field === 'model');
  el.innerHTML = `<div class="dash su"><h1>Set up this folder</h1>
    <p class="lede">These settings go in <code>designc.json</code> in ${esc(A.root ? A.root.name : 'this folder')}. Keys stay in your environment: the file holds only the names of the variables, so it is safe to commit. Skip anything you don't need yet; you can come back from Help, Open settings.</p>
    ${SU.invalid ? `<div class="su-res err">designc.json is not valid JSON (${esc(SU.invalid)}). Fix it in the editor before saving here, so nothing in it is lost. <button class="l" data-su-open>Open designc.json</button></div>` : ''}
    <div class="block su-sec"><h3>Model</h3><div class="note">The Structurizr DSL file that holds the design.</div><div class="su-body">
      <label class="su-row"><span>Model file</span><input data-su="model" value="${esc(SU.draft.model)}" placeholder="model/workspace.dsl" spellcheck="false"><small>${esc(modelErr ? modelErr.msg : SU.modelExists ? 'This file exists.' : 'This file does not exist yet.')}</small></label>
      ${SU.modelExists ? '' : `<label class="su-check"><input type="checkbox" data-su-starter ${SU.starter ? 'checked' : ''}> Create it with a small starter model</label>`}
    </div></div>
    ${setupSection('llm', 'Model provider (LLM)', 'Used by grill-me, drafting and the built-in agent. The model must support tool calling.')}
    ${setupSection('langfuse', 'Langfuse', 'Where Build reads agent runs from. designc only reads; it needs a project\'s public and secret key.')}
    <div class="su-save"><button class="btn primary" data-su-save ${SU.invalid || SU.busy ? 'disabled' : ''}>${SU.exists ? 'Save designc.json' : 'Create designc.json'}</button>
    ${SU.errors.length ? `<span class="su-res err">Fix ${plural(SU.errors.length, 'field')} first.</span>` : ''}${SU.exists ? '<button class="l" data-su-open>Open designc.json in the editor</button>' : ''}</div></div>`;
}

async function setupSave() {
  const d = setupDraft();
  SU.errors = Setup.validate(d);
  if (SU.errors.length || SU.invalid) return renderSetup();
  SU.busy = 'save'; renderSetup();
  try {
    const merged = Setup.merge(SU.current, d);
    const createModel = !SU.modelExists && SU.starter;
    if (createModel) await host.write(merged.model, Setup.STARTER_MODEL);
    await host.write('designc.json', JSON.stringify(merged, null, 2) + '\n');
    SU.current = merged; SU.exists = true; SU.busy = '';
    A.tree = await host.tree();
    await reloadAll();
    await setupCheckModel();
    toast(createModel ? `Saved designc.json and created ${merged.model}` : 'Saved designc.json', 'info');
    renderAll();
  } catch (e) { SU.busy = ''; toast(`Couldn't save designc.json: ${e.message}. Check the folder is writable and try again.`, 'error'); renderSetup(); }
}

async function setupTest(kind) {
  SU.busy = kind; SU.results[kind] = null; renderSetup();
  try { SU.results[kind] = await host.setupTest(kind, setupDraft()); } catch (e) { SU.results[kind] = { error: e.message }; }
  SU.busy = ''; await setupRefreshEnv(); renderSetup();
}

document.addEventListener('input', e => {
  const t = e.target.closest('[data-su]'); if (!t || !SU.draft) return;
  const [kind, f] = t.dataset.su.split('.');
  if (f) SU.draft[kind][f] = t.value; else SU.draft.model = t.value;
});
// Re-check variables and the model file when a field is left, updating only the status lines so focus stays put.
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.matches('[data-su-starter]')) { SU.starter = t.checked; return; }
  if (t.matches('[data-su-skip]')) { SU.skip[t.dataset.suSkip] = t.checked; return renderSetup(); }
  if (!t.matches('[data-su]') || !SU.draft) return;
  const kind = t.dataset.su.split('.')[0];
  if (kind === 'model') { await setupCheckModel(); return renderSetup(); }
  if (t.dataset.su === 'llm.provider') { SU.results.llm = null; await setupRefreshEnv(); return renderSetup(); }
  await setupRefreshEnv();
  const box = $(`#suEnv-${kind}`); if (box) box.innerHTML = setupEnvHtml(kind);
});
document.addEventListener('click', e => {
  if (A.active !== 'special:setup') return;
  const t = e.target.closest('[data-su-test], [data-su-save], [data-su-open], [data-su-adc]'); if (!t) return;
  if (t.matches('[data-su-adc]')) return setupRefreshEnv().then(renderSetup);
  if (t.dataset.suTest) return setupTest(t.dataset.suTest);
  if (t.matches('[data-su-save]')) return setupSave();
  if (t.matches('[data-su-open]')) return openFile('designc.json');
});
