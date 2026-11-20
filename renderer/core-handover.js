// ===== designc core: handover =====
// Part of Core, split out of core.js with no behaviour change. Dual-loaded like core.js: a classic script in the
// renderer (after core.js) and required by core.js under Node. It reads what it needs from Core and adds its functions to it.
(Core => {
  const { parse, check, gate, domainOwners, blastRadius, evalHash, fingerprint, modelRevision, resolveElement } = Core;
  const { hash16, RESERVED_TEST_PATH, DM, PP, get, structural } = Core._shared;
  const UI = typeof require === 'function' && typeof module === 'object' ? require('./ui.js') : Ui;
  // ---------- handover ----------
  // The model resolved for whatever coding agent takes the handover (docs/handover-elements.schema.json), so
  // none of them has to parse the DSL: every element under its hierarchical id (System/Container/Component),
  // d.code as normalised path patterns and d.risk where declared, relationships by id (one per pair), and the
  // events behaviour announces. A model that does not parse, or a code area that is not a pattern, is refused.
  function handoverElements(modelText, behaviour = [], inScope = null, boundary = null) {
    const m = parse(modelText);
    if (m.errors.length) throw new Error(`handover refused: the model does not parse (line ${m.errors[0].line}: ${m.errors[0].msg})`);
    const elements = [...m.elements.values()].map(e => {
      const out = { id: m.label(e.id), name: e.name, kind: e.kind };
      if (e.props['d.code'] != null) out.code = String(e.props['d.code']).split(',').map(s => s.trim()).filter(Boolean).map(s => {
        const r = PP.create(s);
        if (!r.ok) throw new Error(`handover refused: ${e.name} d.code: ${r.error}`);
        return r.value;
      });
      if (e.props['d.risk'] != null) out.risk = e.props['d.risk'];
      for (let c = e; c && !out.repo; c = c.parent ? m.elements.get(c.parent) : null) if (c.props['d.repo'] != null) out.repo = String(c.props['d.repo']).trim();
      if (inScope) out.in_scope = inScope.includes(e.name);
      return out;
    });
    const pairs = new Map();
    for (const r of m.rels) { const from = m.label(r.src), to = m.label(r.dst); pairs.set(`${from}\0${to}`, { from, to }); }
    const events = [...new Set([...behaviour].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .flatMap(f => [...f.text.matchAll(/\bannounce\s+(\w+)/g)].map(x => x[1])))];
    const attached = boundary ? attachInterfaces(m, elements, boundary) : false;
    if (attached) return { schema: 'designc.handover.elements/3', elements, relationships: [...pairs.values()], events, ...(inScope ? { reserved: [RESERVED_TEST_PATH] } : {}) };
    return inScope
      ? { schema: 'designc.handover.elements/2', elements, relationships: [...pairs.values()], events, reserved: [RESERVED_TEST_PATH] }
      : { schema: 'designc.handover.elements/1', elements, relationships: [...pairs.values()], events };
  }

  // Interfaces (R4b): each typed relationship's resolved operation or event, attached to BOTH ends' entries so the two sides
  // read the same schema and the same version. Unresolved names are skipped (the gate blocks them). Returns true when any was attached.
  // The operation schema is the operation object with local '#/...' refs inlined; a ref already on the current path stays a $ref.
  function inlineRefs(node, doc, stack) {
    if (Array.isArray(node)) return node.map(x => inlineRefs(x, doc, stack));
    if (!node || typeof node !== 'object') return node;
    const ref = node.$ref;
    if (typeof ref === 'string' && ref.startsWith('#/') && !stack.includes(ref)) {
      let t = doc;
      for (const seg of ref.slice(2).split('/').map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'))) t = t != null && typeof t === 'object' ? t[seg] : undefined;
      if (t !== undefined) {
        const { $ref, ...rest } = node;
        const inl = inlineRefs(t, doc, [...stack, ref]);
        return inl && typeof inl === 'object' && !Array.isArray(inl) ? { ...inl, ...inlineRefs(rest, doc, stack) } : inl;
      }
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = inlineRefs(v, doc, stack);
    return out;
  }
  function attachInterfaces(m, elements, { apiContracts = [], packs = [] }) {
    const load = typeof jsyaml !== 'undefined' ? jsyaml.load : require('js-yaml').load;
    const files = {}; for (const f of apiContracts) files[f.path] = f.text;
    const ops = Core.operations({ files, yamlLoad: load }), events = Core.packEvents(packs);
    const reads = packs.map(p => DM.read(p.text, p.load, p.key)).filter(r => r.pack && !r.error).map(r => r.pack);
    const docs = new Map(), byId = new Map(elements.map(e => [e.id, e]));
    const docOf = file => { if (!docs.has(file)) docs.set(file, load(files[file])); return docs.get(file); };
    const found = new Map();
    for (const r of m.rels) {
      if (structural(m, r)) continue;
      const es = m.elements.get(r.src), ed = m.elements.get(r.dst);
      if (!es || !ed || es.kind === 'person' || ed.kind === 'person') continue;
      const op = get(r, 'd.operation'), msg = get(r, 'd.message');
      let iface = null, roles;
      const hits = op != null ? ops.operations.filter(o => o.operationId === String(op)) : [];
      if (hits.length === 1 && get(r, 'd.interaction') !== 'async') {
        const h = hits[0], item = docOf(h.file).paths[h.path][h.method.toLowerCase()];
        const schema = inlineRefs(item, docOf(h.file), []);
        iface = { kind: 'operation', id: h.operationId, method: h.method, path: h.path, file: h.file, schema, version: hash16(JSON.stringify(schema)) };
        roles = ['calls', 'serves'];
      } else if (msg != null) {
        const res = Core.resolveMessage(events, msg);
        if (!res.error) {
          const { pack, name } = res.event;
          const ev = reads.find(p => (p.id || '') === pack).events.find(e => e.name === name);
          iface = { kind: 'event', id: `${pack}/${name}`, pack, name, fields: ev.fields, version: hash16(JSON.stringify(ev.fields)) };
          roles = ['publishes', 'consumes'];
        }
      }
      if (!iface) continue;
      const rel = { from: m.label(r.src), to: m.label(r.dst) };
      [[rel.from, roles[0]], [rel.to, roles[1]]].forEach(([id, role]) => {
        const e = byId.get(id); if (!e) return;
        const item = { role, rel, ...iface }, key = JSON.stringify(item);
        if (!found.has(id)) found.set(id, new Map());
        found.get(id).set(key, item);
      });
    }
    for (const [id, items] of found) byId.get(id).interfaces = [...items.values()].sort((a, b) => (a.rel.from < b.rel.from ? -1 : a.rel.from > b.rel.from ? 1 : a.rel.to < b.rel.to ? -1 : a.rel.to > b.rel.to ? 1 : a.role < b.role ? -1 : a.role > b.role ? 1 : 0));
    return found.size > 0;
  }

  // The agents of the model described neutrally, for whatever turns a design into an agent contract
  // (docs/handover-agents.schema.json). It names no contract language: an agent is an element with the Agent tag or
  // a d.agent.autonomy, its declared d.agent.* properties are copied as declared (absent stays absent), and its
  // tool calls are the non-structural relationships it takes part in, with d.tool.effect, d.approval and
  // d.protocol where declared. A model that does not parse is refused. Pure.
  const AGENT_PROPS = ['autonomy', 'model', 'fallback', 'maxSteps', 'budget', 'memory', 'untrustedInput', 'privateData',
    'externalComms', 'codeExec', 'sandbox', 'identity', 'tracing', 'eval', 'pattern', 'patternWhy'];
  function handoverAgents(modelText) {
    const m = parse(modelText);
    if (m.errors.length) throw new Error(`handover refused: the model does not parse (line ${m.errors[0].line}: ${m.errors[0].msg})`);
    const isAgent = e => e.tags.has('Agent') || get(e, 'd.agent.autonomy') != null;
    const agents = [...m.elements.values()].filter(isAgent).map(e => {
      const out = { id: m.label(e.id), name: e.name };
      for (const k of AGENT_PROPS) { const v = get(e, `d.agent.${k}`); if (v != null) out[k] = v; }
      out.tools = m.rels.filter(r => (r.src === e.id || r.dst === e.id) && r.src !== r.dst && m.elements.has(r.src) && m.elements.has(r.dst) && !structural(m, r)).map(r => {
        const t = { direction: r.src === e.id ? 'out' : 'in', other: m.label(r.src === e.id ? r.dst : r.src), description: r.description || '' };
        for (const [k, key] of [['effect', 'd.tool.effect'], ['approval', 'd.approval'], ['protocol', 'd.protocol']]) { const v = get(r, key); if (v != null) t[k] = v; }
        return t;
      });
      return out;
    });
    return { schema: 'designc.handover.agents/1', agents };
  }

  // Spec skeletons : one Playwright spec per acceptance criterion, deterministic from the
  // criterion, written into the handover under tests/acceptance/<element>/<id>.spec.ts. `criteria` are the parsed
  // acceptance files (with `_text`, the file as read). `inScope` (element names) selects the specs the agent's
  // loop runs: those of the in-scope elements and of everything that depends on them (blastRadius); null for a
  // whole-model freeze, where the loop list is null and the full suite is the loop. Pure.
  // A case with `holdout: true` is hidden from the build (D5): it never becomes a generated spec here. The Factory asks for it
  // on its own with holdoutSpec.
  const isHoldout = c => !!c && c.holdout === true;
  const aSlug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'element';
  const aLine = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const aLoc = locs => n => { const l = locs[n]; return l && l.role === 'label' ? `page.getByLabel(${JSON.stringify(String(l.name))})` : `page.getByRole(${JSON.stringify(String(l && l.role))}, { name: ${JSON.stringify(String(l && l.name))} })`; };
  // One case as a Playwright test; n is its place among the criterion's cases for that state (1 for the first).
  function caseTest(a, c, n) {
    const q = JSON.stringify, line = aLine;
    const locs = a.locators && typeof a.locators === 'object' ? a.locators : {}, loc = aLoc(locs);
    const uses = (Array.isArray(c.uses) ? c.uses : []).filter(u => Object.prototype.hasOwnProperty.call(locs, u));
    return `  test(${q(n === 1 ? c.state : `${c.state} (${n})`)}, async ({ page }) => {
    // given: ${line(c.given)}
${c.when ? `    // when: ${line(c.when)}\n` : ''}    // then: ${line(c.then)}
${uses.map(u => `    await expect(${loc(u)}).toBeVisible();`).join('\n')}${uses.length ? '\n' : ''}  });`;
  }
  // The file for one criterion around its tests.
  function specFile(a, label, tests, axe) {
    const q = JSON.stringify;
    return `// GENERATED by designc from ${a._path || `acceptance/${a.id}.yaml`} (hash ${hash16(a._text || JSON.stringify(a))}). Do not edit: change the criterion and freeze again.
import { test, expect } from '../fixture';
${axe ? "import AxeBuilder from '@axe-core/playwright';\n" : ''}
test.describe(${q(`${a.id} ${label}`)}, () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(process.env.DESIGNC_BASE_URL ?? '/');
  });

${tests.join('\n\n')}
});
`;
  }
  function acceptanceSpecs({ model, criteria = [], inScope = null, consoleAllow = [] }) {
    const slug = aSlug, q = JSON.stringify;
    const files = [], byEl = new Map();
    for (const a of criteria) {
      if (!a || !a.id || !Array.isArray(a.cases)) continue;
      const el = resolveElement(model, a.element);
      if (!el) continue;
      const locs = a.locators && typeof a.locators === 'object' ? a.locators : {};
      const loc = aLoc(locs);
      const seen = new Map();
      const tests = a.cases.filter(c => c && c.state && !isHoldout(c)).map(c => {
        const n = (seen.get(c.state) || 0) + 1; seen.set(c.state, n);
        return caseTest(a, c, n);
      });
      const u = a.ux && typeof a.ux === 'object' && !Array.isArray(a.ux) ? a.ux : null;
      const declared = n => Object.prototype.hasOwnProperty.call(locs, n);
      if (u) {
        // UX rules (slice 34): checked on the ready state, which every criterion must have a case for.
        tests.push(`  test("ux: no accessibility violations", async ({ page }) => {
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });`);
        if (u.keyboard === true) tests.push(`  test("ux: reachable by keyboard", async ({ page }) => {
    // Tab through the page: every interactive element must take focus and show it.
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toBeVisible();
  });`);
        const order = (Array.isArray(u.focus_order) ? u.focus_order : []).filter(declared);
        if (order.length) tests.push(`  test("ux: focus order", async ({ page }) => {
${order.map(n => `    await page.keyboard.press('Tab');\n    await expect(${loc(n)}).toBeFocused();`).join('\n')}
  });`);
        if (u.focus_return && declared(u.focus_return)) tests.push(`  test("ux: focus returns", async ({ page }) => {
    await ${loc(u.focus_return)}.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(${loc(u.focus_return)}).toBeFocused();
  });`);
        for (const w of Array.isArray(u.breakpoints) ? u.breakpoints.filter(Number.isInteger) : []) tests.push(`  test("ux: no horizontal scroll at ${w}px", async ({ page }) => {
    await page.setViewportSize({ width: ${w}, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
  });`);
      }
      const label = model.label(el.id);
      const path = `tests/acceptance/${slug(label)}/${String(a.id).replace(/[^A-Za-z0-9._-]+/g, '-')}.spec.ts`;
      const text = specFile(a, label, tests, !!a.ux);
      files.push({ path, text });
      if (!byEl.has(el.id)) byEl.set(el.id, []);
      byEl.get(el.id).push(path);
    }
    if (files.length) files.push({ path: 'tests/acceptance/fixture.ts', text: acceptanceFixture(consoleAllow) });
    files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    if (!inScope) return { files, loop: null };
    const near = new Set();
    for (const el of model.elements.values()) {
      if (!inScope.includes(el.name)) continue;
      near.add(el.id);
      const r = blastRadius(model, el.id, { mode: 'misbehaves' });
      for (const x of r.error ? [] : [...r.down, ...r.degraded, ...r.unknown]) near.add(x.id);
    }
    const loop = [...near].flatMap(id => byEl.get(id) || []).sort();
    return { files, loop: [...new Set(loop)] };
  }

  // The shared fixture every generated spec imports: a test fails on a browser console error, a failed API call
  // (4xx, 5xx or a network failure) or a serious or critical axe-core violation, whatever the criterion says. `allow`
  // are known console noise (regex sources from designc.json ux.consoleAllow); it is part of the file, so part of the
  // frozen hashes. Deterministic, like the specs, and under the reserved acceptance path.
  function acceptanceFixture(allow = []) {
    const pats = (Array.isArray(allow) ? allow : []).filter(x => typeof x === 'string' && x).sort();
    return `// GENERATED by designc. Do not edit: change ux.consoleAllow in designc.json and freeze again.
import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ALLOWED_CONSOLE = [${pats.map(x => JSON.stringify(x)).join(', ')}].map(p => new RegExp(p));

export const test = base.extend<{ watch: void }>({
  watch: [async ({ page }, use) => {
    const problems: string[] = [];
    page.on('console', m => { if (m.type() === 'error' && !ALLOWED_CONSOLE.some(r => r.test(m.text()))) problems.push(\`console error: \${m.text()}\`); });
    page.on('pageerror', e => problems.push(\`uncaught error: \${e.message}\`));
    page.on('response', r => { if (r.status() >= 400 && r.request().resourceType() !== 'document') problems.push(\`API call failed: \${r.status()} \${r.request().method()} \${r.url()}\`); });
    page.on('requestfailed', r => { if (r.failure()?.errorText !== 'net::ERR_ABORTED') problems.push(\`request failed: \${r.method()} \${r.url()} (\${r.failure()?.errorText})\`); });
    await use();
    const serious = (await new AxeBuilder({ page }).analyze()).violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
    for (const v of serious) problems.push(\`accessibility (\${v.impact}): \${v.id}, \${v.nodes.length} element(s)\`);
    expect(problems, 'the page must run clean').toEqual([]);
  }, { auto: true }],
});

export { expect };
`;
  }

  // ---------- holdout and UI (D5) ----------
  // The sha256 of one acceptance case: its canonical JSON (keys sorted), so ui.json and the Factory name the same case by the
  // same value whatever order the YAML wrote the keys in.
  const holdoutCaseHash = c => UI.sha256(UI.canon(c));
  // The spec text for one holdout case, built by the same code acceptanceSpecs uses. The Factory asks for it when it judges the
  // holdout; it is never put in a handover. Throws when the criterion or case is missing, or the case is not a holdout.
  function holdoutSpec({ model, criteria = [], criterion, index }) {
    const a = criteria.find(x => x && String(x.id) === String(criterion));
    if (!a) throw new Error(`no acceptance criterion ${criterion}`);
    const c = Array.isArray(a.cases) && Number.isInteger(index) ? a.cases[index] : undefined;
    if (!c) throw new Error(`criterion ${criterion} has no case ${index}`);
    if (!isHoldout(c)) throw new Error(`criterion ${criterion} case ${index} is not a holdout case: it is in the handover already`);
    const el = resolveElement(model, a.element);
    if (!el) throw new Error(`criterion ${criterion} names ${a.element}, which is not an element of the model`);
    const label = model.label(el.id);
    return { spec: specFile(a, label, [caseTest(a, c, 1)], false), sha256: holdoutCaseHash(c), state: c.state, element: label };
  }
  // The acceptance copies a handover carries. A criterion with a holdout case is written again without it (a comment line says
  // so, so it is no longer the verbatim file); every other criterion stays verbatim. `files` are {path, text}; `criteria` are the
  // parsed files (with _path). Also returns the holdout cases: {criterion, index, state, sha256, element}, by criterion then case.
  function acceptanceCopies(files, criteria, dump) {
    const holdouts = [], byPath = new Map((criteria || []).filter(a => a && a._path).map(a => [a._path, a]));
    const out = files.map(f => {
      const a = byPath.get(f.path);
      if (!a || !Array.isArray(a.cases) || !a.cases.some(isHoldout)) return f;
      if (typeof dump !== 'function') throw new Error(`handover refused: ${f.path} has holdout cases and no YAML writer was given to leave them out`);
      a.cases.forEach((c, i) => { if (isHoldout(c)) holdouts.push({ criterion: String(a.id), index: i, state: c.state, sha256: holdoutCaseHash(c), element: a.element }); });
      const doc = {}; for (const [k, v] of Object.entries(a)) if (!k.startsWith('_')) doc[k] = v;
      doc.cases = a.cases.filter(c => !isHoldout(c));
      return { path: f.path, text: `# designc: cases marked holdout are not in this copy; it is not the registry file verbatim.\n${dump(doc)}` };
    });
    return { files: out, holdouts: holdouts.sort((x, y) => (x.criterion < y.criterion ? -1 : x.criterion > y.criterion ? 1 : x.index - y.index)) };
  }
  // The UI half of a handover. Screens are the specs joined (by component name) to the in-scope UI-tagged elements, or to every UI
  // element for a whole freeze. A spec that is not bound, or has no approved previews, refuses the freeze (the gate says so first).
  // `ui`: {specs: [{path, text}], pack: {components, templates}, pin: {name, hash} | null, previews: [{screen, approved_ts, files}],
  // holdouts: {screen: sha256 of ui/holdout/<screen>.json}}. `holdoutCases` come from acceptanceCopies. Returns the text copies
  // (inside the id), ui.json (derived), the preview entries for the id and the binary copies, or null when no screen is in scope.
  function handoverUi({ model, ui, inScope = null, holdoutCases = [] }) {
    if (!ui) return null;
    const uiNames = new Set([...model.elements.values()].filter(e => e.tags.has('UI') && (!inScope || inScope.includes(e.name))).map(e => e.name));
    const pack = UI.readPack(ui.pack || { components: [], templates: [] }, null);
    const screens = [], copies = [], seen = new Set();
    const add = f => { if (!seen.has(f.path)) { seen.add(f.path); copies.push({ path: f.path, text: f.text }); } };
    for (const f of [...(ui.specs || [])].sort((x, y) => (x.path < y.path ? -1 : 1))) {
      let spec; try { spec = JSON.parse(f.text); } catch { throw new Error(`handover refused: ${f.path} does not parse as JSON`); }
      if (!spec || typeof spec !== 'object' || !uiNames.has(spec.component)) continue;
      const screen = spec.screen;
      if (spec.status !== 'bound') throw new Error(`handover refused: screen ${screen} is not bound (${f.path})`);
      const prev = (ui.previews || []).find(p => p.screen === screen);
      if (!prev || !prev.files || !Object.keys(prev.files).length) throw new Error(`handover refused: screen ${screen} has no approved previews`);
      const tpl = pack.templates.get(spec.template);
      if (!tpl) throw new Error(`handover refused: screen ${screen} uses template ${spec.template}, which is not in ui/pack/templates/`);
      const names = [...new Set(Object.values(spec.slots && typeof spec.slots === 'object' ? spec.slots : {}).flatMap(list => (Array.isArray(list) ? list : []).map(x => x && x.component).filter(Boolean)))].sort();
      const comps = names.map(n => {
        const c = pack.components.get(n);
        if (!c) throw new Error(`handover refused: screen ${screen} places ${n}, which is not in ui/pack/components/`);
        return { name: n, path: c.file, text: (ui.pack.components.find(x => x.path === c.file) || {}).text };
      });
      const tplText = ui.pack.templates.find(x => x.path === tpl.file).text;
      add(f); add({ path: tpl.file, text: tplText }); comps.forEach(add);
      const hold = ui.holdouts && ui.holdouts[screen];
      screens.push({
        screen,
        spec: { path: f.path, sha256: UI.sha256(f.text) },
        template: { path: tpl.file, sha256: UI.sha256(tplText) },
        components: comps.map(c => ({ name: c.name, path: c.path, sha256: UI.sha256(c.text) })),
        previews: { approved_ts: prev.approved_ts == null ? null : prev.approved_ts, files: Object.fromEntries(Object.keys(prev.files).sort().map(k => [k, prev.files[k]])) },
        holdout: hold ? { path: `ui/holdout/${screen}.json`, sha256: hold } : null,
        holdout_cases: holdoutCases.filter(h => h.element != null && resolveElementName(model, h.element) === spec.component).map(h => ({ criterion: h.criterion, case: h.index, state: h.state, sha256: h.sha256 })),
        _hold: hold || null,
        _component: spec.component,
      });
    }
    if (!screens.length) return null;
    const idEntries = [];
    for (const s of screens) {
      for (const [rel, h] of Object.entries(s.previews.files)) idEntries.push(`preview\0${s.screen}/${rel}\0${h}`);
      if (s._hold) idEntries.push(`holdout\0${s.screen}\0${s._hold}`);
      for (const h of s.holdout_cases) idEntries.push(`holdout_case\0${h.criterion}\0${h.case}\0${h.sha256}`);
    }
    const components = screens.map(s => ({ screen: s.screen, component: s._component }));
    screens.forEach(s => { delete s._hold; delete s._component; });
    const doc = { schema: 'designc.handover.ui/1', pack: ui.pin ? { name: ui.pin.name, hash: ui.pin.hash } : null, screens };
    const binary = screens.flatMap(s => Object.entries(s.previews.files).map(([rel, sha256]) => ({ from: `ui/previews/${s.screen}/${rel}`, rel: `ui/previews/${s.screen}/${rel}`, sha256 })));
    return { copies, json: { path: 'ui.json', text: JSON.stringify(doc, null, 2) + '\n' }, idEntries, binary, screens: screens.map(s => s.screen), components };
  }
  const resolveElementName = (model, ref) => { const el = resolveElement(model, ref); return el ? el.name : null; };

  // BUILD.md: the brief any coding agent reads to build from a handover, whichever pipeline (or none) picks it up.
  // Derived from what the handover holds, so it points at the copied files rather than restating them. It names no
  // pipeline, no time and no person, so the same content always gives the same text.
  // focus: the element names the requirements and bound decisions name (a whole handover only); they become "Build these"
  // and every other code area is context the agent may write only when the change needs it.
  function buildBrief({ id, elements, item, focus, requirements, decisions, scenarios, evals, acceptance, tokens, specs, domain = null, references = [], ui = null, tests = null, scenarioTests = null }) {
    const code = s => '`' + s + '`';
    const list = (xs, f = code) => xs.map(x => `- ${f(x)}`).join('\n');
    const coded = e => e.code && e.code.length;
    const wanted = new Set(item ? [] : (focus || []));
    const focused = elements.elements.filter(e => wanted.has(e.name));
    const targets = item ? elements.elements.filter(e => coded(e) && e.in_scope) : elements.elements.filter(coded);
    const line = e => `- ${code(e.id)} (${e.kind}${e.risk ? `, risk ${e.risk}` : ''}): ${coded(e) ? e.code.map(code).join(', ') : 'no code area, so ask the designer where it lives before writing'}`;
    const out = [`# Build brief: ${id}`, '',
      'Generated by designc when this handover was frozen. Do not edit it, or anything else in this folder: a frozen handover never changes.',
      'This folder is the specification. Build from these copies, not from the registry\'s live files, which may have moved on.', '',
      '## What to build', ''];
    const itemReqs = item ? [].concat(item.requirement) : [];
    if (item) out.push(`Work item ${code(item.id)}, ${itemReqs.length === 1 ? 'requirement' : 'requirements'} ${itemReqs.map(code).join(', ')}. Only the elements in scope below; the rest of the model is context.`, '');
    else if (requirements.length) out.push(`Requirements: ${requirements.map(code).join(', ')} (copies under ${code('requirements/')}).`, '');
    if (focused.length) {
      const context = targets.filter(e => !focused.includes(e));
      out.push('### Build these', '', 'The elements the requirements and decisions name.', '', ...focused.map(line));
      if (context.length) out.push('', '### Context', '', 'You may write these code areas only where the change above needs it.', '', ...context.map(line));
    } else if (targets.length) out.push(item ? 'Build these:' : 'Code areas you may write:', '', ...targets.map(line));
    else out.push('No element declares a code area (`d.code`), so there is no safe place to write. Stop and ask the designer where this code lives.');
    if (tests && tests.unmapped.length) out.push('', `No existing test covers: ${tests.unmapped.map(u => u.element).join(', ')}; the tests you write are its only cover. ${code('tests.json')} lists, per element, the tests to turn green and the existing ones that must stay green.`);
    else if (tests) out.push('', `${code('tests.json')} lists, per element, the tests to turn green and the existing ones that must stay green.`);
    out.push('', `${code('elements.json')} resolves every element, its code area and relationships by id; ${code('model/')} holds the design itself.`, '',
      '## Rules', '',
      '1. Write only inside the code areas listed above. Each file belongs to one element.',
      `2. Never write ${(elements.reserved || ['tests/acceptance/**']).map(code).join(', ')}: designc generates those specs and they are how the work is judged.`,
      '3. Do not change the design. If it is wrong or incomplete, stop and say what you need decided; a design change is a new handover.',
      '4. Honour every decision below. Its checks are commands run from the registry folder.');
    let n = 4;
    if (domain) out.push(`${++n}. ${code('domain.json')} says which element owns which aggregate; ${code('domain/')} holds the team's domain model. Honour its aggregates, invariants and event payloads, and do not edit it.`);
    if (references.length) out.push(`${++n}. Read-only references: ${references.map(r => `${code(r.key)} (${r.kind})`).join(', ')}. Whoever started this build gives you where each one lives. Read them to learn what correct behaviour is; never write them, and do not copy their code into the areas above where the requirements say otherwise.`);
    if (ui) out.push(`${++n}. ${code('ui.json')} lists the screens, each with its spec under ${code('ui/specs/')} and the approved previews under ${code('ui/previews/')}. Build each screen from its spec: one library component per placement, ${code('data-ui-id')} first, no inline styles or raw values. Do not edit the spec, the pack files or the previews.`);
    if (scenarioTests && scenarioTests.copies.length) out.push(`${++n}. ${code('scenarios.json')} lists the scenario tests designc generated from the bound test scenarios. Never edit ${code('ui-contract/tests/*.scenarios.page.test.tsx')}: they are how the screen's requests are judged.`);
    out.push('');
    if (decisions.length) out.push('## Decisions', '', list(decisions.map(f => f.path)), '');
    out.push('## Done means', '');
    const done = [];
    if (specs.files.length) done.push(`These acceptance specs pass:\n${list(specs.files.map(f => f.path)).replace(/^/gm, '  ')}`);
    if (specs.loop && specs.loop.length) done.push(`While building, run these (in scope plus what depends on it):\n${list(specs.loop).replace(/^/gm, '  ')}`);
    if (decisions.length) done.push('Every check of every decision above passes.');
    if (scenarios.length) done.push(`The fitness functions of ${scenarios.map(f => code(f.path)).join(', ')} pass.`);
    if (evals.length) done.push(`The evals in ${evals.map(f => code(f.path)).join(', ')} meet their thresholds.`);
    if (acceptance.length) done.push(`The acceptance criteria in ${code('acceptance/')} hold for every state they list.`);
    if (ui) done.push(`The ${code('ui:')} check passes for each screen (${ui.screens.join(', ')}) against the approved previews.`);
    if (tokens) done.push(`UI uses the design tokens in ${code(tokens.path)}.`);
    done.push('The change is merged to main. designc judges done from git and the checks, not from a report that the work is finished.');
    out.push(done.map(d => `- ${d}`).join('\n'), '',
      '## Reporting back (optional)', '',
      'If your pipeline can append to the registry ledger, follow designc\'s pipeline contract (docs/pipeline-contract.md in the designc repository) and name elements by their elements.json id. Nothing is required: without it designc still judges the result from git.', '');
    return out.join('\n');
  }

  // A frozen handover is a folder: handovers/<yyyymmdd>-<hash8>/ holding handover.yaml and verbatim copies
  // of the model, requirements, bound decisions, evals, scenarios, behaviour (.p) and vocabulary it was frozen from. The
  // hash part comes from the copied content only, so identical content gives an identical id on any day.
  // elements.json (handoverElements) is derived from that content: listed and hashed, but not in the id.
  // Pure: the caller reads the files and writes the result.
  // The packs a handover carries: those that define an aggregate owned by a touched element (an item's scope, the
  // focus, or every owner when there is no focus). Copies sit inside the id hash; domain.json is derived and outside it.
  // owners[].element is the elements.json id. null when no touched element owns anything a pack defines.
  function handoverDomain(modelText, packs, { item, focus }, elementsDoc) {
    if (!packs || !packs.length) return null;
    const m = parse(modelText), read_ = packs.map(p => DM.read(p.text, p.load || undefined, p.key)).filter(r => r.pack).map(r => r.pack);
    const wanted = item ? new Set(item.elements || []) : (focus && focus.length ? new Set(focus) : null);
    const ids = new Map(elementsDoc.elements.map(e => [e.name, e.id]));
    const owners = [], keys = new Set();
    for (const o of domainOwners(m)) {
      if (wanted && !wanted.has(o.name)) continue;
      const owns = [];
      for (const entry of o.owns) { const q = DM.qualify(entry, read_); if (!q.error) { owns.push(q.id); keys.add(q.id.split('/')[0]); } }
      if (owns.length && ids.has(o.name)) owners.push({ element: ids.get(o.name), owns });
    }
    const used = packs.filter(p => keys.has(p.key)).sort((a, b) => (a.key < b.key ? -1 : 1));
    if (!used.length) return null;
    const copies = used.map(p => ({ path: `domain/${p.key}.yaml`, text: p.text }));
    owners.sort((a, b) => (a.element < b.element ? -1 : 1));
    const doc = { schema: 'designc.handover.domain/1', packs: copies.map((c, i) => ({ key: used[i].key, path: c.path, hash: hash16(c.text) })), owners };
    return { copies, json: { path: 'domain.json', text: JSON.stringify(doc, null, 2) + '\n' } };
  }
  // The risk and data class the frozen requirements declare (jira-mapping.yaml writes them into the requirement file), so S2's
  // router can prefer them over its own guess. Highest risk wins, first data class wins; unknown risk values are dropped.
  const RISK_ORDER = ['low', 'medium', 'high', 'critical'];
  function requirementProfile(requirements) {
    const field = (f, key) => { const m = new RegExp(`^${key}:\\s*["']?([^"'\\n#]+?)["']?\\s*(#.*)?$`, 'm').exec(f.text); return m ? m[1].trim().toLowerCase() : null; };
    let risk = null, dataClass = null;
    for (const f of requirements) {
      const r = field(f, 'risk');
      if (RISK_ORDER.includes(r) && (risk == null || RISK_ORDER.indexOf(r) > RISK_ORDER.indexOf(risk))) risk = r;
      const d = field(f, 'data_class');
      if (d && dataClass == null) dataClass = d;
    }
    return { risk, dataClass };
  }


  // B3: the generated scenario tests (docs/handover-scenarios.schema.json, designc.handover.scenarios/1). Each bound structured test
  // scenario of a requirement in the handover, with an operation and examples, on a screen the handover's UI part carries, compiles
  // (TestScenarios.compile) to request tests in ui-contract/tests/<screen>.scenarios.page.test.tsx. Anything else is listed in `skipped`
  // with its reason. A scenario that cannot compile is a refusal. Files are verbatim copies (inside the id); scenarios.json is derived.
  // Pure. files: [{path, text}] of test-scenarios/*.yaml; null when there is nothing to say.
  function handoverScenarioTests({ files, requirementIds, uiPart, specs, apiContracts }) {
    const TS = typeof TestScenarios !== 'undefined' ? TestScenarios : require('./test-scenarios.js');
    const Rec = typeof Records !== 'undefined' ? Records : require('./records.js');
    const yamlLoad = typeof jsyaml !== 'undefined' ? jsyaml.load : require('js-yaml').load;
    const ops = { files: Object.fromEntries((apiContracts || []).map(f => [f.path, f.text])), yamlLoad };
    const serverOf = file => { try { const d = yamlLoad(ops.files[file]); const s = d && Array.isArray(d.servers) && d.servers[0]; return s && typeof s.url === 'string' ? s.url : undefined; } catch { return undefined; } };
    const operations = id => { const o = Core.resolveOperation(ops, id); return o ? { method: o.method, path: o.path, server: serverOf(o.file) } : null; };
    const uiScreens = new Set(uiPart ? uiPart.screens : []);
    const byScreen = new Map(), skipped = [];
    for (const f of [...(files || [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      let rec; try { rec = yamlLoad(f.text); } catch { throw new Error(`handover refused: ${f.path} does not parse as YAML`); }
      if (!rec || typeof rec !== 'object' || !Rec.isStructuredScenario(rec) || !requirementIds.includes(String(rec.requirement))) continue;
      const skip = reason => skipped.push({ scenario: rec.id, reason });
      if (rec.status !== 'bound') { skip(`${rec.status === 'minted' ? 'minted' : 'not bound'}: a person binds it before a test is generated`); continue; }
      if (!rec.effect || typeof rec.effect.operation !== 'string') { skip('no operation: effect.operation names the request the test waits for'); continue; }
      if (!Array.isArray(rec.examples) || !rec.examples.length) { skip('no examples: a test needs at least one'); continue; }
      const screen = TS.renderScreen(rec, specs);
      if (screen == null) { skip(`no ui spec for ${rec.screen}`); continue; }
      if (!uiScreens.has(screen)) { skip(`screen ${screen} is not among the handover's UI screens`); continue; }
      const c = TS.compile({ scenario: rec, specs, operations, path: f.path });
      if (!byScreen.has(screen)) byScreen.set(screen, []);
      byScreen.get(screen).push({ ...c, sha256: UI.sha256(f.text), operation: { id: rec.effect.operation, ...(({ method, path }) => ({ method, path }))(operations(rec.effect.operation)) }, examples: rec.examples.map((e, i) => ({ index: i + 1, title: e && typeof e.title === 'string' ? e.title : `example ${i + 1}` })) });
    }
    if (!byScreen.size && !skipped.length) return null;
    const copies = [], docScreens = [], idEntries = [];
    for (const screen of [...byScreen.keys()].sort()) {
      const list = byScreen.get(screen).sort((a, b) => (a.id < b.id ? -1 : 1));
      const test = { path: `ui-contract/tests/${screen}.scenarios.page.test.tsx`, text: TS.testFile(screen, list) };
      copies.push(test);
      docScreens.push({ screen, component: list[0].component, test: { path: test.path, sha256: UI.sha256(test.text) },
        scenarios: list.map(c => ({ id: c.id, path: c.path, sha256: c.sha256, operation: c.operation, examples: c.examples })) });
      for (const c of list) idEntries.push(`scenario_test\0${c.path}\0${c.sha256}`);
    }
    skipped.sort((a, b) => (a.scenario < b.scenario ? -1 : a.scenario > b.scenario ? 1 : 0));
    const doc = { schema: 'designc.handover.scenarios/1', screens: docScreens, skipped };
    return { copies, json: { path: 'scenarios.json', text: JSON.stringify(doc, null, 2) + '\n' }, idEntries, paths: copies.map(c => c.path) };
  }

  function handoverPlan({ date, now, by, model, requirements = [], decisions = [], behaviour = [], vocabulary = [], evals = [], scenarios = [], acceptance: acceptanceIn = [], tokens = null, specs = { files: [], loop: null }, forecast = null, item = null, focus = [], domain = [], references = [], contracts = null, apiContracts: apiIn = [], ui: uiIn = null, criteria = null, yamlDump = null, facts = null, testScenarios = [] }) {
    const apiContracts = apiIn || [];
    let acceptance = acceptanceIn;
    // A reference is a name and a kind, never a path: paths are machine-local, and they must not change the id of a handover.
    const refs = references.map(r => ({ key: r.key, kind: r.kind })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const elementsDoc = handoverElements(model.text, behaviour, item ? item.elements : null, { apiContracts: apiIn || [], packs: domain || [] });
    // Holdout cases leave the acceptance copies here, so no caller can ship one by mistake (D5).
    const acc = acceptanceCopies(acceptance, criteria, yamlDump);
    acceptance = acc.files;
    const uiPart = handoverUi({ model: parse(model.text), ui: uiIn, inScope: item ? item.elements : null, holdoutCases: acc.holdouts });
    const scn = handoverScenarioTests({ files: testScenarios, requirementIds: requirements.map(f => { const m = /^id:\s*["']?([^"'\n#]+?)["']?\s*(#.*)?$/m.exec(f.text); return m ? m[1] : f.path.split('/').pop().replace(/\.ya?ml$/, ''); }), uiPart, specs: uiIn ? uiIn.specs : [], apiContracts: apiIn || [] });
    const dom = handoverDomain(model.text, domain, { item, focus }, elementsDoc);
    // The test map (D6) is derived from the as-built facts, which are not copied: their hash joins the id, so new facts are a new handover.
    const testsDoc = handoverTests(elementsDoc, facts, specs, uiPart ? uiPart.components : []);
    // Compiled agent contracts (Contracts.forFreeze): verbatim copies, so inside the id; a different policy is a different handover.
    const ctr = contracts ? [contracts.result, ...contracts.files] : [];
    const content = [model, ...(dom ? dom.copies : []), ...ctr, ...apiContracts, ...requirements, ...decisions, ...evals, ...scenarios, ...acceptance, ...(tokens ? [tokens] : []), ...behaviour, ...vocabulary, ...(uiPart ? uiPart.copies : []), ...(scn ? scn.copies : [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const id = `${String(date).replace(/-/g, '')}-${hash16([...content.map(f => `${f.path}\0${f.text}`), ...(item ? [`work_item\0${item.id}`] : []), ...refs.map(r => `reference\0${r.key}\0${r.kind}`), ...(uiPart ? uiPart.idEntries : []), ...(scn ? scn.idEntries : []), ...(testsDoc && testsDoc.facts ? [`tests-facts\0${testsDoc.facts.sha256}`] : [])].join('\0\0')).slice(0, 8)}`;
    const dir = `handovers/${id}/`;
    const elements = { path: 'elements.json', text: JSON.stringify(elementsDoc, null, 2) + '\n' };
    const idOf = f => { const m = /^id:\s*["']?([^"'\n#]+?)["']?\s*(#.*)?$/m.exec(f.text); return m ? m[1] : f.path.split('/').pop().replace(/\.ya?ml$/, ''); };
    const reqProfile = requirementProfile(requirements);
    const agentsDoc = handoverAgents(model.text);
    const agents = agentsDoc.agents.length ? { path: 'agents.json', text: JSON.stringify(agentsDoc, null, 2) + '\n' } : null;
    const build = { path: 'BUILD.md', text: buildBrief({ id, elements: JSON.parse(elements.text), item, focus, requirements: requirements.map(f => idOf(f)), decisions, scenarios, evals, acceptance, tokens, specs, domain: !!dom, references: refs, ui: uiPart, tests: testsDoc, scenarioTests: scn }) };
    const testsFile = testsDoc ? { path: 'tests.json', text: JSON.stringify(testsDoc, null, 2) + '\n' } : null;
    const frozen = [...content, elements, build, ...(testsFile ? [testsFile] : []), ...(agents ? [agents] : []), ...(dom ? [dom.json] : []), ...(uiPart ? [uiPart.json] : []), ...(scn ? [scn.json] : []), ...specs.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const q = JSON.stringify;
    const head = `id: ${id}
revision: ${modelRevision(model.text)}
created: ${q(now)}
by: ${q(by)}
model: ${q(model.path)}
elements: ${q(elements.path)}
build: ${q(build.path)}
${agents ? `agents: ${q(agents.path)}\n` : ''}${contracts ? `contracts: ${q({ result: contracts.result.path, agents: contracts.agents, uncontracted: contracts.uncontracted, ...(contracts.compiler ? { compiler: contracts.compiler } : {}) })}\n` : ''}${apiContracts.length ? `contracts_api: ${q(apiContracts.map(f => f.path).sort())}\n` : ''}${dom ? `domain: ${q(dom.json.path)}\n` : ''}${uiPart ? `ui: ${q(uiPart.json.path)}\nui_screens: ${q(uiPart.screens)}\n` : ''}${testsFile ? `tests: ${q(testsFile.path)}\n` : ''}${scn ? `scenario_tests: ${q(scn.json.path)}\n` : ''}${item ? `work_item: ${q(item.id)}\ndesign_version: ${modelRevision(model.text)}\nin_scope: ${q(item.elements)}\n` : ''}${reqProfile.risk ? `requirement_risk: ${q(reqProfile.risk)}\n` : ''}${reqProfile.dataClass ? `requirement_data_class: ${q(reqProfile.dataClass)}\n` : ''}requirements: ${q(requirements.map(idOf))}
decisions: ${q(decisions.map(idOf))}
evals: ${q(Object.fromEntries(evals.map(f => [idOf(f), evalHash({ _text: f.text })])))}
scenarios: ${q(scenarios.map(idOf))}
${acceptance.length ? `acceptance: ${q(acceptance.map(idOf))}\n` : ''}${tokens ? `tokens: ${q(tokens.path)}\n` : ''}${refs.length ? `references: ${q(refs)}\n` : ''}${specs.files.length ? `specs: ${q(specs.files.map(f => f.path))}\n${specs.loop ? `loop_specs: ${q(specs.loop)}\n` : ''}` : ''}${forecast ? `forecast: ${q(forecast)}\n` : ''}files:
${frozen.map(f => `  - { path: ${q(f.path)}, hash: ${hash16(f.text)} }`).join('\n')}
`;
    return { id, files: [{ path: dir + 'handover.yaml', text: head }, ...frozen.map(f => ({ path: dir + f.path, text: f.text }))], binaryCopies: uiPart ? uiPart.binary.map(b => ({ from: b.from, to: dir + b.rel, sha256: b.sha256 })) : [], testsUnmapped: testsDoc ? testsDoc.unmapped : [] };
  }

  // The test map (D6, designc.handover.tests/1, docs/handover-tests.schema.json): for each element with a code area, the tests that
  // must turn green (fail_to_pass: its generated acceptance specs, and the page test of a screen it is the component of) and the
  // existing tests that must stay green (pass_to_pass: found statically in the as-built facts). designc does not know tasks: this is
  // keyed per element and the Factory maps a task to its tests through the task's elements. An element with code and no mapped
  // existing test is listed in `unmapped`: coverage information, never a gate clause. Pure.
  //  elementsDoc: handoverElements(...); facts: {text} (asbuilt/facts.json as read) or null; specs: acceptanceSpecs(...);
  //  ui: [{screen, component}] (component is an element name). Returns null when no element has a code area.
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
  function handoverTests(elementsDoc, facts, specs, ui = []) {
    const coded = elementsDoc.elements.filter(e => e.code && e.code.length && (e.in_scope === undefined || e.in_scope));
    if (!coded.length) return null;
    let doc = null;
    if (facts) { try { doc = JSON.parse(facts.text); } catch { throw new Error('handover refused: asbuilt/facts.json does not parse as JSON'); } }
    const tests = doc && Array.isArray(doc.tests) ? doc.tests : [];
    // Split repos: an entry names its repo and its paths carry the key as a prefix; d.code is relative to the repo.
    const local = (t, p) => (t.repo && p.startsWith(t.repo + '/') ? p.slice(t.repo.length + 1) : p);
    const dirOf = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
    const quote = p => (/^[\w./-]+$/.test(p) ? p : JSON.stringify(p));
    const out = [], unmapped = [];
    for (const e of coded) {
      const hit = (p, dir) => e.code.some(c => PP.matches(c, p) || (dir && PP.matches(c, dirOf(p))));
      const p2p = new Map();
      const add = (t, command, via) => { const k = `${t.kind}\0${t.path}`; if (!p2p.has(k)) p2p.set(k, { kind: t.kind, path: t.path, command, via }); };
      for (const t of tests) {
        if (e.repo && t.repo && e.repo !== t.repo) continue;
        if (t.kind === 'dotnet') {
          if ((t.refs || []).some(r => hit(local(t, r), true))) add(t, `dotnet test ${quote(t.path)}`, 'project-ref');
        } else {
          const via = hit(local(t, t.path), false) ? 'co-located' : (t.imports || []).some(i => hit(local(t, i), false)) ? 'import' : null;
          if (via) add(t, t.kind === 'vitest' ? `npx vitest run ${quote(t.path)}` : t.kind === 'jest' ? `npx jest ${quote(t.path)}` : null, via);
        }
      }
      const f2p = [];
      const prefix = `tests/acceptance/${aSlug(e.id)}/`;
      for (const f of specs && specs.files ? specs.files : []) if (f.path.startsWith(prefix)) f2p.push({ kind: 'acceptance', path: f.path, command: `npx playwright test ${quote(f.path)}` });
      for (const u of ui || []) if (u.component === e.name) { const p = `ui-contract/tests/${u.screen}.page.test.tsx`; f2p.push({ kind: 'ui-page', path: p, command: `npx vitest run --project ui-page ${quote(p)}` }); }
      const row = { element: e.id };
      if (e.repo) row.repo = e.repo;
      out.push({ ...row, fail_to_pass: f2p.sort(byPath), pass_to_pass: [...p2p.values()].sort(byPath) });
      if (!p2p.size) unmapped.push({ element: e.id, reason: doc ? 'no existing test references its code' : 'no as-built facts: run Extract' });
    }
    return { schema: 'designc.handover.tests/1', facts: doc ? { path: 'asbuilt/facts.json', sha256: UI.sha256(facts.text), extracted_at: doc.extractedAt == null ? null : doc.extractedAt } : null, elements: out, unmapped };
  }

  // A frozen handover never changes. Freezing again is refused when its folder already exists (same id), or when
  // the content hash equals the newest handover's (nothing changed since it). Returns that handover's id, else null.
  function frozenAs(id, handovers) {
    const hashOf = x => String(x).split('-').pop();
    if (handovers.some(h => h && h.id === id)) return id;
    const last = [...handovers].reverse().find(h => h && h.id);
    return last && hashOf(last.id) === hashOf(id) ? last.id : null;
  }

  // Decisions the gate blocks on promotion (no fingerprint, or what they bind changed): a human can re-bind them.
  function rebindable(g) {
    const ids = [];
    for (const c of (g && g.clauses) || []) if (c.kind === 'promotion' && c.decision && !ids.includes(c.decision)) ids.push(c.decision);
    return ids;
  }

  // The model copy inside the newest handover that names one. `handovers` is ordered oldest first.
  function latestHandoverModel(handovers) {
    const h = [...handovers].reverse().find(x => x && x.id && x.model);
    return h ? { id: h.id, path: `handovers/${h.id}/${h.model}` } : null;
  }


  Object.assign(Core, { holdoutCaseHash, holdoutSpec, acceptanceCopies, handoverUi, handoverElements, handoverAgents, acceptanceSpecs, buildBrief, handoverDomain, handoverTests, handoverScenarioTests, handoverPlan, frozenAs, rebindable, latestHandoverModel });
})(typeof module === 'object' && typeof require === 'function' ? require('./core.js') : Core);
