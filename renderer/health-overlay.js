/* designc desktop: health overlay, view model. Pure, no I/O. Dual-load like renderer/pathpattern.js.
   docs: "designc health overlay: schema and first slice", section "Overlay behaviour in designc".

   Joins health.json (evidence) with the model's claims and returns what the sheet draws per element:
   a finding badge (worst level) and one chip per applicable property. Nothing here is stored. */
const HealthOverlay = (() => {
  const HS = typeof module === 'object' && typeof require === 'function' ? require('./health-status.js') : HealthStatus;

  const PROPERTIES = ['idempotent', 'cached'];
  const LEVELS = ['error', 'warning', 'note']; // worst first; SARIF's own words

  const worst = byLevel => LEVELS.find(l => byLevel && byLevel[l] > 0) || null;

  /* input:
       health       parsed health.json, or null (no file: nothing is drawn, the map stays as it is)
       claims       (elementId) => { idempotent?: bool, cached?: bool }  what the model says; a person wrote it
       changedSince (elementId, commit) => bool, optional: did files under the element's paths change after `commit`?
     returns { byElement: { [id]: { badge: {count, new, worst}|null, chips: [{property, status}] } },
               headline: { unverified, unmapped } } or null when there is no usable health file. */
  function build({ health, claims = () => ({}), changedSince } = {}) {
    if (!health || typeof health !== 'object' || !health.elements || typeof health.elements !== 'object') return null;
    const byElement = {};
    let unverified = 0;
    for (const [id, el] of Object.entries(health.elements)) {
      const f = el && el.findings;
      const badge = f && f.total > 0 ? { count: f.total, new: f.new || 0, worst: worst(f.byLevel), byCategory: f.byCategory || {} } : null;
      const claimed = claims(id) || {};
      const chips = [];
      for (const property of PROPERTIES) {
        const p = el && el.properties && el.properties[property];
        const status = HS.compute({
          claim: !!claimed[property], applicable: p ? p.applicable !== false : false, evidence: p && p.evidence,
          changedSince: changedSince ? commit => changedSince(id, commit) : undefined,
        });
        if (!p || status === HS.NOT_APPLICABLE) continue; // no entry: the producer made no statement about it
        chips.push({ property, status });
        if (status !== HS.VERIFIED) unverified++;
      }
      byElement[id] = { badge, chips };
    }
    return { byElement, headline: { unverified, unmapped: (health.unmapped && health.unmapped.findings) || 0 } };
  }

  return { build, PROPERTIES };
})();
if (typeof module !== 'undefined') module.exports = HealthOverlay;
