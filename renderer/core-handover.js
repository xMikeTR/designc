// ===== designc core: handover =====
// Part of Core, split out of core.js with no behaviour change. Dual-loaded like core.js: a classic script in the
// renderer (after core.js) and required by core.js under Node. It reads what it needs from Core and adds its functions to it.
(Core => {
  const { parse, check, gate, domainOwners, blastRadius, evalHash, fingerprint, modelRevision, resolveElement } = Core;
  const { hash16, RESERVED_TEST_PATH, DM, PP, get, structural } = Core._shared;
  // ---------- handover ----------
  // The model resolved for whatever coding agent takes the handover (docs/handover-elements.schema.json), so
  // none of them has to parse the DSL: every element under its hierarchical id (System/Container/Component),
  // d.code as normalised path patterns and d.risk where declared, relationships by id (one per pair), and the
  // events behaviour announces. A model that does not parse, or a code area that is not a pattern, is refused.
  function handoverElements(modelText, behaviour = [], inScope = null) {
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
      if (inScope) out.in_scope = inScope.includes(e.name);
      return out;
    });
    const pairs = new Map();
    for (const r of m.rels) { const from = m.label(r.src), to = m.label(r.dst); pairs.set(`${from}\0${to}`, { from, to }); }
    const events = [...new Set([...behaviour].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .flatMap(f => [...f.text.matchAll(/\bannounce\s+(\w+)/g)].map(x => x[1])))];
    return inScope
      ? { schema: 'designc.handover.elements/2', elements, relationships: [...pairs.values()], events, reserved: [RESERVED_TEST_PATH] }
      : { schema: 'designc.handover.elements/1', elements, relationships: [...pairs.values()], events };
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
  function acceptanceSpecs({ model, criteria = [], inScope = null }) {
    const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'element';
    const line = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const q = JSON.stringify;
    const files = [], byEl = new Map();
    for (const a of criteria) {
      if (!a || !a.id || !Array.isArray(a.cases)) continue;
      const el = resolveElement(model, a.element);
      if (!el) continue;
      const locs = a.locators && typeof a.locators === 'object' ? a.locators : {};
      const loc = n => { const l = locs[n]; return l && l.role === 'label' ? `page.getByLabel(${q(String(l.name))})` : `page.getByRole(${q(String(l && l.role))}, { name: ${q(String(l && l.name))} })`; };
      const seen = new Map();
      const tests = a.cases.filter(c => c && c.state).map(c => {
        const n = (seen.get(c.state) || 0) + 1; seen.set(c.state, n);
        const uses = (Array.isArray(c.uses) ? c.uses : []).filter(u => Object.prototype.hasOwnProperty.call(locs, u));
        return `  test(${q(n === 1 ? c.state : `${c.state} (${n})`)}, async ({ page }) => {
    // given: ${line(c.given)}
${c.when ? `    // when: ${line(c.when)}\n` : ''}    // then: ${line(c.then)}
${uses.map(u => `    await expect(${loc(u)}).toBeVisible();`).join('\n')}${uses.length ? '\n' : ''}  });`;
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
      const text = `// GENERATED by designc from ${a._path || `acceptance/${a.id}.yaml`} (hash ${hash16(a._text || JSON.stringify(a))}). Do not edit: change the criterion and freeze again.
import { test, expect } from '@playwright/test';
${a.ux ? "import AxeBuilder from '@axe-core/playwright';\n" : ''}
test.describe(${q(`${a.id} ${label}`)}, () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(process.env.DESIGNC_BASE_URL ?? '/');
  });

${tests.join('\n\n')}
});
`;
      files.push({ path, text });
      if (!byEl.has(el.id)) byEl.set(el.id, []);
      byEl.get(el.id).push(path);
    }
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

  // BUILD.md: the brief any coding agent reads to build from a handover, whichever pipeline (or none) picks it up.
  // Derived from what the handover holds, so it points at the copied files rather than restating them. It names no
  // pipeline, no time and no person, so the same content always gives the same text.
  // focus: the element names the requirements and bound decisions name (a whole handover only); they become "Build these"
  // and every other code area is context the agent may write only when the change needs it.
  function buildBrief({ id, elements, item, focus, requirements, decisions, scenarios, evals, acceptance, tokens, specs, domain = null, references = [] }) {
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
    if (item) out.push(`Work item ${code(item.id)}, requirement ${code(item.requirement)}. Only the elements in scope below; the rest of the model is context.`, '');
    else if (requirements.length) out.push(`Requirements: ${requirements.map(code).join(', ')} (copies under ${code('requirements/')}).`, '');
    if (focused.length) {
      const context = targets.filter(e => !focused.includes(e));
      out.push('### Build these', '', 'The elements the requirements and decisions name.', '', ...focused.map(line));
      if (context.length) out.push('', '### Context', '', 'You may write these code areas only where the change above needs it.', '', ...context.map(line));
    } else if (targets.length) out.push(item ? 'Build these:' : 'Code areas you may write:', '', ...targets.map(line));
    else out.push('No element declares a code area (`d.code`), so there is no safe place to write. Stop and ask the designer where this code lives.');
    out.push('', `${code('elements.json')} resolves every element, its code area and relationships by id; ${code('model/')} holds the design itself.`, '',
      '## Rules', '',
      '1. Write only inside the code areas listed above. Each file belongs to one element.',
      `2. Never write ${(elements.reserved || ['tests/acceptance/**']).map(code).join(', ')}: designc generates those specs and they are how the work is judged.`,
      '3. Do not change the design. If it is wrong or incomplete, stop and say what you need decided; a design change is a new handover.',
      '4. Honour every decision below. Its checks are commands run from the registry folder.');
    let n = 4;
    if (domain) out.push(`${++n}. ${code('domain.json')} says which element owns which aggregate; ${code('domain/')} holds the team's domain model. Honour its aggregates, invariants and event payloads, and do not edit it.`);
    if (references.length) out.push(`${++n}. Read-only references: ${references.map(r => `${code(r.key)} (${r.kind})`).join(', ')}. Whoever started this build gives you where each one lives. Read them to learn what correct behaviour is; never write them, and do not copy their code into the areas above where the requirements say otherwise.`);
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
  function handoverPlan({ date, now, by, model, requirements = [], decisions = [], behaviour = [], vocabulary = [], evals = [], scenarios = [], acceptance = [], tokens = null, specs = { files: [], loop: null }, forecast = null, item = null, focus = [], domain = [], references = [], contracts = null }) {
    // A reference is a name and a kind, never a path: paths are machine-local, and they must not change the id of a handover.
    const refs = references.map(r => ({ key: r.key, kind: r.kind })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const elementsDoc = handoverElements(model.text, behaviour, item ? item.elements : null);
    const dom = handoverDomain(model.text, domain, { item, focus }, elementsDoc);
    // Compiled agent contracts (Contracts.forFreeze): verbatim copies, so inside the id; a different policy is a different handover.
    const ctr = contracts ? [contracts.result, ...contracts.files] : [];
    const content = [model, ...(dom ? dom.copies : []), ...ctr, ...requirements, ...decisions, ...evals, ...scenarios, ...acceptance, ...(tokens ? [tokens] : []), ...behaviour, ...vocabulary].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const id = `${String(date).replace(/-/g, '')}-${hash16([...content.map(f => `${f.path}\0${f.text}`), ...(item ? [`work_item\0${item.id}`] : []), ...refs.map(r => `reference\0${r.key}\0${r.kind}`)].join('\0\0')).slice(0, 8)}`;
    const dir = `handovers/${id}/`;
    const elements = { path: 'elements.json', text: JSON.stringify(elementsDoc, null, 2) + '\n' };
    const idOf = f => { const m = /^id:\s*["']?([^"'\n#]+?)["']?\s*(#.*)?$/m.exec(f.text); return m ? m[1] : f.path.split('/').pop().replace(/\.ya?ml$/, ''); };
    const agentsDoc = handoverAgents(model.text);
    const agents = agentsDoc.agents.length ? { path: 'agents.json', text: JSON.stringify(agentsDoc, null, 2) + '\n' } : null;
    const build = { path: 'BUILD.md', text: buildBrief({ id, elements: JSON.parse(elements.text), item, focus, requirements: requirements.map(f => idOf(f)), decisions, scenarios, evals, acceptance, tokens, specs, domain: !!dom, references: refs }) };
    const frozen = [...content, elements, build, ...(agents ? [agents] : []), ...(dom ? [dom.json] : []), ...specs.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const q = JSON.stringify;
    const head = `id: ${id}
revision: ${modelRevision(model.text)}
created: ${q(now)}
by: ${q(by)}
model: ${q(model.path)}
elements: ${q(elements.path)}
build: ${q(build.path)}
${agents ? `agents: ${q(agents.path)}\n` : ''}${contracts ? `contracts: ${q({ result: contracts.result.path, agents: contracts.agents, uncontracted: contracts.uncontracted, ...(contracts.compiler ? { compiler: contracts.compiler } : {}) })}\n` : ''}${dom ? `domain: ${q(dom.json.path)}\n` : ''}${item ? `work_item: ${q(item.id)}\ndesign_version: ${modelRevision(model.text)}\nin_scope: ${q(item.elements)}\n` : ''}requirements: ${q(requirements.map(idOf))}
decisions: ${q(decisions.map(idOf))}
evals: ${q(Object.fromEntries(evals.map(f => [idOf(f), evalHash({ _text: f.text })])))}
scenarios: ${q(scenarios.map(idOf))}
${acceptance.length ? `acceptance: ${q(acceptance.map(idOf))}\n` : ''}${tokens ? `tokens: ${q(tokens.path)}\n` : ''}${refs.length ? `references: ${q(refs)}\n` : ''}${specs.files.length ? `specs: ${q(specs.files.map(f => f.path))}\n${specs.loop ? `loop_specs: ${q(specs.loop)}\n` : ''}` : ''}${forecast ? `forecast: ${q(forecast)}\n` : ''}files:
${frozen.map(f => `  - { path: ${q(f.path)}, hash: ${hash16(f.text)} }`).join('\n')}
`;
    return { id, files: [{ path: dir + 'handover.yaml', text: head }, ...frozen.map(f => ({ path: dir + f.path, text: f.text }))] };
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


  Object.assign(Core, { handoverElements, handoverAgents, acceptanceSpecs, buildBrief, handoverDomain, handoverPlan, frozenAs, rebindable, latestHandoverModel });
})(typeof module === 'object' && typeof require === 'function' ? require('./core.js') : Core);
