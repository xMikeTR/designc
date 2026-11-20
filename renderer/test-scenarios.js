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
  const placeholders = v => {
    const out = [];
    const walk = x => { if (typeof x === 'string') for (const m of x.matchAll(/\{([A-Za-z_][\w-]*)\}/g)) out.push(m[1]); else if (Array.isArray(x)) x.forEach(walk); else if (isObj(x)) Object.values(x).forEach(walk); };
    walk(v); return out;
  };

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
    const loc = spec ? locators(spec) : null;
    const steps = Array.isArray(rec.steps) ? rec.steps : [];
    const examples = Array.isArray(rec.examples) ? rec.examples : [];
    let commits = false;
    if (loc) steps.forEach((s, i) => {
      const verb = verbOf(s); if (!verb) return;
      const l = s[verb];
      const t = loc.transitions.filter(x => same(x.locator, l));
      if (!loc.placements.some(p => same(p, l)) && !t.length) add('locator_not_in_spec', `steps[${i}]: ${verb} ${locText(l)} is not a placement locator or transition locator of the ${rec.screen} spec`);
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

  return { mintProblems, bindProblem, specFor, locators, build, fileText, refusal };
})();
if (typeof module === 'object' && module.exports) module.exports = TestScenarios;
