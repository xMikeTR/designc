/* designc desktop: health overlay, property status. Pure, no I/O, no dependencies.
   Dual-load like renderer/pathpattern.js. docs: "designc health overlay: schema and first slice".

   One computed status per (element, property), from the design model's claim plus the evidence in health.json.
   Status is never stored. Only a person creates a claim; only an executable check produces verified. */
const HealthStatus = (() => {
  const UNKNOWN = 'unknown', INFERRED = 'inferred', DECLARED = 'declared', VERIFIED = 'verified', VIOLATED = 'violated';
  const NOT_APPLICABLE = 'not-applicable'; // not a sixth status: the property makes no sense here and is left off the map

  // Evidence the schema does not allow is ignored, never guessed at.
  const isStatic = e => e && e.kind === 'static' && (e.result === 'supports' || e.result === 'contradicts');
  const isCheck = e => e && e.kind === 'check' && (e.result === 'pass' || e.result === 'fail');

  /* input:
       claim            truthy when the design model claims the property (a person put it there)
       applicable       property.applicable from health.json; false -> not-applicable. Absent means applicable.
       evidence         property.evidence from health.json
       changedSince     (commit) => boolean: did any file under the element's paths change after `commit`?
                        The caller owns git; this function stays pure. Missing means "cannot tell", which counts as changed.
     A check is *fresh* when no file under the element's paths changed since its commit. A stale check, pass or fail,
     says nothing about the code as it is now, so it does not move the status.
     A contradicting static finding is not tied to freshness: the doc ties only verified to a commit. */
  function compute({ claim = false, applicable = true, evidence = [], changedSince } = {}) {
    if (applicable === false) return NOT_APPLICABLE;
    const list = Array.isArray(evidence) ? evidence : [];
    const stale = e => !e.commit || typeof changedSince !== 'function' || changedSince(e.commit) !== false;
    const checks = list.filter(isCheck).filter(e => !stale(e));
    const statics = list.filter(isStatic);

    if (!claim) return statics.length ? INFERRED : UNKNOWN; // inference never promotes itself to declared

    if (checks.some(e => e.result === 'fail') || statics.some(e => e.result === 'contradicts')) return VIOLATED;
    if (checks.some(e => e.result === 'pass')) return VERIFIED;
    return DECLARED;
  }

  // Applicable properties not yet verified: the headline number on the map. `statuses` is a list of compute() results.
  const unverified = statuses => statuses.filter(s => s !== NOT_APPLICABLE && s !== VERIFIED).length;

  return { compute, unverified, UNKNOWN, INFERRED, DECLARED, VERIFIED, VIOLATED, NOT_APPLICABLE };
})();
if (typeof module !== 'undefined') module.exports = HealthStatus;
