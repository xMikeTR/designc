/* designc desktop: test scenario checks (B1). Pure, no I/O, no dependencies. Dual-loaded like work.js:
   <script src="test-scenarios.js"> in the renderer, require('./renderer/test-scenarios.js') from tests.
   mintProblems is what the strict mint_test_scenarios tool refuses on (deterministic; the agent's judgement is not asked).
   bindProblem is what keeps a person's Bind button disabled. Neither is a gate input. */
const TestScenarios = (() => {
  const Rec = typeof Records !== 'undefined' ? Records : require('./records.js');
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const squash = s => String(s).replace(/\s+/g, ' ').trim();
  const VERBS = ['fill', 'select', 'click', 'check'];
  const verbOf = step => isObj(step) ? VERBS.find(v => isObj(step[v])) : undefined;
  const locText = l => `${l.role} "${l.name}"`;
  const same = (a, b) => isObj(a) && isObj(b) && a.role === b.role && a.name === b.name;

  // specs: [{path, text}] as A.ui.specs (ui/specs/<screen>.json), or already parsed objects with a screen. Returns the spec of a screen or null.
  function specFor(specs, screen) {
    for (const f of specs || []) {
      let s = f;
      if (f && typeof f.text === 'string') { try { s = JSON.parse(f.text); } catch { continue; } if (isObj(s) && !s.screen && f.path) s.screen = f.path.split('/').pop().replace(/\.json$/, ''); }
      if (isObj(s) && s.screen === screen) return s;
    }
    return null;
  }
  // Every locator a step may use on a screen: placement locators (every slot, subslots included) and the locators transitions fire on.
  function locators(spec) {
    const placements = [], transitions = [];
    for (const list of Object.values(isObj(spec.slots) ? spec.slots : {})) for (const p of Array.isArray(list) ? list : []) if (isObj(p) && isObj(p.locator)) placements.push(p.locator);
    for (const t of Array.isArray(spec.transitions) ? spec.transitions : []) {
      if (!isObj(t) || !isObj(t.on)) continue;
      for (const v of VERBS) if (isObj(t.on[v])) transitions.push({ verb: v, locator: t.on[v], commits: t.commits === true });
    }
    return { placements, transitions };
  }
  // B2: a screen's locator set also holds those of every overlay (a spec whose host.screen is that screen).
  function hostedSpecs(specs, screen) {
    const out = [];
    for (const f of specs || []) {
      let s = f;
      if (f && typeof f.text === 'string') { try { s = JSON.parse(f.text); } catch { continue; } if (isObj(s) && !s.screen && f.path) s.screen = f.path.split('/').pop().replace(/\.json$/, ''); }
      if (isObj(s) && isObj(s.host) && s.host.screen === screen && s.screen !== screen) out.push(s);
    }
    return out;
  }
  const locatorsWithHosted = (specs, spec) => {
    const all = [locators(spec), ...hostedSpecs(specs, spec.screen).map(locators)];
    return { placements: all.flatMap(l => l.placements), transitions: all.flatMap(l => l.transitions) };
  };
  const placeholders = v => {
    const out = [];
    const walk = x => { if (typeof x === 'string') for (const m of x.matchAll(/\{([A-Za-z_][\w-]*)\}/g)) out.push(m[1]); else if (Array.isArray(x)) x.forEach(walk); else if (isObj(x)) Object.values(x).forEach(walk); };
    walk(v); return out;
  };

  // C4: the row checks of a structured scenario's examples (given/then) against the pinned packs' aggregates (Core.packAggregates).
  // Shared by the mint refusals and the freeze. [{reason, message}]; empty when no example has rows.
  const rowsOf = ex => isObj(ex) && (ex.given != null || ex.then != null);
  function rowProblems(rec, entities) {
    const out = [];
    const add = (reason, message) => out.push({ reason, message });
    const examples = Array.isArray(rec && rec.examples) ? rec.examples : [];
    if (!Rec.isStructuredScenario(rec) || !examples.some(rowsOf)) return out;
    const Core_ = typeof Core !== 'undefined' ? Core : require('./core.js');
    if (!(entities || []).length) { add('no_domain_pack', 'examples: given/then rows name aggregates of a pinned domain pack, and none is pinned (domain/*.yaml): pin the pack that defines them first'); return out; }
    const first = examples.findIndex(rowsOf);
    examples.forEach((ex, i) => {
      if (!isObj(ex)) return;
      if (!(isObj(ex.then) && Object.keys(ex.then).length)) add('rows_incomplete', `examples[${i}]: has no then rows, but examples[${first}] does: every example of a scenario with rows says what it expects`);
      for (const sect of ['given', 'then']) {
        if (!isObj(ex[sect])) continue;
        for (const [name, rows] of Object.entries(ex[sect])) {
          const r = Core_.resolveEntity(entities, name);
          if (r.error) { add('unknown_entity', `examples[${i}].${sect}.${name}: ${r.error}`); continue; }
          const known = ['id', ...r.entity.fields.map(f => f.name)];
          (Array.isArray(rows) ? rows : []).forEach((row, j) => {
            if (!isObj(row)) return;
            for (const [f, v] of Object.entries(row)) {
              if (!known.includes(f)) add('unknown_field', `examples[${i}].${sect}.${name}[${j}].${f}: ${r.entity.name} has no field ${f} (fields: ${known.join(', ')})`);
              if (typeof v === 'string') { const w = WHOLE.exec(v); if (w) add('placeholder_in_rows', `examples[${i}].${sect}.${name}[${j}].${f}: rows are literal: write this example's value, not {${w[1]}}`); }
            }
          });
        }
      }
    });
    return out;
  }
  const WHOLE = /^\{([A-Za-z_][\w-]*)\}$/;

  // rec: a test scenario record. ctx: {pageText, specs, resolveOperation(id) -> op|null, operationErrors?: Core.operations(...).errors}.
  // Returns [{reason, message}], empty when the scenario may be minted.
  function mintProblems(rec, ctx = {}) {
    const out = [];
    const add = (reason, message) => out.push({ reason, message });
    const src = rec && typeof rec.source === 'string' ? squash(rec.source) : '';
    if (!src) add('source_not_in_page', 'source: the sentence of the requirement page this case comes from is missing');
    else if (!squash(ctx.pageText == null ? '' : ctx.pageText).includes(src)) add('source_not_in_page', `source: "${rec.source}" is not in the requirement page (it must be quoted verbatim, whitespace aside)`);
    if (!Rec.isStructuredScenario(rec)) return out;

    const spec = specFor(ctx.specs, rec.screen);
    if (!spec) add('unknown_screen', `screen: no ui spec for ${rec.screen}`);
    const loc = spec ? locatorsWithHosted(ctx.specs, spec) : null;
    const steps = Array.isArray(rec.steps) ? rec.steps : [];
    const examples = Array.isArray(rec.examples) ? rec.examples : [];
    let commits = false;
    if (loc) steps.forEach((s, i) => {
      const verb = verbOf(s); if (!verb) return;
      const l = s[verb];
      const t = loc.transitions.filter(x => same(x.locator, l));
      if (!loc.placements.some(p => same(p, l)) && !t.length) add('locator_not_in_spec', `steps[${i}]: ${verb} ${locText(l)} is not a placement locator or transition locator of the ${rec.screen} spec or of an overlay it hosts`);
      if (verb === 'click' && t.some(x => x.commits)) commits = true;
    });
    if (rec.effect && typeof rec.effect.operation === 'string') {
      const id = rec.effect.operation;
      if (!(typeof ctx.resolveOperation === 'function' && ctx.resolveOperation(id))) {
        const dup = (ctx.operationErrors || []).find(e => e.code === 'duplicate_operation' && e.operationId === id);
        add('unknown_operation', dup ? `effect.operation: operationId "${id}" is defined more than once (in ${dup.files.join(', ')}); make it unique before a scenario relies on it` : `effect.operation: operationId "${id}" is not in a pinned OpenAPI file (contracts/openapi/*.yaml)`);
      }
    }
    if (commits && !examples.length) add('commit_without_examples', `examples: a step clicks a transition that commits a change on ${rec.screen}; give at least one example`);
    const used = [...new Set([...steps.flatMap(s => placeholders(isObj(s) ? s.value : null)), ...placeholders(rec.effect && rec.effect.body)])];
    for (const name of used) examples.forEach((ex, i) => { if (!isObj(ex) || !(name in ex)) add('unfilled_placeholder', `examples[${i}]: has no value for {${name}}, which a step or effect.body uses`); });
    for (const p of rowProblems(rec, ctx.entities)) add(p.reason, p.message);
    return out;
  }

  // null when a person may bind the record, else the one sentence the Bind button shows.
  function bindProblem(rec) {
    const qs = rec && Array.isArray(rec.questions) ? rec.questions.filter(q => typeof q === 'string' && q.trim()) : [];
    if (qs.length) return `${qs.length} open question${qs.length === 1 ? '' : 's'}: answer them first`;
    const errs = Rec.validate('test_scenario', rec);
    return errs.length ? errs[0] : null;
  }

  const STRUCTURED_KEYS = ['screen', 'steps', 'effect', 'given', 'examples', 'questions', 'when', 'then'];
  const q = v => JSON.stringify(String(v == null ? '' : v));
  // The file text of one record. Flat records keep the layout the .feature import has always written; a structured one is
  // dumped by js-yaml in a fixed key order (so a person reads it top to bottom: where from, what is done, what is expected).
  function fileText(rec, dump) {
    if (Rec.isStructuredScenario(rec)) {
      const order = ['id', 'requirement', 'title', 'source', 'screen', 'steps', 'effect', 'given', 'when', 'then', 'examples', 'questions', 'by', 'status'];
      const o = {}; for (const k of order) if (rec[k] !== undefined) o[k] = rec[k];
      return dump(o, { lineWidth: -1, noRefs: true });
    }
    const block = k => `${k}:\n${rec[k].map(v => `  - ${q(v)}`).join('\n')}`;
    return `id: ${rec.id}\nrequirement: ${q(rec.requirement)}\ntitle: ${q(rec.title)}\n${rec.source != null ? `source: ${q(rec.source)}\n` : ''}${block('given')}\n${block('when')}\n${block('then')}\nby: ${rec.by}\n${rec.status ? `status: ${rec.status}\n` : ''}`;
  }
  // The records and files for a batch of proposed cases of one requirement (shared by the mint tool and the .feature import).
  // opts: by, taken (ids in use), needQuote (mint: `quote` is the verbatim source, written as `source`, and the file is minted), dump.
  // Returns {files: [{id, path, quote, rec, text}]} or {error}. Structural errors come from Records.validate; the mint
  // refusals (page, spec, operation) are mintProblems, which the caller runs on each rec.
  function build(req, list, { by, taken = [], needQuote = false, dump } = {}) {
    const used = new Set(taken), files = [];
    for (const [i, x] of list.entries()) {
      let n = 1, id; do { id = `${req.id}-ts-${String(n++).padStart(2, '0')}`; } while (used.has(id)); used.add(id);
      const rec = { id, requirement: req.id, title: x && x.title };
      if (needQuote) rec.source = x && typeof x.quote === 'string' ? x.quote.trim() : '';
      for (const k of STRUCTURED_KEYS) if (x && x[k] !== undefined) rec[k] = x[k];
      rec.by = by;
      if (needQuote) rec.status = 'minted';
      const errs = Rec.validate('test_scenario', rec);
      if (errs.length) return { error: `Scenario ${i + 1}: ${errs.join('; ')}.` };
      if (needQuote && !rec.source) return { error: `Scenario ${i + 1}: quote the sentence of the page it comes from.` };
      files.push({ id, path: `test-scenarios/${id}.yaml`, quote: needQuote ? rec.source : '', rec, text: fileText(rec, dump) });
    }
    return { files };
  }
  // The strict mint: every scenario's refusals at once, as one message the agent can act on. null when all may be minted.
  function refusal(files, ctx) {
    const lines = [];
    files.forEach((f, i) => { for (const p of mintProblems(f.rec, ctx)) lines.push(`Scenario ${i + 1} (${f.rec.title}): ${p.reason}: ${p.message}`); });
    return lines.length ? `Refused, nothing minted. Fix every point and call mint_test_scenarios again:\n${lines.join('\n')}` : null;
  }


  // ---- B3: compile a bound structured scenario to request test cases (D9). Pure. ----
  const refuse = msg => new Error(`handover refused: ${msg}`);
  // The state a generated test opens the screen in: the initial one, unless it holds data back (pending or failed), else the first that doesn't.
  function startState(spec) {
    const names = Object.keys(isObj(spec.states) ? spec.states : {});
    const ok = n => { const s = spec.states[n]; return !(isObj(s) && ((s.pending || []).length || (s.failed || []).length)); };
    const initial = names.find(n => isObj(spec.states[n]) && spec.states[n].initial === true);
    return (initial && ok(initial) ? initial : names.find(ok) || initial || names[0]) || 'ready';
  }
  // The screen a scenario is rendered on: its own, or its host's when it is an overlay. null when the scenario's spec is unknown.
  function renderScreen(scenario, specs) {
    const s = specFor(specs, scenario && scenario.screen);
    return s ? (isObj(s.host) && s.host.screen ? s.host.screen : s.screen) : null;
  }
  function fill(v, ex, id, where) {
    if (typeof v === 'string') {
      const w = WHOLE.exec(v);
      const val = name => { if (!(name in ex)) throw refuse(`scenario ${id}: ${where} has no value for {${name}}`); return ex[name]; };
      if (w) return val(w[1]);
      return v.replace(/\{([A-Za-z_][\w-]*)\}/g, (_, n) => String(val(n)));
    }
    if (Array.isArray(v)) return v.map(x => fill(x, ex, id, where));
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, ex, id, where)]));
    return v;
  }
  const serverPath = url => { const m = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/]*(\/.*)?$/i.exec(String(url || '')); const p = m ? m[1] || '' : String(url || ''); return p.replace(/\/+$/, ''); };
  // scenario: a bound structured record; specs: as specFor; operations: id -> {method, path, server?} | null (server is the OpenAPI
  // servers[0].url); path: where the record lives (for the file header). Throws "handover refused: ..." (no file, unknown screen or
  // operation, unfilled placeholder).
  function compile({ scenario, specs, operations, path }) {
    const id = scenario.id;
    const own = specFor(specs, scenario.screen);
    if (!own) throw refuse(`scenario ${id}: no ui spec for ${scenario.screen}`);
    const hosted = isObj(own.host) && own.host.screen;
    const render = hosted ? specFor(specs, own.host.screen) : own;
    if (!render) throw refuse(`scenario ${id}: host screen ${own.host.screen} of ${scenario.screen} has no ui spec`);
    if (typeof render.file !== 'string' || !render.file) throw refuse(`scenario ${id}: ui spec ${render.screen} has no \`file\` (the page the test renders)`);
    const op = typeof operations === 'function' ? operations(scenario.effect && scenario.effect.operation) : null;
    if (!op) throw refuse(`scenario ${id}: operation ${scenario.effect && scenario.effect.operation} is not in a pinned OpenAPI file`);
    let prefix = [];
    if (hosted) {
      const anchor = Object.values(isObj(render.slots) ? render.slots : {}).flat().find(p => isObj(p) && p.id === own.host.anchor);
      if (!anchor || !isObj(anchor.locator)) throw refuse(`scenario ${id}: host anchor ${own.host.anchor} has no locator on ${render.screen}`);
      prefix = [{ verb: 'click', role: anchor.locator.role, name: anchor.locator.name }];
    }
    const path_ = `${serverPath(op.server)}${op.path}`.replace(/\{([^}]+)\}/g, ':$1');
    const examples = Array.isArray(scenario.examples) ? scenario.examples : [];
    const cases = examples.map((ex, i) => {
      const where = `examples[${i}]`;
      const steps = [...prefix];
      for (const s of Array.isArray(scenario.steps) ? scenario.steps : []) {
        const verb = verbOf(s); if (!verb) continue;
        const o = { verb, role: s[verb].role, name: s[verb].name };
        if (s.value !== undefined) o.value = fill(s.value, ex, id, where);
        steps.push(o);
      }
      const body = scenario.effect.body === undefined ? null : fill(scenario.effect.body, ex, id, where);
      return { title: `${id} example ${i + 1}`, steps, request: { method: op.method, path: path_, body } };
    });
    return { id, path: path || null, screen: render.screen, component: render.component, file: render.file, state: startState(render), cases };
  }

  // The text of ui-contract/tests/<screen>.scenarios.page.test.tsx: one test per (scenario, example) of the compiled scenarios of one
  // render screen (all share screen, component, file). Same input, same bytes. Vitest browser mode, like the Factory's page test.
  function testFile(screen, compiled) {
    const lit = JSON.stringify;
    const list = [...compiled].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const c0 = list[0];
    const noExt = c0.file.replace(/\\/g, '/').replace(/\.[A-Za-z0-9]+$/, '');
    const act = s => {
      const loc = `page.getByRole(${lit(s.role)}, { name: ${lit(s.name)} })`;
      if (s.verb === 'fill') return `await ${loc}.fill(${lit(String(s.value))});`;
      if (s.verb === 'select') return `await ${loc}.selectOptions(${lit(String(s.value))});`;
      return `await ${loc}.click();`;
    };
    const tests = [];
    for (const c of list) for (const k of c.cases) {
      const r = k.request;
      tests.push(`  test(${lit(k.title)}, async () => {
    let sent: unknown = undefined;
    worker.use(
      ...handlersFor(spec as any, ${lit(c.state)}),
      http.${r.method.toLowerCase()}(${lit(r.path)}, async ({ request }) => {
        const text = await request.clone().text();
        sent = text ? JSON.parse(text) : null;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await render(<div data-testid="ui-root"><Page /></div>);
    await expect.element(page.getByTestId("ui-root")).toBeInTheDocument();
${k.steps.map(x => `    ${act(x)}`).join('\n')}
    await expect.poll(() => sent, { message: ${lit(`${k.title}: ${r.method} ${r.path} body`)} }).toEqual(${lit(r.body)});
  });
`);
    }
    return `// GENERATED by designc from ${list.map(c => c.path || c.id).join(', ')}. Do not edit.
import React from "react";
import { describe, test, expect } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { http, HttpResponse } from "msw";
import spec from "../specs/${screen}.json";
import { ${c0.component} as Page } from "../../${noExt}";
import { handlersFor, useWorker } from "../preview/vitest-ui";

describe(${lit(`${screen} scenarios`)}, () => {
  const worker = useWorker();

${tests.join('\n')}});
`;
  }


  // ---- B4: gate clauses and BR coverage. Pure. ----
  const parsedSpecs = specs => {
    const out = [];
    for (const f of specs || []) {
      let s = f;
      if (f && typeof f.text === 'string') { try { s = JSON.parse(f.text); } catch { continue; } if (isObj(s) && !s.screen && f.path) s.screen = f.path.split('/').pop().replace(/\.json$/, ''); }
      if (isObj(s) && typeof s.screen === 'string') out.push(s);
    }
    return out;
  };
  // specs: [{path, text}] (the ui/specs files), testScenarios: parsed records with `_path`. Returns gate clauses of kind `scenario`:
  //  - a `commits: true` click transition needs a bound structured scenario with examples, rendered on the same screen (its host's when
  //    the spec is an overlay), with a step clicking that locator: {screen, requirement: the spec's ticket}
  //  - a structured scenario with open questions blocks: {scenario, requirement, path}
  function clauses({ specs = [], testScenarios = [] } = {}) {
    const out = [];
    const all = (testScenarios || []).filter(r => Rec.isStructuredScenario(r));
    for (const spec of parsedSpecs(specs).sort((a, b) => (a.screen < b.screen ? -1 : a.screen > b.screen ? 1 : 0))) {
      const render = isObj(spec.host) && spec.host.screen ? spec.host.screen : spec.screen;
      for (const t of Array.isArray(spec.transitions) ? spec.transitions : []) {
        if (!isObj(t) || t.commits !== true || !isObj(t.on) || !isObj(t.on.click)) continue;
        const covered = all.some(r => r.status === 'bound' && Array.isArray(r.examples) && r.examples.length > 0 && renderScreen(r, specs) === render
          && (Array.isArray(r.steps) ? r.steps : []).some(st => isObj(st) && same(st.click, t.on.click)));
        if (!covered) out.push({ kind: 'scenario', text: `${spec.screen}: committing "${t.on.click.name}" (${t.from} \u2192 ${t.to}) has no bound test scenario with examples`, screen: spec.screen, ...(spec.ticket != null ? { requirement: String(spec.ticket) } : {}) });
      }
    }
    for (const r of all) {
      const n = (Array.isArray(r.questions) ? r.questions : []).filter(x => typeof x === 'string' && x.trim()).length;
      if (n) out.push({ kind: 'scenario', text: `${r.id}: ${n} open question(s) block binding`, scenario: String(r.id), ...(r.requirement != null ? { requirement: String(r.requirement) } : {}), ...(r._path ? { path: r._path } : {}) });
    }
    return out;
  }
  // D6: how much of a requirement page a structured scenario quotes. Shown, never a gate clause.
  function coverage(pageText, scenarios = []) {
    const text = squash(String(pageText == null ? '' : pageText).replace(/<[^>]*>/g, ' '));
    const sentences = (text.match(/[^.!?]+[.!?]*/g) || []).map(squash).filter(x => /[A-Za-z0-9]/.test(x));
    const sources = (scenarios || []).filter(r => Rec.isStructuredScenario(r) && typeof r.source === 'string' && squash(r.source)).map(r => squash(r.source));
    const uncovered = sentences.filter(s => !sources.some(src => src.includes(s) || s.includes(src)));
    return { covered: sentences.length - uncovered.length, total: sentences.length, uncovered };
  }
  return { clauses, coverage, testFile, compile, startState, renderScreen, mintProblems, rowProblems, bindProblem, specFor, locators, build, fileText, refusal };
})();
if (typeof module === 'object' && module.exports) module.exports = TestScenarios;
