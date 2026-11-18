/* designc desktop: health overlay, SARIF finding -> C4 element mapping. Pure, no I/O.
   Dual-load like renderer/pathpattern.js. docs: "designc health overlay: schema and first slice", section "Mapping SARIF findings".

   A finding belongs to the deepest element whose path glob matches its file, and counts roll up to every ancestor.
   A pure function of three inputs (SARIF, element paths, config), so it is tested without running any analyzer. */
const HealthMap = (() => {
  const PP = typeof module === 'object' && typeof require === 'function' ? require('./pathpattern.js') : PathPattern;

  const DEFAULT_CATEGORY = 'smell';

  // Repo-relative, forward slashes, no leading ./. Returns null for anything that is not a plain path inside the repo
  // (empty, absolute outside repoRoot, or containing `.`/`..` segments): such a finding is unmapped, never guessed.
  function normaliseUri(uri, repoRoot) {
    if (typeof uri !== 'string' || !uri.trim()) return null;
    let s = uri.trim();
    if (/^file:\/\//i.test(s)) s = s.replace(/^file:\/\/(localhost)?/i, '');
    try { s = decodeURIComponent(s); } catch { /* keep as written */ }
    s = s.replace(/\\/g, '/');
    if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1); // file:///C:/x
    if (repoRoot) {
      const root = String(repoRoot).replace(/\\/g, '/').replace(/\/+$/, '') + '/';
      if (s.startsWith(root)) s = s.slice(root.length);
    }
    if (s.startsWith('./')) s = s.slice(2);
    if (s.startsWith('/') || /^[A-Za-z]:\//.test(s)) return null; // absolute and not under the repo
    const segs = s.split('/');
    if (segs.some(g => g === '' || g === '.' || g === '..')) return null;
    return s;
  }

  // Longest glob wins. "Longest" is read as most specific: more literal segments first, then more segments in all.
  const specificity = glob => {
    const p = PP.create(glob);
    if (!p.ok) return null;
    const literal = p.segs.filter(g => !g.includes('*') && !g.includes('?')).length;
    return [literal, p.segs.length];
  };

  // Deepest owner of a path, or null. Ties on specificity go to the smaller element id so the answer is stable.
  function ownerOf(path, elements) {
    let best = null;
    for (const el of elements) {
      for (const glob of el.paths || []) {
        if (!PP.matches(glob, path)) continue;
        const sp = specificity(glob);
        if (!sp) continue;
        if (!best || sp[0] > best.sp[0] || (sp[0] === best.sp[0] && (sp[1] > best.sp[1] || (sp[1] === best.sp[1] && el.id < best.id)))) best = { id: el.id, sp };
      }
    }
    return best && best.id;
  }

  const excluded = (path, globs) => (globs || []).some(g => PP.matches(g, path));

  // First matching rule prefix wins; unlisted rules are smells.
  function categoryOf(ruleId, table) {
    const hit = (table || []).find(t => typeof ruleId === 'string' && ruleId.startsWith(t.prefix));
    return hit ? hit.category : DEFAULT_CATEGORY;
  }

  // FNV-1a, 32 bit. Enough to tell a moved finding from a changed one; this is not a security hash.
  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }

  /* Identity of a finding across commits. Never the line number, so moved code is not reported twice.
       1. SARIF partialFingerprints, when the tool supplies them (the tool knows its own findings best);
       2. else ruleId + path + a hash of the surrounding code: `context` (the caller's read of the lines around the
          finding), else the region's own snippet, else the message text. */
  function fingerprint(result, path, context) {
    const pf = result.partialFingerprints;
    if (pf && typeof pf === 'object') {
      const key = Object.keys(pf).sort()[0];
      if (key !== undefined) return `${result.ruleId || ''}|${key}:${pf[key]}`;
    }
    const region = result.locations && result.locations[0] && result.locations[0].physicalLocation && result.locations[0].physicalLocation.region;
    const code = context != null ? context : (region && region.snippet && region.snippet.text) || (result.message && result.message.text) || '';
    return `${result.ruleId || ''}|${path}|${hash(String(code).replace(/\s+/g, ' ').trim())}`;
  }

  const emptyCounts = () => ({ total: 0, new: 0, byLevel: {}, byCategory: {} });
  const bump = (c, level, category, isNew) => {
    c.total++;
    if (isNew) c.new++;
    c.byLevel[level] = (c.byLevel[level] || 0) + 1;
    c.byCategory[category] = (c.byCategory[category] || 0) + 1;
  };

  /* input:
       sarif      a SARIF 2.1.0 log object (every run is read)
       elements   [{ id, parent?, paths: [glob] }]; every one appears in the output, with zero counts if nothing landed
       config     { repoRoot?, exclude: [glob], categories: [{ prefix, category }] }
       baseline   Set/array of fingerprints already known; anything else is new. Absent means no baseline: nothing is new.
       readContext (path, line) => string | undefined, optional: the code around a finding, for the fingerprint
     returns { elements: { [id]: { total, new, byLevel, byCategory } }, unmapped: { findings }, excluded, mapped: [{ id, path, ruleId, level, category, fingerprint, new }] }
     `mapped` keeps one row per finding at its deepest owner, for the drill-down; roll-up counts live in `elements`. */
  function mapFindings({ sarif, elements = [], config = {}, baseline, readContext } = {}) {
    const known = baseline == null ? null : new Set(baseline);
    const byId = new Map(elements.map(e => [e.id, e]));
    const out = {};
    for (const e of elements) out[e.id] = emptyCounts();
    const unmapped = { findings: 0 };
    let excludedCount = 0;
    const mapped = [];

    for (const run of (sarif && sarif.runs) || []) {
      for (const result of run.results || []) {
        const loc = result.locations && result.locations[0];
        const path = normaliseUri(loc && loc.physicalLocation && loc.physicalLocation.artifactLocation && loc.physicalLocation.artifactLocation.uri, config.repoRoot);
        if (path !== null && excluded(path, config.exclude)) { excludedCount++; continue; }
        const owner = path === null ? null : ownerOf(path, elements);
        if (owner === null) { unmapped.findings++; continue; } // kept in the SARIF file; no owner is guessed
        const level = result.level || 'warning'; // SARIF's default when a result names none
        const category = categoryOf(result.ruleId, config.categories);
        const line = loc.physicalLocation.region && loc.physicalLocation.region.startLine;
        const fp = fingerprint(result, path, readContext ? readContext(path, line) : undefined);
        const isNew = known !== null && !known.has(fp);
        mapped.push({ id: owner, path, line, ruleId: result.ruleId, level, category, fingerprint: fp, new: isNew });
        // the owner, then its parent chain up to the system; the guard stops a cycle in a bad model
        const seen = new Set();
        for (let id = owner; id !== undefined && byId.has(id) && !seen.has(id); id = byId.get(id).parent) {
          seen.add(id);
          bump(out[id], level, category, isNew);
        }
      }
    }
    return { elements: out, unmapped, excluded: excludedCount, mapped };
  }

  return { mapFindings, normaliseUri, ownerOf, categoryOf, fingerprint };
})();
if (typeof module !== 'undefined') module.exports = HealthMap;
