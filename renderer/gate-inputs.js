/* designc desktop: the gate's inputs, assembled once. Pure, no I/O.
   Dual-load like renderer/work.js: <script src="gate-inputs.js"> in the renderer, require('./renderer/gate-inputs.js')
   from headless/index.js and tests.
   One place that turns a registry folder's files into what Core.check and Core.gate take, so a host (the headless
   `designc-core check` today, the IDE later) does not re-implement loadRegistry, loadLedger, loadDomains, loadUi and
   contractGaps. The logic is the app's (renderer/app.js, workview.js, contractsview.js), line for line; where the
   old Python front end differed, the app wins (plans/compiler-and-scenarios.md, A1 result).

   assemble({cfg, files, registries, hashes, yamlLoad}) -> {cfg, modelText, model, checkOptions, gateInputs}
     cfg        designc.json parsed ({} when absent); defaults are applied here, as the app's loadSettings does
     files      {path: text} for the registry folder, forward-slash paths relative to it. Only text files are needed: the
                model, decisions/ requirements/ proposals/ handovers/ scenarios/ evals/ acceptance/ (and handovers/<id>/),
                ledger/*.jsonl, work/, domain/, behaviour/*.p, ui/{pack,specs,holdout,legacy}/**.json, parity/scenarios/,
                contracts/openapi/*.yaml (named only), contracts/out/result.json, design-tokens/tokens.json
     registries {registryKey: {path: text}} for the sibling registries designc.json `registries` lists (domain/*.yaml,
                ui/components/*.json, ui/templates/*.json are read from them); a key that could not be read is absent
     hashes     {previews: {screen: {relative path: sha256}}, specHashes: {screen: sha256}} for the ui/specs screens: they
                hash bytes, which a text map cannot carry
     yamlLoad   js-yaml's load (default: the global jsyaml, or require('js-yaml'))
   run(assembled) -> {diags, gate}: Core.check (skipped for an empty model, as the app does) then Core.gate. */
const GateInputs = (() => {
  const C = typeof Core !== 'undefined' ? Core : require('./core.js');
  const LG = typeof Ledger !== 'undefined' ? Ledger : require('./ledger.js');
  const DM = typeof Domain !== 'undefined' ? Domain : require('./domain.js');
  const UIM = typeof Ui !== 'undefined' ? Ui : require('./ui.js');
  const WK = typeof Work !== 'undefined' ? Work : require('./work.js');
  const CT = typeof Contracts !== 'undefined' ? Contracts : require('./contracts.js');
  const REG_DIRS = ['decisions', 'requirements', 'proposals', 'handovers', 'scenarios', 'evals', 'acceptance'];
  const TOKENS = 'design-tokens/tokens.json';

  // host.list(dir, exts): the files directly in dir, sorted by name, as {path, text}.
  const lister = files => (dir, exts) => {
    const out = [], pre = dir + '/';
    for (const p of Object.keys(files)) {
      if (!p.startsWith(pre)) continue;
      const name = p.slice(pre.length);
      if (!name || name.includes('/') || !(!exts || exts.some(x => name.endsWith(x)))) continue;
      out.push({ name, path: p, text: files[p] });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(({ path, text }) => ({ path, text }));
  };
  const subdirs = (files, dir) => {
    const pre = dir + '/', out = new Set();
    for (const p of Object.keys(files)) if (p.startsWith(pre) && p.slice(pre.length).includes('/')) out.add(p.slice(pre.length).split('/')[0]);
    return [...out].sort();
  };

  function assemble({ cfg: raw = {}, files = {}, registries = {}, hashes = {}, yamlLoad } = {}) {
    const load = yamlLoad || (typeof jsyaml !== 'undefined' ? jsyaml.load : require('js-yaml').load);
    const cfg = { model: 'model/workspace.dsl', chainHops: 4, retryAmplification: 4, llm: {}, ...raw };
    const list = lister(files);
    const yamlErrors = [];
    // app.js loadYamlDir
    const loadYamlDir = (dir, keepText = false) => {
      const out = [];
      for (const f of list(dir, ['.yaml', '.yml'])) {
        try {
          const o = load(f.text) || {};
          if (typeof o !== 'object' || Array.isArray(o)) throw new Error('expected a mapping at the top level');
          for (const k of ['binds', 'resolves', 'checks', 'elements']) if (o[k] != null && !Array.isArray(o[k])) o[k] = [o[k]];
          out.push({ ...o, id: o.id || f.path.split('/').pop().replace(/\.ya?ml$/, ''), _path: f.path, ...(keepText ? { _text: f.text } : {}) });
        } catch (e) { yamlErrors.push({ path: f.path, line: (e.mark && e.mark.line + 1) || 1, msg: e.reason || e.message }); }
      }
      return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    };
    // app.js loadRegistry
    const [decisions, requirements, , , scenarios, evals, acceptance] = REG_DIRS.map(d => loadYamlDir(d, d === 'evals' || d === 'acceptance'));
    for (const n of subdirs(files, 'handovers')) loadYamlDir(`handovers/${n}`);
    decisions.forEach(d => { d.status = d.status || 'minted'; d.effect = d.effect || 'fix'; });
    // B4: test-scenarios/*.yaml, parsed with _path. A file that does not parse is the work view's problem (Problems), not a registry clause.
    const testScenarios = [];
    for (const f of list('test-scenarios', ['.yaml', '.yml'])) { try { const o = load(f.text); if (o && typeof o === 'object' && !Array.isArray(o)) testScenarios.push({ ...o, _path: f.path }); } catch { /* skipped */ } }
    const apiFiles = list('contracts/openapi', ['.yaml', '.yml']);
    const apiContracts = apiFiles.map(f => f.path);
    const tokens = files[TOKENS] != null ? files[TOKENS] : null;
    const contractsText = files['contracts/out/result.json'] != null ? files['contracts/out/result.json'] : null;
    // app.js loadLedger
    const raw_ = [];
    for (const f of list('ledger', ['.jsonl'])) raw_.push(...LG.parse(f.text, f.path).events);
    const ledgerRaw = LG.order(raw_), ledger = LG.derive(ledgerRaw);
    // workview.js loadWork: the items, for Work.states
    const work = [];
    for (const f of list('work', ['.yaml', '.yml'])) {
      try {
        const o = load(f.text) || {};
        if (typeof o !== 'object' || Array.isArray(o)) throw new Error('expected a mapping at the top level');
        work.push({ ...o, id: o.id || f.path.split('/').pop().replace(/\.ya?ml$/, ''), _path: f.path });
      } catch { /* a work file that does not parse is `designc work`'s problem, not the gate's */ }
    }
    work.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    // app.js loadDomains + domainsInput
    const packs = [], packSources = {};
    const listed = Array.isArray(cfg.domains) ? cfg.domains : [];
    for (const f of list('domain', ['.yaml', '.yml'])) packs.push({ key: f.path.split('/').pop().replace(/\.ya?ml$/, ''), path: f.path, text: f.text, load });
    let packBehaviour = [];
    if (packs.length || listed.length) {
      packBehaviour = list('behaviour', ['.p']);
      for (const [key, pin] of DM.pins(ledger)) { const r = registries[pin.registry]; packSources[key] = r && r[`domain/${key}.yaml`] != null ? r[`domain/${key}.yaml`] : null; }
    }
    const domains = packs.length || (Array.isArray(cfg.domains) && cfg.domains.length) ? { listed: cfg.domains || [], packs, sources: packSources, behaviour: packBehaviour } : null;
    // app.js uiSource + loadUi
    const uiSource = key => {
      const r = registries[key];
      if (!r) return null;
      const under = (dir) => Object.keys(r).filter(p => p.startsWith(dir + '/') && !p.slice(dir.length + 1).includes('/') && p.endsWith('.json')).sort().map(p => ({ path: p, text: r[p] }));
      const components = under('ui/components'), templates = under('ui/templates');
      return components.length || templates.length ? { components, templates } : null;
    };
    const jsonFiles = d => list(d, ['.json']);
    const pack = { components: jsonFiles('ui/pack/components'), templates: jsonFiles('ui/pack/templates') };
    const specs = jsonFiles('ui/specs'), holdouts = jsonFiles('ui/holdout'), legacy = jsonFiles('ui/legacy');
    let ui = null;
    if (pack.components.length || pack.templates.length || specs.length || holdouts.length || legacy.length) {
      const pin = UIM.latestPin(ledger), sources = {};
      if (pin && (pack.components.length || pack.templates.length)) sources[pin.pack] = uiSource(pin.registry);
      const uiScenarios = [];
      for (const f of list('parity/scenarios', ['.yaml', '.yml'])) { try { const o = load(f.text); if (o && typeof o === 'object' && !Array.isArray(o)) uiScenarios.push(o); } catch { /* parity says so */ } }
      const previews = {}, specHashes = {};
      for (const f of specs) {
        const screen = f.path.split('/').pop().replace(/\.json$/, '');
        if (!/^[a-z0-9-]+$/.test(screen)) continue;
        if (hashes.previews && hashes.previews[screen] !== undefined) previews[screen] = hashes.previews[screen];
        if (hashes.specHashes && hashes.specHashes[screen] !== undefined) specHashes[screen] = hashes.specHashes[screen];
      }
      ui = { pack, specs, legacy, holdouts, sources, scenarios: uiScenarios, previews, specHashes };
    }
    const modelText = files[cfg.model] != null ? files[cfg.model] : null;
    const model = C.parse(modelText == null ? '' : modelText, { path: cfg.model, resolve: p => (files[p] != null ? files[p] : null) });
    // contractsview.js contractGaps
    const contractGaps = () => {
      const c = cfg.contracts, s = CT.settings(c);
      if (!s || s.error || c.require !== true || !model || model.errors.length) return [];
      let doc; try { doc = C.handoverAgents({ text: modelText, path: cfg.model, resolve: p => (files[p] != null ? files[p] : null) }); } catch { return []; }
      return CT.gaps({ resultText: contractsText, agentsDoc: doc, agentsText: JSON.stringify(doc, null, 2) + '\n', hash: C._shared.hash16 });
    };
    // R4: what a rel's d.operation / d.message is checked against, computed once for the lint and the gate.
    const operations = C.operations({ files: Object.fromEntries(apiFiles.map(f => [f.path, f.text])), yamlLoad: load });
    const boundary = { operations, events: C.packEvents(packs) };
    const checkOptions = { chainHops: cfg.chainHops || 4, retryAmplification: cfg.retryAmplification || 4, repos: cfg.repos, boundary };
    const gateInputs = {
      model, decisions, requirements, ledger, registryErrors: yamlErrors.map(e => ({ path: e.path, message: e.msg })),
      evidenceHosts: cfg.evidenceHosts || [], businessOwners: cfg.businessOwners || [], scenarios, evals, acceptance, tokens,
      minTextSize: (cfg.ux && cfg.ux.minTextSize) || C.DEFAULT_MIN_TEXT, contractGaps: contractGaps(), repos: cfg.repos,
      apiContracts, operations, domains, ui, testScenarios, workStates: WK.states(work, ledger),
    };
    return { cfg, modelText, model, checkOptions, gateInputs, yamlErrors, work, ledger, ledgerRaw };
  }

  // app.js recompile: check only a model that has something in it, then the gate.
  function run(a, core = C) {
    const m = a.model;
    const diags = m.elements.size || m.errors.length ? core.check(m, a.checkOptions) : [];
    return { diags, gate: core.gate({ ...a.gateInputs, diags }) };
  }

  return { assemble, run, REG_DIRS };
})();
if (typeof module !== 'undefined') module.exports = GateInputs;
