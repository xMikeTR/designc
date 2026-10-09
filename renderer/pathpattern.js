/* designc desktop: d.code path patterns. Pure, no I/O, no dependencies.
   Dual-load like renderer/policy.js: <script src="pathpattern.js"> before core.js in the renderer,
   require('./renderer/pathpattern.js') from core.js, extract/glob.js and tests. The meaning is System 2's
   (Factory.Core PathPattern) and docs/path-patterns.json is the contract both sides test against. */
const PathPattern = (() => {
  // A repo-relative path or glob: `*` and `?` inside a segment, `**` as a whole segment. Character classes,
  // braces, absolute paths, `.`, `..`, empty segments and `**` inside a segment are rejected.
  function create(input) {
    if (input == null || !String(input).trim()) return { ok: false, error: 'empty path' };
    let s = String(input).trim().replace(/\\/g, '/');
    if (s.startsWith('./')) s = s.slice(2);
    if (s.startsWith('/') || (s.length > 1 && s[1] === ':')) return { ok: false, error: `absolute path not allowed: ${input}` };
    if (/[[\]{}]/.test(s)) return { ok: false, error: `character classes and braces are not supported: ${input}` };
    const segs = s.replace(/\/+$/, '').split('/');
    const bad = segs.find(g => g === '' || g === '.' || g === '..' || (g.includes('**') && g !== '**'));
    if (bad !== undefined) return { ok: false, error: `invalid segment '${bad}' in ${input}` };
    return { ok: true, value: segs.join('/'), segs };
  }

  return { create };
})();
if (typeof module !== 'undefined') module.exports = PathPattern;
