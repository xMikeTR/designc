/* designc desktop: completion and hover for d.* properties in the DSL. Pure, no I/O, editor-neutral (0-based characters on one line).
   Dual-load like renderer/work.js: <script src="dsl-assist.js"> in the renderer (before app.js), require('./renderer/dsl-assist.js')
   from the LSP and tests. app.js's Monaco providers and lsp/providers.js are thin adapters over completeAt/hoverAt. */
const DslAssist = (() => {
  const BASE = [
    ['d.interaction', 'relationship', ['sync', 'async'], 'Call style. Undeclared counts as sync for DC003.'],
    ['d.delivery', 'relationship', ['at-most-once', 'at-least-once', 'exactly-once'], 'Delivery guarantee of an async interaction (DC001).'],
    ['d.idempotent', 'relationship', ['yes', 'no'], 'Whether the receiver handles this interaction idempotently (DC001, DC004).'],
    ['d.retry', 'relationship', ['none', 'fixed', 'backoff'], 'Caller retry policy (DC004).'],
    ['d.retry.max', 'relationship', null, 'Maximum retry attempts, a whole number.'],
    ['d.timeout', 'relationship', null, 'Caller timeout in milliseconds. Must cover the callee\'s worst case (DC007).'],
    ['d.encrypted', 'relationship', ['yes', 'no'], 'Encrypted in transit (DC006).'],
    ['d.authenticated', 'relationship', ['yes', 'no'], 'Caller is authenticated (DC006).'],
    ['d.writes', 'relationship', null, 'Comma-separated entities written to the destination store (DC002).'],
    ['d.concurrency', 'relationship', ['none', 'optimistic', 'pessimistic'], 'Concurrency control on those writes (DC002).'],
    ['d.latency.max', 'element', null, 'Worst-case own processing time in milliseconds, not counting its calls (DC007).'],
    ['d.fanout', 'element', ['sequential', 'parallel'], 'Whether the element makes its outgoing sync calls one after another or together. Default sequential (DC007).'],
    ['d.retry.budget', 'element', null, 'Retry amplification this receiver tolerates; overrides retryAmplification in designc.json (DC008).'],
    ['d.instances', 'element', null, 'Running instances, a whole number (DC002, DC005).'],
    ['d.critical', 'element', ['yes', 'no'], 'On a critical path (DC005).'],
    ['d.zone', 'element', null, 'Trust zone name; children inherit it (DC006).'],
    ['d.style', 'element', ['event-driven', 'request-response'], 'Architecture style; set on a system, children inherit it. event-driven makes a sync call between its elements a finding (DC012).'],
    ['d.api', 'element', ['api-first', 'none'], 'Whether callers go through a named API; set on a system, children inherit it. api-first needs d.operation on a sync call into it (DC013). none switches it off below.'],
    ['d.ui', 'element', ['thin', 'none'], 'Whether UI elements stay thin; set on a system, children inherit it. thin means a UI must not reach a store or own data (DC014). none switches it off below.'],
    ['d.availability', 'element', null, 'Availability as a fraction, e.g. 0.999 (DC003).'],
    ['d.owns', 'element', null, 'Comma-separated entities this element owns writes to (DC002).'],
    ['d.store', 'element', ['yes', 'no'], 'Treat as a data store. Default: the Database tag.'],
    ['d.aka', 'element', null, 'Other names, used to match code in the as-built diff.'],
    ['d.code', 'element', null, 'Repo paths or globs where this element\'s code lives, comma-separated: * and ? within a folder name, ** as a whole folder (src/Api is one file; write src/Api/**). A coding agent keeps task writes inside them. Needs d.risk; areas must not overlap or nest (DC009).'],
    ['d.risk', 'element', ['low', 'medium', 'high'], 'How risky a change here is. A coding agent may use it to gate merges.'],
    ['d.suppress', 'both', null, 'Accept findings here: "DCnnn: reason; DCnnn: reason". A reason is required.'],
  ];

  // The property table: the base entries, then the canvas vocabulary's (`vocabulary.propsList()`), if given.
  const props = vocabulary => (vocabulary && vocabulary.propsList ? [...BASE, ...vocabulary.propsList()] : [...BASE]);
  const byKey = list => new Map(list.map(p => [p[0], { key: p[0], target: p[1], values: p[2], doc: p[3] }]));
  const targetLabel = t => (t === 'both' ? 'element or relationship' : t);

  // Completion at `character` (0-based) on `lineText`: null, or {from, to, items}. Triggers on `"` and `.`.
  function completeAt(lineText, character, PROP, PROPS) {
    const line = lineText.slice(0, character);
    const val = /"(d\.[\w.]+)"\s+"([^"]*)$/.exec(line);
    if (val) {
      const p = PROP.get(val[1]); if (!p || !p.values) return null;
      return { from: character - val[2].length, to: character, items: p.values.map(v => ({ label: v, kind: 'value', documentation: p.doc, insertText: v, snippet: false })) };
    }
    const key = /"(d\.?[\w.]*)$/.exec(line) || (/"$/.test(line) ? ['', ''] : null);
    if (!key) return null;
    return { from: character - key[1].length, to: character, items: PROPS.map(([k, target, values, doc]) => ({
      label: k, kind: 'property', detail: targetLabel(target), documentation: doc, snippet: true,
      insertText: values ? `${k}" "\${1|${values.join(',')}|}` : `${k}" "\${1}`,
    })) };
  }

  // Hover at `character` (0-based): null, or {from, to, markdown: [head, body]}.
  function hoverAt(lineText, character, PROP) {
    const re = /"(d\.[\w.]+)"/g; let m;
    while ((m = re.exec(lineText))) {
      if (character >= m.index && character <= m.index + m[0].length) {
        const p = PROP.get(m[1]);
        return { from: m.index, to: m.index + m[0].length, markdown: p ? [`**${p.key}** · ${targetLabel(p.target)}`, p.doc + (p.values ? `\n\nValues: \`${p.values.join('` | `')}\`` : '')] : [`**${m[1]}** is not a design property`] };
      }
    }
    return null;
  }

  return { BASE, props, byKey, completeAt, hoverAt };
})();
if (typeof module !== 'undefined') module.exports = DslAssist;
