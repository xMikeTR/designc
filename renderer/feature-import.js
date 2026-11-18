/* designc desktop: .feature import for test scenarios. Pure, no I/O, no dependencies.
   Dual-load like renderer/requirement-import.js: <script> in the renderer, require() from tests.
   `parse(text)` reads Gherkin into plain given/when/then lists; what it cannot carry over is listed in `skipped`,
   never guessed. Background, Scenario Outline, Examples, tables and doc strings are not imported. */
const FeatureImport = (() => {
  const KW = { given: 'given', when: 'when', then: 'then', and: null, but: null, '*': null };

  function parse(text) {
    const out = { feature: null, scenarios: [], skipped: [] };
    let cur = null, last = null, mode = null, doc = false; // mode: scenario | skip
    const skip = (line, what) => out.skipped.push({ line, what });
    const close = () => {
      if (cur) {
        const miss = ['given', 'when', 'then'].filter(k => !cur[k].length);
        if (miss.length) skip(cur.line, `Scenario "${cur.title}" has no ${miss.join(', ')} step`);
        else out.scenarios.push({ title: cur.title, given: cur.given, when: cur.when, then: cur.then, line: cur.line });
      }
      cur = null; last = null;
    };
    String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
      const n = i + 1, line = raw.trim();
      if (line.startsWith('"""') || line.startsWith('```')) { doc = !doc; return; }
      if (doc || !line || line.startsWith('#') || line.startsWith('@')) return;
      if (line.startsWith('|')) { if (mode) skip(n, 'table row'); return; }
      let m;
      if ((m = /^Feature:\s*(.*)$/i.exec(line))) { close(); mode = null; out.feature = m[1].trim() || null; return; }
      if ((m = /^Scenario Outline:\s*(.*)$/i.exec(line)) || (m = /^Scenario Template:\s*(.*)$/i.exec(line))) { close(); mode = 'skip'; skip(n, `Scenario Outline "${m[1].trim()}" (outlines are not imported)`); return; }
      if ((m = /^(?:Scenario|Example):\s*(.*)$/i.exec(line))) { close(); mode = 'scenario'; cur = { title: m[1].trim(), given: [], when: [], then: [], line: n }; if (!cur.title) { skip(n, 'Scenario with no title'); cur = null; mode = 'skip'; } return; }
      if (/^Background:/i.test(line)) { close(); mode = 'skip'; skip(n, 'Background (not imported)'); return; }
      if (/^Examples?:|^Scenarios:/i.test(line)) { mode = 'skip'; return; }
      if (mode !== 'scenario' || !cur) return;
      m = /^(Given|When|Then|And|But|\*)\s+(.+)$/i.exec(line);
      if (!m) { skip(n, `unrecognised line "${line.slice(0, 40)}"`); return; }
      const k = KW[m[1].toLowerCase()] || last;
      if (!k) { skip(n, `"${m[1]}" with no step before it`); return; }
      last = k; cur[k].push(m[2].trim());
    });
    close();
    return out;
  }

  return { parse };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = FeatureImport;
