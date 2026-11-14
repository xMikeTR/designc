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
  //   ledger, sources: {pack: {components, templates} | null}, hash}): {clauses, notes, coverage}. Gate clauses of kind
  //   `ui`. Nothing runs unless a pack is copied or a spec exists. A source left out of `sources` is not compared.
  function clauses({ pack = { components: [], templates: [] }, specs = [], holdouts = [], tokens = null, ledger = [], sources = {}, hash }) {
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
    } else if (specs.length) push('ui/specs/ has specs but no UI pack is pinned: pin one from its kind: ui registry');
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
    return { clauses: out, notes, coverage };
  }
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

  return { CLOSED_TOKEN_GROUPS, LOCATOR_ROLES, validate, tokenGroups, readPack, checkSpec, checkHoldout, pins, latestPin, packFiles, packHash, packDiff, clauses };
})();
if (typeof module !== 'undefined') module.exports = Ui;
