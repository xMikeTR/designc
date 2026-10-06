/* designc desktop: code quality metrics, judged against thresholds in designc.json `quality`. Pure, no I/O, no
   dependencies. Dual-loaded like renderer/policy.js. Findings are warnings only: they reach Problems and the Code map
   badges, never the gate and never the Python CLI.

   A metric is {id, code, title, scope: 'method'|'type', better: 'lower'|'higher', value(subject, ctx) -> number|null}.
   `null` means unknown (for example CRAP with no coverage report): it is never a breach and never counted as zero.
   Register a new check with `Quality.register(metric)`; the judge, the rollups and the UI read the registry, so none
   of them change. Settings are keyed by metric id: a number is a limit in the metric's own direction (a maximum when
   lower is better, a minimum when higher is better); {max} or {min} say it explicitly. */
const Quality = (() => {
  // CRAP = cc^2 * (1 - coverage)^3 + cc. Unknown without coverage.
  const crap = (cc, cov) => (cov == null || !isFinite(cov)) ? null : cc * cc * Math.pow(1 - Math.min(1, Math.max(0, cov)), 3) + cc;

  const BUILTIN = [
    { id: 'cyclomatic', code: 'QC001', title: 'cyclomatic complexity', scope: 'method', better: 'lower', value: m => m.cc },
    { id: 'crap', code: 'QC002', title: 'CRAP score', scope: 'method', better: 'lower', value: m => crap(m.cc, m.coverage) },
    { id: 'methodLines', code: 'QC003', title: 'method length (lines)', scope: 'method', better: 'lower', value: m => m.lines },
    { id: 'coupling', code: 'QC004', title: 'coupling (types depended on)', scope: 'type', better: 'lower', value: (t, ctx) => ctx.out.get(t.id) || 0 },
    { id: 'typeMethods', code: 'QC005', title: 'methods per type', scope: 'type', better: 'lower', value: t => t.methods.length },
  ];

  const num = v => typeof v === 'number' && isFinite(v) && v >= 0;
  const round = v => Math.round(v * 10) / 10;

  function create() {
    const metrics = [];
    const reg = {
      register(metric) {
        if (!metric || !metric.id || !metric.code || typeof metric.value !== 'function') throw new Error('A metric needs id, code and value()');
        if (!['method', 'type'].includes(metric.scope)) throw new Error(`Metric ${metric.id}: scope must be method or type`);
        if (!['lower', 'higher'].includes(metric.better)) throw new Error(`Metric ${metric.id}: better must be lower or higher`);
        if (metrics.some(x => x.id === metric.id || x.code === metric.code)) throw new Error(`Metric ${metric.id} (${metric.code}) is already registered`);
        metrics.push({ title: metric.id, ...metric });
      },
      metrics: () => metrics.slice(),

      // settings -> {limits: [{metric, max?, min?}], problems: []}
      limits(settings) {
        const limits = [], problems = [];
        for (const [id, v] of Object.entries(settings && typeof settings === 'object' ? settings : {})) {
          const metric = metrics.find(x => x.id === id);
          if (!metric) { problems.push(`quality.${id} is not a known metric. Known: ${metrics.map(x => x.id).join(', ')}.`); continue; }
          let max, min;
          if (num(v)) { if (metric.better === 'lower') max = v; else min = v; }
          else if (v && typeof v === 'object' && !Array.isArray(v) && ((num(v.max) ? 1 : 0) + (num(v.min) ? 1 : 0)) === 1 && Object.keys(v).every(k => k === 'max' || k === 'min')) { max = v.max; min = v.min; }
          else { problems.push(`quality.${id} must be a number of 0 or more, or {"max": n} or {"min": n}.`); continue; }
          limits.push({ metric, ...(max != null ? { max } : {}), ...(min != null ? { min } : {}) });
        }
        return { limits, problems };
      },

      judge(code, settings) {
        const { limits, problems } = reg.limits(settings);
        const out = { findings: [], rollup: { type: new Map(), component: new Map(), container: new Map() }, problems };
        const types = (code && code.types) || [];
        if (!limits.length || !types.length) return out;
        const outDeg = new Map();
        for (const e of (code.typeEdges || [])) outDeg.set(e.from, (outDeg.get(e.from) || 0) + 1);
        const ctx = { code, out: outDeg };
        const blank = () => ({ breaches: 0, metrics: Object.fromEntries(limits.map(l => [l.metric.id, { worst: null, breaches: 0, unknown: 0 }])) });
        const slot = (map, key) => map.get(key) || map.set(key, blank()).get(key);
        const fold = (t, id, value, breach) => {
          const metric = limits.find(l => l.metric.id === id).metric;
          for (const [map, key] of [[out.rollup.type, t.id], [out.rollup.component, t.component], [out.rollup.container, t.container]]) {
            const s = slot(map, key), r = s.metrics[id];
            if (value == null) r.unknown++;
            else if (r.worst == null || (metric.better === 'lower' ? value > r.worst : value < r.worst)) r.worst = value;
            if (breach) { r.breaches++; s.breaches++; }
          }
        };
        for (const t of types) {
          slot(out.rollup.type, t.id); slot(out.rollup.component, t.component); slot(out.rollup.container, t.container);
          for (const l of limits) {
            const { metric } = l;
            const subjects = metric.scope === 'method' ? t.methods : [t];
            for (const s of subjects) {
              const value = metric.value(s, { ...ctx, type: t });
              const over = value != null && l.max != null && value > l.max, under = value != null && l.min != null && value < l.min;
              fold(t, metric.id, value, over || under);
              if (!over && !under) continue;
              const name = metric.scope === 'method' ? `${t.name}.${s.name}` : t.name;
              const where = metric.scope === 'method' ? { file: s.file, line: s.line } : { file: t.files[0].file, line: t.files[0].line };
              out.findings.push({ code: metric.code, metric: metric.id, sev: 'warning', type: t.name, typeId: t.id, component: t.component, container: t.container,
                ...(metric.scope === 'method' ? { method: s.name } : {}), value, limit: over ? l.max : l.min, ...where,
                msg: `${name}: ${metric.title} ${round(value)} is ${over ? 'above the limit of' : 'below the minimum of'} ${over ? l.max : l.min}` });
            }
          }
        }
        const order = new Map(metrics.map((m, i) => [m.code, i]));
        const better = new Map(metrics.map(m => [m.code, m.better]));
        out.findings.sort((a, b) => order.get(a.code) - order.get(b.code) || (better.get(a.code) === 'lower' ? b.value - a.value : a.value - b.value) || a.msg.localeCompare(b.msg));
        return out;
      },
    };
    BUILTIN.forEach(m => reg.register(m));
    return reg;
  }

  const def = create();
  return { create, crap, register: def.register, metrics: def.metrics, judge: def.judge, limits: def.limits };
})();
if (typeof module !== 'undefined') module.exports = Quality;
