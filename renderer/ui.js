/* designc desktop: UI packs and screen specs. Pure, no I/O, no dependencies.
   Dual-load like renderer/domain.js: <script src="ui.js"> after ui-schemas.js and before core.js in the renderer,
   require('./ui.js') from core.js and tests. python/designc/ui.py mirrors every clause word for word
   (test/ui-parity.test.js). docs/ui-contract.md says what the pieces are.
   A UI pack (components + templates, source: a kind: ui registry) is pinned into ui/pack/. A screen spec
   (ui/specs/<screen>.json) fills a template's slots with the pack's components. The checks are a port of the
   standalone kit's validate.ts: pack (check 1), spec (check 2), states (check 3) and the holdout clause. */
const Ui = (() => {
  const S = typeof require === 'function' && typeof module === 'object' ? require('./ui-schemas.js') : UiSchemas;
  // Token groups a spec may use. The groups are read from the project's W3C design-tokens/tokens.json.
  const CLOSED_TOKEN_GROUPS = ['space', 'color', 'density', 'tone'];
  const REQUIRED_STATES = ['ready', 'loading', 'empty', 'error'];
  // Same list as Core.LOCATOR_ROLES (test/ui.test.js holds them together): spec locators join acceptance and parity.
  const LOCATOR_ROLES = ['alert', 'button', 'cell', 'checkbox', 'combobox', 'dialog', 'form', 'heading', 'img', 'label', 'link', 'list', 'listitem', 'main', 'navigation', 'option', 'radio', 'region', 'row', 'searchbox', 'status', 'switch', 'tab', 'table', 'tabpanel', 'textbox'];
  const isMap = v => v != null && typeof v === 'object' && !Array.isArray(v);
  const normal = t => String(t).replace(/\r\n/g, '\n');
  // A value in a sentence: primitives as JS prints them, anything else as compact JSON.
  const show = v => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));
  const canon = v => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : isMap(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));

  // ---------- a small JSON Schema checker ----------
  // The subset docs/ui-*.schema.json uses: type, enum, const, pattern, minLength, minItems, minProperties, minimum,
  // required, properties, additionalProperties, items, allOf with if/then, oneOf and local $ref. Messages are Ajv's
  // in spirit; python/designc/ui.py has the same checker.
  const kindOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);
  const typeOk = (t, v) => { const k = kindOf(v); return t === k || (t === 'number' && k === 'integer'); };
  function resolve(ref, root) {
    const [base, ptr] = ref.split('#');
    const doc = base ? S[base] : root;
    let node = doc;
    for (const part of (ptr || '').split('/').filter(Boolean)) node = node && node[part];
    return { schema: node, root: doc };
  }
  function check(schema, v, root, at, out) {
    if (schema.$ref) { const r = resolve(schema.$ref, root); return check(r.schema, v, r.root, at, out); }
    const bad = msg => out.push({ at: at || '/', msg });
    if (schema.type && !typeOk(schema.type, v)) return bad(`must be ${schema.type}`);
    if (schema.enum && !schema.enum.some(x => canon(x) === canon(v))) bad(`must be equal to one of the allowed values (${schema.enum.join(', ')})`);
    if (schema.const !== undefined && canon(schema.const) !== canon(v)) bad(`must be equal to constant`);
    if (typeof v === 'string') {
      if (schema.pattern && !new RegExp(schema.pattern).test(v)) bad(`must match pattern "${schema.pattern}"`);
      if (schema.minLength != null && [...v].length < schema.minLength) bad(`must NOT have fewer than ${schema.minLength} characters`);
    }
    if (typeof v === 'number' && schema.minimum != null && v < schema.minimum) bad(`must be >= ${schema.minimum}`);
    if (Array.isArray(v)) {
      if (schema.minItems != null && v.length < schema.minItems) bad(`must NOT have fewer than ${schema.minItems} items`);
      if (schema.items) v.forEach((x, i) => check(schema.items, x, root, `${at}/${i}`, out));
    }
    if (isMap(v)) {
      if (schema.minProperties != null && Object.keys(v).length < schema.minProperties) bad(`must NOT have fewer than ${schema.minProperties} properties`);
      for (const r of schema.required || []) if (!(r in v)) bad(`must have required property '${r}'`);
      const props = schema.properties || {};
      for (const k of Object.keys(v)) {
        if (k in props) check(props[k], v[k], root, `${at}/${k}`, out);
        else if (schema.additionalProperties === false) bad(`must NOT have additional properties: '${k}'`);
        else if (isMap(schema.additionalProperties)) check(schema.additionalProperties, v[k], root, `${at}/${k}`, out);
      }
    }
    for (const sub of schema.allOf || []) {
      if (sub.if) {
        const probe = []; check(sub.if, v, root, at, probe);
        if (!probe.length && sub.then) check(sub.then, v, root, at, out);
      } else check(sub, v, root, at, out);
    }
    if (schema.oneOf) {
      const hits = schema.oneOf.filter(s => { const probe = []; check(s, v, root, at, probe); return !probe.length; });
      if (hits.length !== 1) bad('must match exactly one schema in oneOf');
    }
  }
  // validate('ui-screen-spec', doc): [{at, msg}], empty when the document fits.
  function validate(id, doc) {
    const root = S[`${id}.schema.json`], out = [];
    check(root, doc, root, '', out);
    return out;
  }

  // ---------- tokens ----------
  // tokenGroups(text): the W3C design-tokens file as {group: [token names]}. A token's name is its path below the
  // group, joined with dots (`primary`, `size.large`). null when the file is absent or does not parse.
  function tokenGroups(text) {
    if (text == null) return null;
    let doc; try { doc = JSON.parse(text); } catch { return null; }
    if (!isMap(doc)) return null;
    const groups = {};
    const walk = (node, path, group) => {
      for (const [k, v] of Object.entries(node)) {
        if (k.startsWith('$') || !isMap(v)) continue;
        if ('$value' in v) (groups[group] = groups[group] || []).push([...path, k].join('.'));
        else walk(v, [...path, k], group);
      }
    };
    for (const [g, v] of Object.entries(doc)) if (!g.startsWith('$') && isMap(v)) { if ('$value' in v) continue; walk(v, [], g); }
    return groups;
  }

  // ---------- reading the pack ----------
  const fmt = (file, at, msg, fix) => `${file}${at && at !== '/' ? ' ' + at : ''}: ${msg}${fix ? '. ' + fix : ''}`;
  function parseJson(f, out) {
    try { return JSON.parse(f.text); } catch { out.push(`${f.path} does not parse as JSON`); return null; }
  }
  const baseName = p => p.split('/').pop().replace(/\.json$/, '');
  // readPack({components: [{path, text}], templates: [...]}, groups): {components: Map, templates: Map, problems: [text]}.
  function readPack({ components = [], templates = [] }, groups) {
    const problems = [], comps = new Map(), tpls = new Map();
    const tokenNames = Object.keys(groups || {}).filter(g => CLOSED_TOKEN_GROUPS.includes(g));
    let needTokens = false;
    for (const f of components) {
      const m = parseJson(f, problems);
      if (m === null) continue;
      for (const e of validate('ui-component-manifest', m)) problems.push(fmt(f.path, e.at, `schema: ${e.msg}`));
      if (!isMap(m)) continue;
      if (comps.has(m.name)) problems.push(fmt(f.path, '/name', `Duplicate component '${m.name}' (also in ${comps.get(m.name).file})`));
      if (typeof m.name === 'string' && baseName(f.path) !== m.name) { /* a note, see clauses */ }
      if (isMap(m.props)) for (const [p, def] of Object.entries(m.props)) {
        if (!isMap(def) || def.type !== 'token' || typeof def.token !== 'string') continue;
        if (!groups) needTokens = true;
        else if (!groups[def.token]) problems.push(fmt(f.path, `/props/${p}`, `Unknown token group '${def.token}'`, `Add it to design-tokens/tokens.json or use one of: ${tokenNames.join(', ')}`));
      }
      if (typeof m.name === 'string' && !comps.has(m.name)) comps.set(m.name, { file: f.path, m });
    }
    if (needTokens) problems.push('ui/pack: a component has a token prop, but design-tokens/tokens.json is missing or does not parse. Add it, with the groups space, color, density and tone');
    for (const f of templates) {
      const t = parseJson(f, problems);
      if (t === null) continue;
      for (const e of validate('ui-template', t)) problems.push(fmt(f.path, e.at, `schema: ${e.msg}`));
      if (isMap(t) && typeof t.name === 'string') tpls.set(t.name, { file: f.path, t });
    }
    return { components: comps, templates: tpls, problems };
  }

  // ---------- checking a spec ----------
  function flattenSlots(slots, prefix = '') {
    const out = new Map();
    for (const [name, s] of Object.entries(isMap(slots) ? slots : {})) {
      if (!isMap(s)) continue;
      const p = prefix ? `${prefix}.${name}` : name;
      out.set(p, s);
      for (const [k, v] of flattenSlots(s.subslots, p)) out.set(k, v);
    }
    return out;
  }
  // checkSpec(file, text, ctx): problems (clause texts) and notes for one spec. ctx: {pack, groups}. Returns
  // {problems, notes, spec} (spec is null when it does not parse).
  function checkSpec(file, text, { pack, groups }) {
    const problems = [], notes = [];
    const err = (at, msg, fix) => problems.push(fmt(file, at, msg, fix));
    const note = (at, msg, fix) => notes.push(fmt(file, at, msg, fix));
    let spec; try { spec = JSON.parse(text); } catch { return { problems: [`${file} does not parse as JSON`], notes, spec: null }; }
    for (const e of validate('ui-screen-spec', spec)) err(e.at, `schema: ${e.msg}`);
    if (!isMap(spec)) return { problems, notes, spec: null };
    if (!pack) { err('/template', 'No UI pack is pinned, so the template and components cannot be checked', 'Pin the pack from its kind: ui registry'); return { problems, notes, spec }; }
    const tpl = pack.templates.get(spec.template);
    if (!tpl) { err('/template', `Unknown template '${show(spec.template)}'`, `Use one of: ${[...pack.templates.keys()].join(', ')}`); return { problems, notes, spec }; }
    if (tpl.t.status !== 'bound') err('/template', `Template '${spec.template}' is ${show(tpl.t.status)}, not bound`);
    const slots = flattenSlots(tpl.t.slots);
    const data = isMap(spec.data) ? spec.data : {};
    const usedData = new Set(), ids = new Set();
    for (const [path, placements] of Object.entries(isMap(spec.slots) ? spec.slots : {})) {
      if (!Array.isArray(placements)) continue;
      const slot = slots.get(path);
      if (!slot) { err(`/slots/${path}`, `Template '${spec.template}' has no slot '${path}'`, `Slots are: ${[...slots.keys()].join(', ')}`); continue; }
      if (slot.max !== undefined && placements.length > slot.max) err(`/slots/${path}`, `Slot '${path}' takes at most ${slot.max}, got ${placements.length}`);
      placements.forEach((pl, i) => {
        if (!isMap(pl)) return;
        const at = `/slots/${path}/${i}`;
        if (pl.id) { if (ids.has(pl.id)) err(`${at}/id`, `Duplicate id '${show(pl.id)}'`); ids.add(pl.id); }
        else note(at, 'No id: the visual check cannot map this element back to the spec');
        const entry = pack.components.get(pl.component);
        if (!entry) { err(`${at}/component`, `'${show(pl.component)}' is not in the catalogue`, 'Use a catalogued component, or have the catalogue stage mint a manifest and get it bound'); return; }
        const m = entry.m;
        if (m.status !== 'bound') err(`${at}/component`, `'${m.name}' is ${show(m.status)}, not bound`);
        const accepts = Array.isArray(slot.accepts) ? slot.accepts : [];
        if (!accepts.includes(m.category)) err(`${at}/component`, `'${m.name}' is a ${show(m.category)}; slot '${path}' accepts ${accepts.join(' | ')}`);
        const props = isMap(pl.props) ? pl.props : {};
        const mprops = isMap(m.props) ? m.props : {}, mdata = isMap(m.data) ? m.data : {};
        for (const [p, def] of Object.entries(mprops)) if (isMap(def) && def.required && !(p in props)) err(`${at}/props`, `'${m.name}' requires prop '${p}'`);
        for (const [p, v] of Object.entries(props)) {
          const def = mprops[p];
          if (!isMap(def)) {
            const hint = mdata[p] ? `'${p}' is a data prop: put it under bind` : `Allowed props: ${Object.keys(mprops).join(', ') || 'none'}`;
            err(`${at}/props/${p}`, `'${m.name}' has no prop '${p}'`, hint); continue;
          }
          if (def.type === 'enum' && Array.isArray(def.values) && !def.values.includes(v)) err(`${at}/props/${p}`, `'${show(v)}' is not one of ${def.values.join(' | ')}`);
          if (def.type === 'token' && groups && groups[def.token] && !groups[def.token].includes(String(v))) err(`${at}/props/${p}`, `'${show(v)}' is not a ${def.token} token`, `Use one of: ${groups[def.token].join(', ')}`);
          if (['string', 'action'].includes(def.type) && typeof v !== 'string') err(`${at}/props/${p}`, 'Expected a string');
          if (def.type === 'number' && typeof v !== 'number') err(`${at}/props/${p}`, 'Expected a number');
          if (def.type === 'boolean' && typeof v !== 'boolean') err(`${at}/props/${p}`, 'Expected a boolean');
        }
        const bind = isMap(pl.bind) ? pl.bind : {};
        for (const [dp, def] of Object.entries(mdata)) if (isMap(def) && def.required && !(dp in bind)) err(`${at}/bind`, `'${m.name}' needs data '${dp}' (${show(def.shape)})`);
        for (const [dp, key] of Object.entries(bind)) {
          const def = mdata[dp];
          if (!isMap(def)) { err(`${at}/bind/${dp}`, `'${m.name}' has no data prop '${dp}'`); continue; }
          const d = data[key];
          if (!d) { err(`${at}/bind/${dp}`, `No data key '${show(key)}'`, 'Declare it under data with a shape and source'); continue; }
          usedData.add(key);
          if (d.shape !== def.shape) err(`${at}/bind/${dp}`, `'${show(key)}' is ${show(d.shape)}; '${m.name}.${dp}' expects ${show(def.shape)}`);
        }
      });
    }
    const filled = p => (isMap(spec.slots) && Array.isArray(spec.slots[p]) ? spec.slots[p].length : 0);
    for (const [path, slot] of slots) {
      const n = filled(path);
      const parent = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : null;
      if ((slot.min || 0) > n && (!parent || filled(parent) > 0)) err(`/slots/${path}`, `Slot '${path}' needs at least ${slot.min}, got ${n}`);
    }
    for (const key of Object.keys(data)) if (!usedData.has(key)) note(`/data/${key}`, `Data '${key}' is declared but never shown`);
    if (typeof spec.screen === 'string' && baseName(file) !== spec.screen) note('/screen', `File name should be the screen name '${spec.screen}.json'`);
    checkStates(spec, err, note);
    return { problems, notes, spec };
  }

  // The state graph: one initial state, known names, every state reachable. Names shared with acceptance, parity
  // and QA bugs are checked in session D2.
  function checkStates(spec, err, note) {
    const states = isMap(spec.states) ? spec.states : {};
    const names = Object.keys(states);
    const st = n => (isMap(states[n]) ? states[n] : {});
    const initial = names.filter(n => st(n).initial);
    if (initial.length !== 1) err('/states', `Exactly one state is initial, found ${initial.length}${initial.length ? `: ${initial.join(', ')}` : ''}`);
    const missing = REQUIRED_STATES.filter(s => !(s in states));
    if (missing.length) note('/states', `No state named ${missing.join(', ')}`, "Acceptance asks for a case per required state. Add it, or name your main state 'ready'");
    const data = isMap(spec.data) ? spec.data : {};
    for (const n of names) {
      const s = st(n);
      for (const [where, keys] of [['data', Object.keys(isMap(s.data) ? s.data : {})], ['pending', Array.isArray(s.pending) ? s.pending : []], ['failed', Array.isArray(s.failed) ? s.failed : []]])
        for (const key of keys) if (!(key in data)) err(`/states/${n}/${where}/${key}`, `No data key '${show(key)}'`);
    }
    const edges = new Map();
    (Array.isArray(spec.transitions) ? spec.transitions : []).forEach((t, i) => {
      if (!isMap(t)) return;
      for (const a of ['click', 'fill', 'select']) if (isMap(t.on) && isMap(t.on[a]) && !LOCATOR_ROLES.includes(t.on[a].role)) err(`/transitions/${i}/on/${a}`, `Locator role '${show(t.on[a].role)}' is not an acceptance role`);
      for (const end of ['from', 'to']) if (!(t[end] in states)) err(`/transitions/${i}/${end}`, `No state '${show(t[end])}'`, `States are: ${names.join(', ')}`);
      edges.set(t.from, [...(edges.get(t.from) || []), t.to]);
    });
    if (initial.length === 1) {
      const seen = new Set([initial[0]]), todo = [initial[0]];
      while (todo.length) for (const n of edges.get(todo.pop()) || []) if (!seen.has(n)) { seen.add(n); todo.push(n); }
      for (const n of names) if (!seen.has(n)) err(`/states/${n}`, `State '${n}' cannot be reached from '${initial[0]}'`, 'No scenario can record it. Add a transition');
    }
    const locs = new Map();
    for (const [path, pls] of Object.entries(isMap(spec.slots) ? spec.slots : {})) {
      if (!Array.isArray(pls)) continue;
      for (const pl of pls) if (isMap(pl) && isMap(pl.locator)) {
        if (!LOCATOR_ROLES.includes(pl.locator.role)) err(`/slots/${path}`, `Locator role '${show(pl.locator.role)}' is not an acceptance role`, `Use one of: ${LOCATOR_ROLES.join(', ')}`);
        const k = `${pl.locator.role}|${pl.locator.name}`;
        if (locs.has(k)) note(`/slots/${path}`, `Locator ${show(pl.locator.role)} '${show(pl.locator.name)}' is used twice (also ${locs.get(k)})`, 'Parity and acceptance cannot tell them apart');
        locs.set(k, pl.id !== undefined && pl.id !== null && pl.id !== '' ? pl.id : path);
      }
    }
  }

  // ---------- holdout ----------
  // The holdout sample for one screen: a second set of values for the spec's data keys. The keys exist in the spec,
  // and no value equals the visible sample, or the holdout proves nothing.
  function checkHoldout(file, text, spec, specPath) {
    const problems = [];
    let h; try { h = JSON.parse(text); } catch { return [`${file} does not parse as JSON`]; }
    for (const e of validate('ui-holdout', h)) problems.push(fmt(file, e.at, `schema: ${e.msg}`));
    if (!isMap(h)) return problems;
    if (!spec) { problems.push(`${file} has no spec: ${baseName(file)} is not a screen in ui/specs/. Add the spec, or remove the holdout`); return problems; }
    const data = isMap(spec.data) ? spec.data : {};
    for (const [k, v] of Object.entries(h)) {
      if (!(k in data)) { problems.push(fmt(file, `/${k}`, `No data key '${k}' in ${specPath}`, `The spec declares: ${Object.keys(data).join(', ') || 'no data'}`)); continue; }
      if (isMap(data[k]) && data[k].sample !== undefined && canon(data[k].sample) === canon(v)) problems.push(fmt(file, `/${k}`, `The holdout for '${k}' equals the visible sample in ${specPath}`, 'Write different values: a holdout that matches the sample proves nothing'));
    }
    return problems;
  }

  // ---------- pins ----------
  // pins(ledger): the latest ui_pinned per pack (by _ts, later lines win ties).
  function pins(ledger) {
    const out = new Map(), at = new Map();
    for (const e of ledger || []) {
      if (e.kind !== 'ui_pinned' || !e.pack) continue;
      const ts = e._ts || 0;
      if (at.has(e.pack) && at.get(e.pack) > ts) continue;
      at.set(e.pack, ts); out.set(e.pack, { hash: e.hash, registry: e.registry || e.pack });
    }
    return out;
  }
  // The pack's files as relative path -> text, for hashing and for comparing a pin with its source registry.
  const rel = (p, prefix) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);
  function packFiles({ components = [], templates = [] }, prefix) {
    return [...components, ...templates].map(f => ({ path: rel(f.path, prefix), text: f.text })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  const packHash = (files, hash) => hash(files.map(f => `${f.path}\n${normal(f.text)}\n`).join(''));
  // What a re-pin would change: files added, removed or edited, by relative path.
  function packDiff(before, after) {
    const a = new Map(before.map(f => [f.path, normal(f.text)])), b = new Map(after.map(f => [f.path, normal(f.text)]));
    return {
      added: [...b.keys()].filter(k => !a.has(k)).sort(),
      removed: [...a.keys()].filter(k => !b.has(k)).sort(),
      changed: [...b.keys()].filter(k => a.has(k) && a.get(k) !== b.get(k)).sort(),
    };
  }

  // ---------- gate clauses ----------
  // clauses({pack: {components, templates} (the ui/pack/ copy), specs, holdouts: [{path, text}], tokens: text|null,
  //   ledger, sources: {pack: {components, templates} | null}, acceptance: [{id, component, states, cases}] (Core.gate
  //   derives it: `component` is the last segment of the criterion's elements.json id), scenarios: [{id, screen?, steps}]
  //   (parity/scenarios/*.yaml, parsed), hash}): {clauses, notes, coverage}. Gate clauses of kind `ui`. Nothing runs
  //   unless a pack is copied or a spec exists. A source left out of `sources` is not compared. A criterion joins a spec by
  //   `component`, a scenario by `screen`; one with no matching spec is left alone. State rules R1, R2, R4, R5: stateRules.
  //   D3, check 4 (previewRules): uiElements (names of the model's elements tagged UI), previews {screen: {relpath: sha256}} (what is on
  //   disk under ui/previews/<screen>/) and specHashes {screen: sha256 of the spec file's bytes}.
  function clauses({ pack = { components: [], templates: [] }, specs = [], holdouts = [], tokens = null, ledger = [], sources = {}, acceptance = [], scenarios = [], previews = {}, specHashes = {}, uiElements = [], hash }) {
    const out = [], notes = [], coverage = [];
    const hasPack = pack.components.length + pack.templates.length > 0;
    if (!hasPack && !specs.length && !holdouts.length) return { clauses: out, notes, coverage };
    const push = (text, extra = {}) => out.push({ kind: 'ui', text, ...extra });
    const groups = tokenGroups(tokens);
    const pinned = pins(ledger);
    let readP = null;
    if (hasPack) {
      const files = packFiles(pack, 'ui/pack/');
      const h = packHash(files, hash);
      const pin = [...pinned.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([k, v]) => ({ pack: k, ...v }))[0];
      const latest = latestPin(ledger);
      const cur = latest || pin;
      if (!cur) push('ui/pack/ is not pinned: pin it from its kind: ui registry');
      else if (cur.hash !== h) push(`ui/pack/ was edited after it was pinned: restore it, or re-pin from the ${cur.registry} registry`, { pack: cur.pack });
      else if (Object.prototype.hasOwnProperty.call(sources, cur.pack)) {
        const src = sources[cur.pack];
        if (src == null) notes.push(`${cur.pack}: its registry could not be read, so whether a newer pack exists is unknown`);
        else if (packHash(packFiles(src, 'ui/'), hash) !== h) push(`${cur.pack} changed in its registry since it was pinned: re-pin to take it`, { pack: cur.pack });
      }
      readP = readPack({ components: [...pack.components].sort(byPath), templates: [...pack.templates].sort(byPath) }, groups);
      for (const p of readP.problems) push(p);
    }
    const parsed = new Map();
    for (const f of [...specs].sort(byPath)) {
      const r = checkSpec(f.path, f.text, { pack: readP, groups });
      for (const p of r.problems) push(p, { path: f.path, ...(r.spec && typeof r.spec.screen === 'string' ? { screen: r.spec.screen } : {}) });
      notes.push(...r.notes);
      if (r.spec) parsed.set(baseName(f.path), { path: f.path, spec: r.spec });
    }
    const held = new Set();
    for (const f of [...holdouts].sort(byPath)) {
      const screen = baseName(f.path), s = parsed.get(screen);
      held.add(screen);
      for (const p of checkHoldout(f.path, f.text, s ? s.spec : null, s ? s.path : `ui/specs/${screen}.json`)) push(p, { path: f.path, screen });
    }
    for (const [screen, s] of [...parsed].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (!held.has(screen)) coverage.push(`${s.path}: no holdout sample (ui/holdout/${screen}.json), so a page hard-coded to the visible sample would pass`);
    stateRules({ parsed, acceptance, scenarios, push, coverage });
    previewRules({ parsed, acceptance, ledger, previews, specHashes, uiElements, push });
    return { clauses: out, notes, coverage };
  }
  // The spec's states are the spine (docs/ui-contract.md). R1: a criterion's states and cases must be in the spec (a state
  // outside the acceptance five is the acceptance clause's to say). R2: a parity step's state must be. R4: a spec state no step
  // records is coverage. R5: a commits transition cannot be recorded read-only; a state reachable only through such edges is uncovered.
  const ACCEPTANCE_STATES = ['ready', 'loading', 'empty', 'error', 'forbidden'];
  function stateRules({ parsed, acceptance, scenarios, push, coverage }) {
    const specs = [...parsed.values()].filter(x => isMap(x.spec) && isMap(x.spec.states)).sort(byPath2);
    for (const { path, spec } of specs) {
      const names = Object.keys(spec.states), hint = `The spec has: ${names.join(', ')}`;
      const bad = (at, state, extra) => push(fmt(at, '', `State '${show(state)}' is not in spec ${spec.screen}`, hint), { path, screen: spec.screen, ...extra });
      for (const a of acceptance) {
        if (!a || a.component !== spec.component) continue;
        (Array.isArray(a.states) ? a.states : []).forEach((st, i) => { if (ACCEPTANCE_STATES.includes(st) && !names.includes(st)) bad(`acceptance/${a.id}/states/${i}`, st); });
        (Array.isArray(a.cases) ? a.cases : []).forEach((c, i) => { if (c && ACCEPTANCE_STATES.includes(c.state) && !names.includes(c.state)) bad(`acceptance/${a.id}/cases/${i}/state`, c.state); });
      }
      const recorded = new Set();
      for (const sc of scenarios) {
        if (!sc || typeof sc.screen !== 'string' || sc.screen !== spec.screen) continue;
        (Array.isArray(sc.steps) ? sc.steps : []).forEach((st, i) => {
          if (!st || typeof st.state !== 'string') return;
          recorded.add(st.state);
          if (!names.includes(st.state)) bad(`parity/scenarios/${sc.id}/steps/${i}/state`, st.state);
        });
      }
      const trans = Array.isArray(spec.transitions) ? spec.transitions : [];
      const initial = names.filter(n => isMap(spec.states[n]) && spec.states[n].initial);
      const edges = (readOnlyOnly) => {
        const m = new Map();
        for (const t of trans) if (isMap(t) && (!readOnlyOnly || t.commits !== true)) m.set(t.from, [...(m.get(t.from) || []), t.to]);
        return m;
      };
      const reach = (m) => { const seen = new Set(initial.length === 1 ? initial : []), todo = [...seen]; while (todo.length) for (const n of m.get(todo.pop()) || []) if (typeof n === 'string' && !seen.has(n)) { seen.add(n); todo.push(n); } return seen; };
      const commitOnly = new Set();
      trans.forEach((t, i) => { if (isMap(t) && t.commits === true) coverage.push(`${path} /transitions/${i}: ${show(t.from)} → ${show(t.to)} commits, so parity cannot record it read-only`); });
      if (initial.length === 1) { const all = reach(edges(false)), ro = reach(edges(true)); for (const n of names) if (all.has(n) && !ro.has(n)) { commitOnly.add(n); coverage.push(`${path} /states/${n}: State '${n}' is reachable only through transitions that commit, so no read-only scenario can record it`); } }
      for (const n of names) if (!recorded.has(n) && !commitOnly.has(n)) coverage.push(`${path} /states/${n}: State '${n}' is recorded by no parity step, so no scenario shows it`);
    }
  }
  // Check 4 (docs/ui-contract.md): a UI element needs a bound spec and previews a person approved, for every state its criterion
  // lists (the spec's states when it has no criterion). One clause per element and spec, the first thing that is wrong, so the next
  // step is always clear; missing state pictures are listed together. Scoped to a work item through `about`.
  function previewRules({ parsed, acceptance, ledger, previews, specHashes, uiElements, push }) {
    const latest = (kind, screen) => (ledger || []).filter(e => e.kind === kind && e.screen === screen).reduce((b, e) => (!b || (e._ts || 0) >= (b._ts || 0) ? e : b), null);
    for (const name of uiElements) {
      const mine = [...parsed.values()].filter(x => isMap(x.spec) && x.spec.component === name).sort(byPath2);
      if (!mine.length) { push(`no screen spec for component ${name}. Add ui/specs/<screen>.json with component "${name}"`, { about: [name] }); continue; }
      for (const { path, spec } of mine) {
        const screen = spec.screen, extra = { about: [name], path, screen };
        const say = (msg, hint) => push(fmt(path, '', msg, hint), extra);
        if (spec.status !== 'bound') { say('spec not bound', 'Check the previews, then press Approve and bind'); continue; }
        const rend = latest('ui_preview_rendered', screen);
        if (!rend) { say('previews not rendered', `Run factory-s2 preview for ${screen}`); continue; }
        const appr = latest('ui_preview_approved', screen);
        if (!appr) { say('previews not approved', 'Look at the page pictures, then press Approve previews'); continue; }
        if ((appr._ts || 0) <= (rend._ts || 0)) { say('approval is stale: rendered again since', 'Look at the new previews, then approve again'); continue; }
        const disk = previews[screen] || {}, held = isMap(appr.files) ? appr.files : {};
        const keys = Object.keys(disk).sort();
        if (canon(Object.fromEntries(keys.map(k => [k, disk[k]]))) !== canon(held)) { say('approval is stale: files changed since', 'Render again, then approve'); continue; }
        if (appr.spec !== specHashes[screen]) { say('approval is stale: the spec changed since', 'Render again, then approve'); continue; }
        const crit = acceptance.filter(a => a && a.component === name);
        const wanted = crit.length ? [...new Set(crit.flatMap(a => (Array.isArray(a.states) ? a.states : [])))] : Object.keys(isMap(spec.states) ? spec.states : {});
        for (const st of wanted) if (!Object.keys(held).some(k => !k.includes('/') && k.startsWith(`${st}-`) && k.endsWith('.png'))) say(`no approved preview for state ${st}`, 'Render the spec again, then approve');
      }
    }
  }
  // The Approve button on a spec. {label, enabled, why} or null when the spec's status has no button. It is enabled only when
  // approving would be valid at once: no other UI clause stands (a clause that names an element is check 4's, the rest are not), the
  // latest render is of the spec as it is on disk, and the files on disk are the ones that render wrote.
  function approveState({ spec, path, ledger, clauses = [], previews = {}, specHashes = {} }) {
    if (!isMap(spec) || (spec.status !== 'minted' && spec.status !== 'bound')) return null;
    const label = spec.status === 'minted' ? 'Approve and bind' : 'Approve previews', screen = spec.screen;
    const no = why => ({ label, enabled: false, why });
    const others = clauses.filter(c => c.kind === 'ui' && !c.about && (!c.path || c.path === path || c.screen === screen));
    if (others.length) return no(`${others.length === 1 ? 'Another UI clause' : `${others.length} other UI clauses`} must be fixed first: ${others[0].text}`);
    const rend = (ledger || []).filter(e => e.kind === 'ui_preview_rendered' && e.screen === screen).reduce((b, e) => (!b || (e._ts || 0) >= (b._ts || 0) ? e : b), null);
    if (!rend) return no(`Previews are not rendered: run Render previews for ${screen}`);
    if (rend.spec_hash !== specHashes[screen]) return no('The latest render is of another version of the spec: render again');
    if (canon(isMap(rend.files) ? Object.fromEntries(Object.keys(rend.files).sort().map(k => [k, rend.files[k]])) : {}) !== canon(Object.fromEntries(Object.keys(previews[screen] || {}).sort().map(k => [k, previews[screen][k]])))) return no('The files on disk are not the ones rendered: render again');
    return { label, enabled: true, why: '' };
  }

  // ---------- agent stages (D4) ----------
  // The reads and mints of the compose and catalogue stages. Pure: renderer/agent.js owns the I/O and the cards.
  const SCREEN_RE = /^[a-z][a-z0-9-]*$/;
  // What read_ui_spec lists with no screen: one row per spec file (a file that does not parse is listed, flagged).
  function specList(specs) {
    return [...specs].sort(byPath).map(f => {
      let s = null; try { s = JSON.parse(f.text); } catch { /* listed as unreadable */ }
      return isMap(s) ? { screen: s.screen, path: f.path, status: s.status, component: s.component, states: Object.keys(isMap(s.states) ? s.states : {}) } : { path: f.path, unreadable: true };
    });
  }
  // What read_ui_pack returns: the pinned pack's manifests and templates as the stage must use them.
  function packView(pack, groups) {
    const r = readPack({ components: [...pack.components].sort(byPath), templates: [...pack.templates].sort(byPath) }, groups);
    return { components: [...r.components.values()].map(c => c.m), templates: [...r.templates.values()].map(t => t.t), problems: r.problems,
      tokens: groups ? Object.fromEntries(Object.entries(groups).filter(([g]) => CLOSED_TOKEN_GROUPS.includes(g))) : null };
  }
  // The rows of the mint_ui_spec card: slot, component, the data it shows, why. Placements keep the spec's order.
  function specRows(spec) {
    const rows = [];
    for (const [slot, pls] of Object.entries(isMap(spec && spec.slots) ? spec.slots : {})) for (const pl of Array.isArray(pls) ? pls : []) {
      if (!isMap(pl)) continue;
      const bound = isMap(pl.bind) ? Object.entries(pl.bind).map(([prop, key]) => `${prop} ← ${show(key)}`) : [];
      rows.push({ slot, component: String(pl.component == null ? '' : pl.component), data: bound.join(', '), why: typeof pl.why === 'string' ? pl.why : '' });
    }
    return rows;
  }
  // mintSpec({screen, spec (object or JSON text), supersedes, existing (the file's text now, or null), pack (readPack result or null),
  //   groups}): {error} (what the agent is told, before any card) or {path, text, spec}. A spec is minted, never bound; one spec per
  //   screen, so a bound spec at the path is replaced only when `supersedes` names its screen.
  function mintSpec({ screen, spec, supersedes, existing = null, pack = null, groups = null }) {
    let doc = spec;
    if (typeof doc === 'string') { try { doc = JSON.parse(doc); } catch { return { error: 'spec does not parse as JSON.' }; } }
    if (!isMap(doc)) return { error: 'spec must be a JSON object.' };
    if (typeof screen !== 'string' || !SCREEN_RE.test(screen)) return { error: 'screen must be lower case letters, digits and hyphens, starting with a letter.' };
    if (doc.screen !== screen) return { error: `spec.screen is ${show(doc.screen)} but screen is ${screen}; the file is ui/specs/${screen}.json.` };
    if (doc.status !== 'minted') return { error: `status must be "minted" (it is ${show(doc.status)}). A person binds a spec with Approve and bind; an agent never does.` };
    const path = `ui/specs/${screen}.json`, text = JSON.stringify(doc, null, 2) + '\n';
    const r = checkSpec(path, text, { pack, groups });
    if (r.problems.length) return { error: `The spec fails its checks, so no card was shown. Fix these and mint again:\n${r.problems.map(p => `- ${p}`).join('\n')}` };
    let old = null; if (existing != null) { try { old = JSON.parse(existing); } catch { old = {}; } }
    const bound = isMap(old) && old.status === 'bound';
    if (bound && supersedes !== screen) return { error: `${path} is bound. One spec per screen: to replace it, mint again with supersedes: "${screen}". A person then approves the new previews.` };
    if (supersedes != null && !bound) return { error: `supersedes: "${supersedes}" names no bound spec at ${path}; leave it out.` };
    return { path, text, spec: doc, notes: r.notes, supersedes: bound };
  }
  // mintCatalogue({kind: 'component'|'template', doc}): {error} or {path, text, doc}. Manifests and templates are minted for a person
  //   to bind; the schema decides the shape. The file is named after the component or template.
  function mintCatalogue({ kind, doc, existing = null }) {
    if (kind !== 'component' && kind !== 'template') return { error: 'kind must be component or template.' };
    let d = doc;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return { error: `${kind} does not parse as JSON.` }; } }
    if (!isMap(d)) return { error: `${kind} must be a JSON object.` };
    if (d.status !== 'minted') return { error: `status must be "minted" (it is ${show(d.status)}). A person binds it; an agent never does.` };
    const id = kind === 'component' ? 'ui-component-manifest' : 'ui-template';
    const bad = validate(id, d);
    if (bad.length) return { error: `The ${kind} fails its schema, so no card was shown. Fix these and mint again:\n${bad.map(e => `- ${e.at || '/'}: ${e.msg}`).join('\n')}` };
    if (typeof d.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(d.name)) return { error: 'name must be letters, digits, dots, hyphens and underscores, so it can name the file.' };
    const path = `ui/${kind === 'component' ? 'components' : 'templates'}/${d.name}.json`;
    if (existing != null) { let old = null; try { old = JSON.parse(existing); } catch { /* replaced */ } if (isMap(old) && old.status && old.status !== 'minted') return { error: `${path} is ${old.status}; a person changes it. Mint under a new name, or ask them.` }; }
    return { path, text: JSON.stringify(d, null, 2) + '\n', doc: d };
  }
  const byPath2 = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  // The project has one pack in ui/pack/, so the latest pin overall is the one that counts.
  function latestPin(ledger) {
    let best = null;
    for (const e of ledger || []) {
      if (e.kind !== 'ui_pinned' || !e.pack) continue;
      if (!best || (e._ts || 0) >= (best._ts || 0)) best = e;
    }
    return best ? { pack: best.pack, hash: best.hash, registry: best.registry || best.pack } : null;
  }

  return { CLOSED_TOKEN_GROUPS, LOCATOR_ROLES, specList, packView, specRows, mintSpec, mintCatalogue, validate, tokenGroups, readPack, checkSpec, checkHoldout, pins, latestPin, packFiles, packHash, packDiff, clauses, approveState };
})();
if (typeof module !== 'undefined') module.exports = Ui;
