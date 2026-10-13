/* designc desktop: requirement import. Pure, no I/O, no dependencies.
   Dual-load like renderer/look.js: <script src="requirement-import.js"> in the renderer, require() from tests.
   `read` turns one exported page (.html or .md) into id, title, source and version; `plan` judges a batch against
   the requirements already in the registry; `toYaml` writes the stub. Page text is never kept: only metadata
   leaves this module. Contract for converters: docs/requirement-import.md. */
const RequirementImport = (() => {
  const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  const KEY = /\b[A-Z][A-Z0-9]+-\d+\b/;
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  const decode = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
  const clean = s => decode(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  const norm = s => String(s).replace(/\r\n?/g, '\n');

  // Two FNV-1a 32-bit passes as 16 hex digits (the shape designc uses for every content hash).
  function hash16(s) {
    let a = 0x811c9dc5, b = 0x01000193 ^ 0x9e3779b9;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }

  function front(text) {
    const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
    if (!m) return { meta: {}, body: text };
    const meta = {};
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
    }
    return { meta, body: text.slice(m[0].length) };
  }

  const metaTag = (html, names) => {
    for (const n of names) {
      const re = new RegExp(`<meta\\s+[^>]*name=["']${n}["'][^>]*>`, 'i');
      const tag = re.exec(html);
      const c = tag && /content=["']([^"']*)["']/i.exec(tag[0]);
      if (c && c[1].trim()) return decode(c[1]).trim();
    }
    return null;
  };

  function readHtml(text) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text);
    const canon = /<link\s+[^>]*rel=["']canonical["'][^>]*>/i.exec(text);
    const href = canon && /href=["']([^"']+)["']/i.exec(canon[0]);
    const body = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
    return {
      title: (title && clean(title[1])) || (h1 && clean(h1[1])) || null,
      source: (href && decode(href[1]).trim()) || metaTag(text, ['source', 'confluence-page-url']),
      version: metaTag(text, ['confluence-page-version', 'version']),
      id: metaTag(text, ['id', 'requirement-id']),
      text: clean(body),
    };
  }

  function readMarkdown(text) {
    const { meta, body } = front(norm(text));
    const h = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
    return {
      title: meta.title || (h && h[1].trim()) || null,
      source: meta.source || null,
      version: meta.version || null,
      id: meta.id || null,
      text: body.replace(/\s+/g, ' ').trim(),
    };
  }

  function read({ name, text }) {
    const fail = problem => ({ ok: false, id: null, title: null, source: null, version: null, problems: [problem] });
    const isHtml = /\.html?$/i.test(name), isMd = /\.(md|markdown)$/i.test(name);
    if (!isHtml && !isMd) return fail(`${name}: a page must be an .html or .md file; convert it first (see docs/requirement-import.md)`);
    const r = isHtml ? readHtml(String(text)) : readMarkdown(String(text));
    if (!r.title) return fail(`${name}: no title (no <title> or <h1> in HTML, no front matter title or # heading in markdown)`);
    const key = r.id || (KEY.exec(r.title) || KEY.exec(name) || [null])[0];
    return {
      ok: true,
      id: key || null,
      title: r.title,
      source: r.source || name,
      version: r.version != null ? String(r.version) : hash16(r.text),
      problems: [],
    };
  }

  function slug(title, taken) {
    const words = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
    let base = '';
    for (const w of words) { const next = base ? `${base}-${w}` : w; if (next.length > 48) break; base = next; }
    base = base || 'untitled';
    let id = base;
    for (let n = 2; taken.has(id.toLowerCase()); n++) id = `${base}-${n}`;
    return id;
  }

  // existing: [{id, version, source?}]. Items keep file order; status is new | unchanged | changed | invalid.
  function plan(files, { existing = [] } = {}) {
    const byId = new Map(existing.map(e => [String(e.id).toLowerCase(), e]));
    const bySource = new Map(existing.filter(e => e.source).map(e => [String(e.source), e]));
    const taken = new Set(byId.keys());
    const seen = new Set();
    const items = [];
    for (const f of files) {
      const r = read(f);
      if (!r.ok) { items.push({ file: f.name, status: 'invalid', id: null, title: null, source: null, version: null, problems: r.problems }); continue; }
      let id = r.id;
      if (id && !SAFE_ID.test(id)) {
        items.push({ file: f.name, status: 'invalid', id: null, title: r.title, source: r.source, version: r.version,
          problems: [`${f.name}: id "${id}" is not usable as a file name; use letters, digits, dots, dashes and underscores`] });
        continue;
      }
      if (!id && bySource.has(r.source)) id = String(bySource.get(r.source).id);
      if (!id) { id = slug(r.title, new Set([...taken, ...seen])); }
      const key = id.toLowerCase();
      if (seen.has(key)) {
        items.push({ file: f.name, status: 'invalid', id, title: r.title, source: r.source, version: r.version,
          problems: [`${f.name}: id ${id} is already used by another page in this import; rename one page or give it an id`] });
        continue;
      }
      seen.add(key);
      const prev = byId.get(key);
      const item = { file: f.name, id, title: r.title, source: r.source, version: r.version, problems: [] };
      if (!prev) item.status = 'new';
      else if (String(prev.version) === r.version) item.status = 'unchanged';
      else { item.status = 'changed'; item.from = String(prev.version); }
      items.push(item);
    }
    const summary = { new: 0, unchanged: 0, changed: 0, invalid: 0 };
    for (const i of items) summary[i.status]++;
    return { items, summary, problems: items.flatMap(i => i.problems) };
  }

  const scalar = s => (/^[A-Za-z0-9][A-Za-z0-9 ,.'()/&-]*$/.test(s) ? s : JSON.stringify(s));
  const ver = v => (/^\d{1,6}$/.test(v) ? v : JSON.stringify(v));

  // One requirement file. `elements` is kept when a changed page updates an existing requirement.
  function toYaml(item, { elements = [] } = {}) {
    return `id: ${scalar(item.id)}\ntitle: ${scalar(item.title)}\nsource: ${JSON.stringify(item.source)}\n`
      + `version: ${ver(item.version)}\nelements: ${JSON.stringify(elements)}\n`;
  }

  // The requirement file's text with only the `elements` list replaced (flow or block form); every other line is
  // kept byte for byte, so title, source and version cannot change. null when the list is empty or not strings,
  // or the line is in a shape that cannot be edited safely.
  function setElements(text, names) {
    if (!Array.isArray(names) || !names.length || names.some(n => typeof n !== 'string' || !n.trim())) return null;
    const line = `elements: ${JSON.stringify(names)}`;
    const lines = String(text).split('\n');
    const at = lines.findIndex(l => l.startsWith('elements:'));
    if (at < 0) return String(text).replace(/\s*$/, '') + `\n${line}\n`;
    const rest = lines[at].slice('elements:'.length).replace(/\s+#.*$/, '').trim();
    let end = at + 1;
    if (rest === '') { while (end < lines.length && /^\s*-\s/.test(lines[end])) end++; }
    else if (!(rest.startsWith('[') && rest.endsWith(']'))) return null;
    lines.splice(at, end - at, line);
    return lines.join('\n');
  }

  return { read, plan, toYaml, setElements, hash16 };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = RequirementImport;
