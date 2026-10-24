/* designc desktop: legacy UI parity. Pure, no I/O, no dependencies.
   Dual-load like renderer/work.js: <script src="parity.js"> in the renderer, require('./renderer/parity.js') from the
   recorder (recorder/), scripts and tests. designc owns this contract; a consumer runs docs/parity-cases.json too.

   The rule: the new app looks and behaves like the legacy app unless a requirement says otherwise. Shape is compared,
   never data. A raw tree (an adapter's capture, recorder/index.js) is normalised into a snapshot that holds interface
   text (headings, labels, buttons, column headers, messages) and only the format shape of data (cells, field values),
   so a baseline in git carries no data. `diff` compares two snapshots of one step; `compare` a whole scenario. */
const Parity = (() => {
  const ACTIONS = ['goto', 'click', 'fill', 'select'];
  const KINDS = ['missing', 'extra', 'text', 'shape', 'state', 'order', 'sort', 'filter', 'spacing', 'step'];
  const TOLERANCE_PX = 2;
  const MAX_FAILURES = 50;
  // Wrappers that only lay things out; their children are lifted. Landmarks are kept only when named.
  const CHROME = new Set(['', 'generic', 'none', 'presentation', 'LabelText', 'rowgroup', 'InlineTextBox', 'LineBreak', 'RootWebArea', 'WebArea', 'document', 'Section', 'paragraph', 'div']);
  const LANDMARKS = new Set(['main', 'navigation', 'banner', 'contentinfo', 'region', 'complementary', 'form', 'group', 'search']);
  // Controls whose children are their own rendering: the name and value say everything.
  const LEAVES = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'spinbutton', 'slider', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'img', 'image', 'heading', 'columnheader']);
  // Role decides data before container: a button inside a cell is interface text, the cell's own text is data.
  const DATA_ROLES = new Set(['cell', 'gridcell']);
  const FIELDS = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
  const TABLES = new Set(['table', 'grid', 'treegrid']);
  const MASK_MODES = ['ignore', 'shape', 'exact'];

  const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  // Interface text with volatile parts replaced, so a count or a time in a message is not a wording change.
  function volatile(s) {
    return clean(s)
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<guid>')
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<timestamp>')
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '<time>')
      .replace(/\b\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\b/g, '<date>')
      .replace(/\d+([.,]\d+)*/g, '#');
  }

  // ---- format shape (en-GB, strict) ----

  // A digit run as a date or time part: 0d proves zero padding, d proves none, dd says nothing either way.
  const runShape = r => r.length === 1 ? 'd' : r.length === 2 ? (r[0] === '0' ? '0d' : 'dd') : 'd'.repeat(r.length);
  const DATE = /^(\d{1,4})([/.-])(\d{1,2})\2(\d{1,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
  const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
  // Groups of exactly three after the first: "1,2" is not a number, "1,200" is.
  const NUMBER = /^([^\d(-]{0,4}?)\s?(\(|-)?([^\d(-]{0,4}?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(\))?\s?([^\d]{0,4})$/;

  // The format of a value, never the value: "15/01/2026" -> date:dd/0d/dddd, "1,000.00" -> num:#,##0.00,
  // "(500.00)" -> num:(?0.00), "Bound" -> text:Aa, "1,2" -> digits:d,d. Compared with sameShape.
  function shape(text) {
    const t = clean(text);
    if (!t) return 'empty';
    let m = DATE.exec(t);
    if (m && (m[1].length === 4 || m[4].length >= 2)) {
      const time = m[5] ? ` ${runShape(m[5])}:${runShape(m[6])}${m[7] ? ':' + runShape(m[7]) : ''}` : '';
      return `date:${runShape(m[1])}${m[2]}${runShape(m[3])}${m[2]}${runShape(m[4])}${time}`;
    }
    m = TIME.exec(t);
    if (m) return `time:${runShape(m[1])}:${runShape(m[2])}${m[3] ? ':' + runShape(m[3]) : ''}`;
    m = NUMBER.exec(t);
    if (m && !/[A-Za-z]{5}/.test(m[1] + m[3] + m[7]) && (m[2] === '(') === !!m[6]) {
      const int = m[4];
      const group = int.includes(',') ? '#,##0' : int.length >= 4 ? '0' : '?0';
      const body = group + (m[5] != null ? '.' + '0'.repeat(m[5].length) : '');
      const neg = m[2] === '(' ? `(${body})` : m[2] === '-' ? `-${body}` : body;
      return `num:${m[1] + m[3]}${neg}${m[7]}`;
    }
    const letters = t.replace(/[^A-Za-z]/g, '');
    if (!letters) return 'digits:' + t.replace(/\d/g, 'd');
    if (letters.length === 1) return 'text:A?';
    if (letters === letters.toUpperCase()) return 'text:AA';
    if (letters === letters.toLowerCase()) return 'text:aa';
    const words = t.split(/\s+/).filter(w => /[A-Za-z]/.test(w));
    const first = words[0].replace(/[^A-Za-z]/g, '');
    if (first[0] === first[0].toUpperCase() && first.slice(1) === first.slice(1).toLowerCase()) return 'text:Aa';
    return 'text:aA';
  }

  const runsCompatible = (a, b) => a === b || (a === 'dd' && (b === '0d' || b === 'd')) || (b === 'dd' && (a === '0d' || a === 'd'));
  // Two shapes could be the same format. Unknown grouping (?0) fits either; a sign is compared only when both are negative;
  // an empty value fits anything (a blank cell is data).
  function sameShape(a, b) {
    if (a === b || a === 'empty' || b === 'empty') return true;
    const [ka, va] = [a.slice(0, a.indexOf(':')), a.slice(a.indexOf(':') + 1)];
    const [kb, vb] = [b.slice(0, b.indexOf(':')), b.slice(b.indexOf(':') + 1)];
    if (ka !== kb) return false;
    if (ka === 'text') return va === 'A?' || vb === 'A?' || va === vb;
    if (ka === 'date' || ka === 'time') {
      const ra = va.split(/([/.\-: ])/);
      const rb = vb.split(/([/.\-: ])/);
      return ra.length === rb.length && ra.every((x, i) => runsCompatible(x, rb[i]));
    }
    if (ka === 'num') {
      const parse = v => {
        const m = /^(.*?)(\(|-)?(#,##0|\?0|0)(\.0+)?\)?(.*)$/.exec(v);
        return m ? { pre: m[1], neg: m[2] || '', group: m[3], dec: m[4] || '', post: m[5] } : null;
      };
      const x = parse(va);
      const y = parse(vb);
      if (!x || !y) return va === vb;
      if (x.pre !== y.pre || x.post !== y.post || x.dec !== y.dec) return false;
      if (x.group !== y.group && x.group !== '?0' && y.group !== '?0') return false;
      return !(x.neg && y.neg && x.neg !== y.neg);
    }
    return va === vb;
  }

  // A sortable value under the pinned culture: dates and numbers as numbers, text folded to lower case.
  function sortValue(text) {
    const t = clean(text);
    let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if (shape(t).startsWith('num:')) {
      const neg = /^\D*[(-]/.test(t);
      const n = Number(t.replace(/[^\d.]/g, ''));
      return neg ? -n : n;
    }
    return t.toLowerCase();
  }

  function direction(values) {
    const vs = values.filter(v => v !== '').map(sortValue);
    if (new Set(vs.map(String)).size < 2) return 'unknown';
    const cmp = (a, b) => typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
    let asc = true;
    let desc = true;
    for (let i = 1; i < vs.length; i++) {
      const c = cmp(vs[i - 1], vs[i]);
      if (c > 0) asc = false;
      if (c < 0) desc = false;
    }
    return asc ? 'asc' : desc ? 'desc' : 'none';
  }

  // ---- normalise ----

  function maskFor(masks, role, name, column) {
    return (masks || []).find(m => (m.role == null || m.role === role) && (m.name == null || clean(m.name) === clean(name))
      && (m.column == null || clean(m.column) === clean(column))) || null;
  }

  // The raw tree's meaningful nodes: chrome lifted, unnamed landmarks lifted, a control's rendering dropped, text that
  // only repeats its parent's name dropped, other text kept as role "text".
  function prune(n, parentName) {
    const role = n.role || '';
    const name = clean(n.name);
    if (role === 'StaticText' || role === 'text') return name && name !== parentName ? [{ role: 'text', name, box: n.box || null, children: [] }] : [];
    const kids = LEAVES.has(role) ? [] : (n.children || []).flatMap(c => prune(c, name || parentName));
    if (CHROME.has(role) || (LANDMARKS.has(role) && !name)) return kids;
    const out = { role, name, box: n.box || null, children: kids };
    if (n.value != null && n.value !== '') out.value = String(n.value);
    if (n.testId) out.testId = n.testId;
    if (n.disabled) out.disabled = true;
    return [out];
  }

  // Keys among siblings: role:name for interface elements, role[column] for a data cell, role[testid], else role#n
  // (position among same-role siblings). A repeated key gets @1, @2.
  function keyAll(els) {
    const seen = new Map();
    const ord = new Map();
    for (const e of els) {
      const n = ord.get(e.role) || 0;
      ord.set(e.role, n + 1);
      let k = e.data ? (e.column != null ? `${e.role}[${e.column}]` : `${e.role}#${n}`)
        : e.name ? `${e.role}:${e.name}` : e.testId ? `${e.role}[${e.testId}]` : `${e.role}#${n}`;
      const c = seen.get(k) || 0;
      seen.set(k, c + 1);
      if (c) k += `@${c}`;
      e.key = k;
    }
    return els;
  }

  function columnsOf(rows) {
    const head = rows.find(r => r.children.some(c => c.role === 'columnheader'));
    return head ? head.children.filter(c => c.role === 'columnheader').map(c => c.name) : [];
  }

  function element(p, ctx) {
    const column = ctx.column;
    // Inside a cell, a link or text carrying the cell's own text is the record's data ("Mock Program Alpha" as a link);
    // a button is always interface text.
    const data = DATA_ROLES.has(p.role) || (ctx.cell != null && (p.role === 'link' || p.role === 'text') && clean(p.name) === ctx.cell);
    const mask = maskFor(ctx.masks, p.role, p.name, column);
    const e = { role: p.role, enabled: !p.disabled, box: p.box };
    if (p.testId) e.testId = p.testId;
    if (column != null) e.column = column;
    const asData = (data && !(mask && mask.mode === 'exact')) || (mask && mask.mode === 'shape');
    if (mask && mask.mode === 'ignore') { e.name = ''; e.data = true; e.shape = 'empty'; }
    else if (asData) { e.name = ''; e.data = true; e.shape = shape(p.name); }
    else e.name = data ? clean(p.name) : volatile(p.name);
    if (p.value != null && FIELDS.has(p.role)) e.valueShape = mask && mask.mode === 'ignore' ? 'empty' : shape(p.value);
    if (TABLES.has(p.role)) return table(e, p, ctx);
    const inCell = DATA_ROLES.has(p.role) ? { cell: clean(p.name), column } : {};
    e.children = keyAll(p.children.map(c => element(c, { masks: ctx.masks, ...inCell })));
    return e;
  }

  // A table keeps its header rows and one record (the first data row) as the template; how many records there are,
  // and their values, are data. Each column keeps the shape most of its values have. Expectations from the step
  // (sorted, filtered) are judged here, on this side alone, so no value needs to be kept.
  function table(e, p, ctx) {
    const rows = [];
    (function collect(n) { for (const c of n.children) { if (c.role === 'row') rows.push(c); else if (!TABLES.has(c.role)) collect(c); } })(p);
    const columns = columnsOf(rows);
    const records = rows.filter(r => !r.children.some(c => c.role === 'columnheader'));
    const heads = rows.filter(r => r.children.some(c => c.role === 'columnheader'));
    const cellsOf = r => r.children.filter(c => DATA_ROLES.has(c.role) || c.role === 'rowheader');
    const values = col => records.map(r => clean((cellsOf(r)[col] || {}).name));
    const rowEl = (r, key) => {
      const cells = cellsOf(r);
      const kids = r.children.map(c => element(c, { masks: ctx.masks, column: cells.includes(c) ? columns[cells.indexOf(c)] : undefined }));
      return { role: 'row', name: '', enabled: !r.disabled, box: r.box, key, children: keyAll(kids) };
    };
    e.columns = columns.map((name, i) => {
      const counts = new Map();
      for (const v of values(i)) { const s = shape(v); if (s !== 'empty') counts.set(s, (counts.get(s) || 0) + 1); }
      const top = [...counts].sort((a, b) => b[1] - a[1])[0];
      const m = maskFor(ctx.masks, 'cell', null, name);
      return { name, shape: top && !(m && m.mode === 'ignore') ? top[0] : 'empty', ...(m && m.mode === 'exact' ? { exact: true } : {}) };
    });
    e.records = records.length;
    e.children = [...heads.map((r, i) => rowEl(r, i ? `row:head@${i}` : 'row:head')), ...(records.length ? [rowEl(records[0], 'row:record')] : [])];
    const checks = [];
    const ex = ctx.expect || {};
    if (ex.sorted) {
      const i = columns.indexOf(clean(ex.sorted));
      checks.push({ kind: 'sort', column: clean(ex.sorted), dir: i < 0 ? 'no column' : direction(values(i)) });
    }
    if (ex.filtered) {
      const i = columns.indexOf(clean(ex.filtered.column));
      const want = clean(ex.filtered.contains).toLowerCase();
      const bad = i < 0 ? null : values(i).filter(v => !v.toLowerCase().includes(want)).length;
      checks.push({ kind: 'filter', column: clean(ex.filtered.column), rows: records.length, bad });
    }
    if (checks.length) e.checks = checks;
    return e;
  }

  // raw tree -> {elements, viewport}. The root is the page, never an element. opts: {masks, expect, viewport}.
  // expect.filtered.contains must already be this side's value (a param resolved by the recorder or the caller).
  function normalise(raw, { masks = [], expect = null, viewport = null } = {}) {
    const top = raw ? (raw.children || []).flatMap(c => prune(c, '')) : [];
    const elements = keyAll(top.map(p => element(p, { masks, expect })));
    // An expectation names a table only by column; a page with one table is the usual case.
    if (expect && (expect.sorted || expect.filtered) && !findTable(elements)) elements.push({ key: 'expect', role: 'expect', name: '', children: [], checks: [{ kind: expect.sorted ? 'sort' : 'filter', column: clean(expect.sorted || expect.filtered.column), dir: 'no table', bad: null }] });
    return { viewport, elements };
  }

  function findTable(els) {
    for (const e of els) { if (TABLES.has(e.role)) return e; const t = findTable(e.children || []); if (t) return t; }
    return null;
  }

  // ---- scenarios ----

  function stepProblem(step) {
    const ks = step && typeof step === 'object' ? Object.keys(step).filter(k => ACTIONS.includes(k)) : [];
    if (ks.length !== 1) return `a step needs exactly one of ${ACTIONS.join(', ')}`;
    const [k] = ks;
    const a = step[k];
    if (!a || typeof a !== 'object') return `${k} needs an object`;
    if (k === 'goto') { if (!(typeof a.path === 'string' && a.path)) return 'goto needs a path'; }
    else {
      if (typeof a.role !== 'string' || !a.role) return `${k} needs a role`;
      if (typeof a.name !== 'string') return `${k} needs a name (the accessible name; "" for none)`;
      if (a.index != null && !(Number.isInteger(a.index) && a.index >= 0)) return `${k} index must be a whole number from 0`;
      if (k !== 'click' && a.value == null) return `${k} needs a value`;
    }
    const ex = step.expect;
    if (ex != null) {
      if (typeof ex !== 'object') return 'expect must be a mapping';
      if (ex.sorted != null && typeof ex.sorted !== 'string') return 'expect.sorted names a column';
      if (ex.filtered != null && !(ex.filtered && typeof ex.filtered.column === 'string' && ex.filtered.contains != null)) return 'expect.filtered needs a column and contains';
    }
    return null;
  }

  // parity/scenarios/<id>.yaml: {id, screen?, title?, steps[], params?: {legacy: {}, next: {}}, masks?[]}.
  function scenarioProblems(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return ['the scenario is not a mapping'];
    const out = [];
    if (typeof s.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(s.id)) out.push('the scenario needs an id of letters, digits, ".", "_" or "-"');
    if (!Array.isArray(s.steps) || !s.steps.length) out.push('the scenario needs at least one step');
    else s.steps.forEach((st, i) => { const p = stepProblem(st); if (p) out.push(`step ${i + 1}: ${p}`); });
    if (s.masks != null) {
      if (!Array.isArray(s.masks)) out.push('masks must be a list');
      else s.masks.forEach((m, i) => { if (!m || !MASK_MODES.includes(m.mode)) out.push(`mask ${i + 1}: mode must be ${MASK_MODES.join(', ')}`); });
    }
    if (s.params != null && (typeof s.params !== 'object' || Array.isArray(s.params))) out.push('params must be a mapping of side to values');
    return out;
  }

  // The value of a {param: name} for one side, or the value as written.
  const paramOf = (v, params) => v && typeof v === 'object' && 'param' in v ? (params || {})[v.param] : v;

  // A recording (recorder/index.js) as a snapshot: each step's capture normalised, with the step's expectations
  // judged on this side. This is what a baseline holds; the raw trees and the data in them are not kept.
  function snapshot(recording, scenario, { params } = {}) {
    const p = params || ((scenario.params || {})[recording.side]) || {};
    return {
      scenario: recording.scenario, side: recording.side, adapter: recording.adapter,
      steps: recording.steps.map((s, i) => {
        const st = scenario.steps[i] || {};
        const ex = st.expect ? { ...st.expect } : null;
        if (ex && ex.filtered) ex.filtered = { ...ex.filtered, contains: paramOf(ex.filtered.contains, p) };
        const out = { n: s.n, action: s.action, status: s.status };
        if (s.reason) out.reason = s.reason;
        if (s.shot) out.shot = s.shot;
        if (s.capture) {
          Object.assign(out, normalise(s.capture.tree, { masks: scenario.masks, expect: ex, viewport: s.capture.viewport }));
          if (s.capture.blockedRequests) out.blockedRequests = s.capture.blockedRequests.map(b => b.method + ' ' + b.url);
        }
        return out;
      }),
    };
  }

  // ---- exceptions ----

  // What a requirement allows. added: acceptance criterion locators {role, name} (an element the new app adds or
  // changes); removed: a bound business decision's removes [{role, name, screen?}] (an element it drops).
  function exceptions({ acceptance = [], decisions = [] } = {}) {
    const added = [];
    for (const ac of acceptance) {
      for (const l of Object.values((ac && ac.locators) || {})) {
        if (l && typeof l.role === 'string' && typeof l.name === 'string') added.push({ role: l.role, name: clean(l.name), by: String(ac.id) });
      }
    }
    const removed = [];
    for (const d of decisions) {
      if (!d || d.status !== 'bound' || d.kind !== 'business' || !Array.isArray(d.removes)) continue;
      for (const r of d.removes) if (r && typeof r.role === 'string') removed.push({ role: r.role, name: clean(r.name), screen: r.screen || null, by: String(d.id) });
    }
    return { added, removed };
  }

  function removesProblems(d) {
    if (!d || d.removes == null) return [];
    if (!Array.isArray(d.removes)) return [`${d.id}: removes must be a list of {role, name}`];
    const out = [];
    d.removes.forEach((r, i) => { if (!r || typeof r.role !== 'string' || typeof r.name !== 'string') out.push(`${d.id}: removes entry ${i + 1} needs a role and a name`); });
    if (d.removes.length && d.kind !== 'business') out.push(`${d.id}: only a business decision can remove a legacy element`);
    return out;
  }

  // ---- diff ----

  const nameOf = e => e.data ? (e.column || '') : e.name;

  function diff(legacy, next, { exceptions: exc = { added: [], removed: [] }, tolerancePx = TOLERANCE_PX, screen = null } = {}) {
    const findings = [];
    const sameViewport = legacy.viewport && next.viewport && legacy.viewport.width === next.viewport.width && legacy.viewport.height === next.viewport.height;
    const covered = (kind, el) => {
      if (!el) return null;
      if (kind === 'missing') {
        const r = exc.removed.find(x => x.role === el.role && x.name === nameOf(el) && (!x.screen || !screen || x.screen === screen));
        return r ? r.by : null;
      }
      const a = exc.added.find(x => x.role === el.role && x.name === nameOf(el));
      return a ? a.by : null;
    };
    const add = (kind, path, msg, el, extra = {}) => {
      const by = covered(kind, el);
      findings.push({ kind, key: path, severity: by ? 'covered' : 'fail', msg, ...(by ? { by } : {}), ...(el ? { role: el.role, name: nameOf(el) } : {}), ...extra });
    };
    const label = e => `${e.role} ${nameOf(e) ? `"${nameOf(e)}" ` : ''}`;

    function walk(ls, ns, base) {
      const nByKey = new Map(ns.map(e => [e.key, e]));
      const pairs = ls.filter(e => nByKey.has(e.key)).map(e => [e, nByKey.get(e.key)]);
      const lKeys = new Set(ls.map(e => e.key));
      const missing = ls.filter(e => !nByKey.has(e.key));
      const extra = ns.filter(e => !lKeys.has(e.key));
      // A missing and an extra of the same role, in the same order among the unmatched, are one element whose text
      // changed. A data cell renamed with its column is not a finding of its own: the column header reports it.
      for (const m of [...missing]) {
        const x = extra.filter(y => y.role === m.role)[missing.filter(y => y.role === m.role).indexOf(m)];
        if (!x) continue;
        missing.splice(missing.indexOf(m), 1);
        extra.splice(extra.indexOf(x), 1);
        pairs.push([m, x]);
        if (!(m.data && x.data)) add('text', base + x.key, `${m.role} "${nameOf(m)}" reads "${nameOf(x)}"`, x, { was: nameOf(m) });
      }
      for (const m of missing) add('missing', base + m.key, `${label(m)}is missing`, m);
      for (const x of extra) add('extra', base + x.key, `${label(x)}is not in legacy`, x);
      pairs.sort((a, b) => ls.indexOf(a[0]) - ls.indexOf(b[0]));
      const at = pairs.map(([, n]) => ns.indexOf(n));
      if (at.some((v, i) => i && v < at[i - 1])) {
        add('order', base || '/', `order differs: legacy ${pairs.map(([l]) => l.key).join(', ')}; new ${[...pairs].sort((a, b) => ns.indexOf(a[1]) - ns.indexOf(b[1])).map(([, n]) => n.key).join(', ')}`, null);
      }
      let prev = null;
      for (const [l, n] of pairs) {
        const path = base + n.key;
        if (l.enabled !== n.enabled) add('state', path, `${label(l)}is ${n.enabled ? 'enabled' : 'disabled'}; legacy has it ${l.enabled ? 'enabled' : 'disabled'}`, n);
        // A cell under a column header is judged by its column, so a format change is one finding, not one per row.
        if (l.data && n.data && l.column == null && !sameShape(l.shape, n.shape)) add('shape', path, `${l.role} is ${n.shape}; legacy shows ${l.shape}`, n);
        if (l.valueShape && n.valueShape && !sameShape(l.valueShape, n.valueShape)) add('shape', path, `${label(l)}value is ${n.valueShape}; legacy shows ${l.valueShape}`, n);
        for (const lc of l.columns || []) {
          const nc = (n.columns || []).find(c => c.name === lc.name);
          if (nc && !lc.exact && !nc.exact && !sameShape(lc.shape, nc.shape)) add('shape', `${path}/column:${lc.name}`, `column "${lc.name}" is ${nc.shape}; legacy shows ${lc.shape}`, { role: 'columnheader', name: lc.name });
        }
        for (const lc of l.checks || []) {
          const nc = (n.checks || []).find(c => c.kind === lc.kind && c.column === lc.column);
          const col = { role: 'columnheader', name: lc.column };
          if (lc.kind === 'sort' && ['asc', 'desc'].includes(lc.dir)) {
            const nd = nc ? nc.dir : 'not checked';
            if (nd !== lc.dir && nd !== 'unknown') add('sort', path, `sorting by "${lc.column}" gives ${nd} order; legacy gives ${lc.dir}`, col);
          } else if (lc.kind === 'filter' && lc.bad === 0 && !(nc && nc.bad === 0)) {
            add('filter', path, nc && nc.bad != null ? `filtering by "${lc.column}" leaves ${nc.bad} of ${nc.rows} rows that do not match` : `filtering by "${lc.column}" could not be checked on the new app`, col);
          }
        }
        if (sameViewport && l.box && n.box) {
          if (Math.abs(l.box.h - n.box.h) > tolerancePx) add('spacing', path, `${label(l)}is ${Math.round(n.box.h)} px high; legacy ${Math.round(l.box.h)} px`, n);
          if (prev && prev[0].box && prev[1].box) {
            const gl = l.box.y - (prev[0].box.y + prev[0].box.h);
            const gn = n.box.y - (prev[1].box.y + prev[1].box.h);
            if (gl >= 0 && gn >= 0 && Math.abs(gl - gn) > tolerancePx) add('spacing', path, `gap above ${label(l)}is ${Math.round(gn)} px; legacy ${Math.round(gl)} px`, n);
          }
        }
        prev = [l, n];
        walk(l.children || [], n.children || [], path + '/');
      }
    }
    walk(legacy.elements || [], next.elements || [], '');
    return { findings };
  }

  // One scenario: legacy snapshot (the baseline) against the new app's. A step that could not run on either side is
  // could_not_run, never a failure; a step that ran on legacy but errored or was blocked on the new app fails.
  // outcome: fail (an uncovered failure), could_not_run (none, but some step did not run), pass.
  function compare({ scenario, legacy, next, exceptions: exc, tolerancePx }) {
    const steps = legacy.steps.map((l, i) => {
      const n = next.steps[i];
      const row = { n: l.n, action: l.action, legacyShot: l.shot || null, nextShot: (n && n.shot) || null, findings: [] };
      if (l.status !== 'ok') return { ...row, status: 'could_not_run', reason: `legacy: ${l.reason || l.status}` };
      if (!n || n.status === 'could_not_run') return { ...row, status: 'could_not_run', reason: `new app: ${(n && n.reason) || 'not recorded'}` };
      if (n.status !== 'ok') {
        return { ...row, status: 'compared', findings: [{ kind: 'step', key: `step ${l.n}`, severity: 'fail', msg: `step ${l.n} (${l.action}) ran on legacy but ${n.status === 'blocked' ? 'was blocked' : 'failed'} on the new app: ${n.reason || n.status}` }] };
      }
      return { ...row, status: 'compared', findings: diff(l, n, { exceptions: exc, tolerancePx, screen: scenario && scenario.screen }).findings };
    });
    const fails = steps.flatMap(s => s.findings.filter(f => f.severity === 'fail').map(f => ({ step: s.n, ...f })));
    const outcome = fails.length ? 'fail' : steps.some(s => s.status === 'could_not_run') ? 'could_not_run' : 'pass';
    return {
      scenario: (scenario && scenario.id) || legacy.scenario, outcome, steps,
      counts: { fail: fails.length, covered: steps.reduce((t, s) => t + s.findings.filter(f => f.severity === 'covered').length, 0), could_not_run: steps.filter(s => s.status === 'could_not_run').length },
    };
  }

  // The bounded failure list a parity_result carries.
  function failures(result, max = MAX_FAILURES) {
    return result.steps.flatMap(s => s.findings.filter(f => f.severity === 'fail').map(f => ({ step: s.n, key: f.key, kind: f.kind, msg: f.msg }))).slice(0, max);
  }

  // The parity_result event a recorder writes after comparing (ledger kind, pipeline.jsonl).
  function resultEvent(result, { commit, item, report } = {}) {
    const ev = { kind: 'parity_result', scenario: result.scenario, commit: commit == null ? null : String(commit), outcome: result.outcome, failures: failures(result) };
    if (item) ev.item = item;
    if (report) ev.report = report;
    return ev;
  }

  // ---- tech detection ----

  // Which adapter can record an app, from its files ({path, text?}). web when the repo is a web front end; unsupported
  // for desktop UI tech designc has no adapter for; unknown otherwise. Evidence names the files, never guesses.
  function detect(files) {
    const evidence = [];
    const desktop = [];
    for (const f of files || []) {
      const p = String(f.path || '');
      const t = String(f.text || '');
      if (/\.xaml$/i.test(p)) desktop.push(`${p}: XAML view`);
      else if (/\.(cs|vb|fs)proj$/i.test(p) && /<Use(WPF|WindowsForms)>\s*true/i.test(t)) desktop.push(`${p}: ${/WPF/i.test(t) ? 'UseWPF' : 'UseWindowsForms'}`);
      else if (/(^|\/)package\.json$/.test(p) && /"(react|react-dom|@angular\/core|vue|svelte|next)"\s*:/.test(t)) evidence.push(`${p}: ${(/"(react|@angular\/core|vue|svelte|next)"/.exec(t) || [])[1]} dependency`);
      else if (/(^|\/)playwright\.config\.(js|ts|mjs|cjs)$/.test(p)) evidence.push(`${p}: Playwright config`);
      else if (/\.html?$/i.test(p) && /<html/i.test(t)) evidence.push(`${p}: HTML page`);
    }
    if (evidence.length) return { tech: 'web', evidence };
    if (desktop.length) return { tech: 'unsupported', evidence: desktop };
    return { tech: 'unknown', evidence: [] };
  }

  return {
    ACTIONS, KINDS, TOLERANCE_PX, MAX_FAILURES, MASK_MODES,
    shape, sameShape, sortValue, direction, volatile, normalise, stepProblem, scenarioProblems, snapshot,
    exceptions, removesProblems, diff, compare, failures, resultEvent, detect,
  };
})();
if (typeof module !== 'undefined') module.exports = Parity;
