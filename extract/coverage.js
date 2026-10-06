'use strict';
// Coverage reports (Cobertura XML, lcov) -> line hits per file, then onto each method as `coverage` (0..1).
// Pure parsing plus one loader. A method with no instrumented line, or whose file is in no report, gets no
// `coverage` at all: unknown is not zero (CRAP stays unknown rather than looking bad or good).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const glob = require('./glob');

const norm = p => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
const attrs = tag => { const o = {}; tag.replace(/([\w:-]+)\s*=\s*"([^"]*)"/g, (_, k, v) => { o[k] = v; return ''; }); return o; };
const bump = (m, file, line, hits) => {
  if (!m.has(file)) m.set(file, new Map());
  const f = m.get(file); f.set(line, (f.get(line) || 0) + hits);
};

function parseCobertura(xml) {
  const out = new Map();
  const classRe = /<class\b([^>]*?)(?:\/>|>([\s\S]*?)<\/class>)/g;
  let c;
  while ((c = classRe.exec(xml))) {
    const file = attrs(c[1]).filename; if (!file || !c[2]) continue;
    const lineRe = /<line\b([^>]*?)\/?>/g; let l;
    // only <lines> of the class itself: a method's own <lines> repeat the same line numbers and would double count
    const body = c[2].replace(/<methods>[\s\S]*?<\/methods>/g, '');
    while ((l = lineRe.exec(body))) {
      const a = attrs(l[1]), n = +a.number, h = +a.hits;
      if (Number.isInteger(n) && isFinite(h)) bump(out, norm(file), n, h);
    }
  }
  return out;
}

function parseLcov(text) {
  const out = new Map(); let file = null;
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (s.startsWith('SF:')) file = norm(s.slice(3));
    else if (s === 'end_of_record') file = null;
    else if (file && s.startsWith('DA:')) { const [n, h] = s.slice(3).split(','); if (/^\d+$/.test(n) && isFinite(+h)) bump(out, file, +n, +h); }
  }
  return out;
}

function parse(text) {
  const t = String(text || '');
  if (/<coverage\b/.test(t)) return parseCobertura(t);
  if (/^\s*(TN:|SF:)/m.test(t)) return parseLcov(t);
  return new Map();
}

function merge(maps) {
  const out = new Map();
  for (const m of maps) for (const [file, lines] of m) for (const [n, h] of lines) bump(out, file, n, h);
  return out;
}

const segs = p => norm(p).split('/').filter(Boolean);
function shared(a, b) { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; }

// Whole-segment suffix match, the longest wins. A tie between two different report files is not guessed.
function lookup(index, file) {
  const fs_ = segs(file), cands = index.get(fs_[fs_.length - 1]) || [];
  let best = null, tie = false;
  for (const c of cands) {
    const n = shared(fs_, c.segs);
    if (n < Math.min(fs_.length, c.segs.length) && n < 2) continue; // one path ends the other, or at least folder + file agree (CI roots differ)
    if (!best || n > best.n) { best = { n, c }; tie = false; } else if (n === best.n) tie = true;
  }
  return best && !tie ? best.c.lines : null;
}

function apply(code, map) {
  const index = new Map();
  for (const [file, lines] of map) { const s = segs(file); if (!s.length) continue; const k = s[s.length - 1]; if (!index.has(k)) index.set(k, []); index.get(k).push({ segs: s, lines }); }
  let methods = 0, covered = 0;
  for (const t of (code && code.types) || []) for (const m of t.methods) {
    methods++;
    const lines = lookup(index, m.file); if (!lines) continue;
    let total = 0, hit = 0;
    for (let n = m.line; n <= m.endLine; n++) if (lines.has(n)) { total++; if (lines.get(n) > 0) hit++; }
    if (total) { m.coverage = hit / total; covered++; }
  }
  return { methods, covered };
}

async function find(dir, globs, rel = '', depth = 0, out = []) {
  if (depth > 10) return out;
  let entries = [];
  try { entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await find(dir, globs, r, depth + 1, out);
    else if (globs.some(g => glob.match(g, r))) out.push(r);
  }
  return out;
}

// globs: repo-relative patterns, e.g. ["**/coverage.cobertura.xml", "coverage/lcov.info"]
async function load(repo, globs) {
  if (globs == null || (Array.isArray(globs) && !globs.length)) return { files: [], map: new Map(), problems: [] };
  if (!Array.isArray(globs) || globs.some(g => typeof g !== 'string' || !g)) return { files: [], map: new Map(), problems: ['extract.coverage must be a list of glob patterns, for example ["**/coverage.cobertura.xml"].'] };
  const files = await find(repo, globs.map(norm));
  const maps = [], problems = [];
  for (const f of files) {
    let text = ''; try { text = await fsp.readFile(path.join(repo, f), 'utf8'); } catch { problems.push(`${f} could not be read.`); continue; }
    const m = parse(text);
    if (!m.size) problems.push(`${f} is not a Cobertura or lcov report, or has no line data.`); else maps.push(m);
  }
  return { files, map: merge(maps), problems };
}

module.exports = { parse, parseCobertura, parseLcov, merge, apply, load };
