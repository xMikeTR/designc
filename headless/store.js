'use strict';
// The derived index (intelligence plane phase 3): records and their links in SQLite with FTS5 search, at
// <registry>/.designc/index.sqlite. It is rebuilt from the files and never a source of truth: delete it any time.
// Only this module opens the file (node:sqlite, built into Node 22.5+ and Electron's Node; no native dependency).
const fs = require('fs');
const path = require('path');
const Records = require('../renderer/records.js');

const REL = '.designc/index.sqlite';
const list = v => v == null ? [] : Array.isArray(v) ? v : [v];

function sqlite() {
  // node:sqlite prints an ExperimentalWarning once on Node 22; it is expected.
  return require('node:sqlite');
}

// Rows from a registry opened by headless/index.js open(): decisions, requirements, verdicts and procedures.
function rows(reg) {
  const all = [
    ...reg.decisions.map(r => ({ kind: 'decision', ...r })),
    ...reg.requirements.map(r => ({ kind: 'requirement', ...r })),
    ...reg.verdicts.map(r => ({ kind: 'verdict', ...r })),
    ...(reg.procedures || []).map(r => ({ kind: 'procedure', ...r })),
  ].filter(r => r.rec && r.rec.id != null);
  return all.map(({ kind, rec, path: p }) => ({
    id: String(rec.id), kind, path: p, status: Records.status(rec.status) || null,
    text: [rec.title, rec.statement, rec.rationale, rec.question, ...list(rec.steps)].filter(x => typeof x === 'string').join('\n'),
    json: JSON.stringify(rec),
    links: [
      ...list(rec.supersedes).map(d => ['supersedes', d]), ...list(rec.relies_on).map(d => ['relies_on', d]),
      ...list(rec.scope).map(d => ['scope', d]), ...list(rec.binds).map(d => ['scope', `el:${d}`]),
      ...list(rec.elements).map(d => ['scope', `el:${d}`]), ...list(rec.requirement).map(d => ['scope', `req:${d}`]),
    ].filter(([, d]) => typeof d === 'string' || typeof d === 'number').map(([rel, d]) => [rel, String(d)]),
  }));
}

function build(reg) {
  const file = path.join(reg.dir, REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ig = path.join(reg.dir, '.designc', '.gitignore');
  if (!fs.existsSync(ig)) fs.writeFileSync(ig, '*\n');
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(tmp);
  try {
    db.exec(`CREATE TABLE records (id TEXT, kind TEXT, status TEXT, path TEXT, json TEXT);
      CREATE TABLE links (src TEXT, rel TEXT, dst TEXT);
      CREATE INDEX links_dst ON links(dst);
      CREATE VIRTUAL TABLE text USING fts5(id UNINDEXED, kind UNINDEXED, body);`);
    const rec = db.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?)');
    const link = db.prepare('INSERT INTO links VALUES (?, ?, ?)');
    const txt = db.prepare('INSERT INTO text VALUES (?, ?, ?)');
    const rs = rows(reg);
    db.exec('BEGIN');
    for (const r of rs) {
      rec.run(r.id, r.kind, r.status, r.path, r.json);
      for (const [rel, dst] of r.links) link.run(r.id, rel, dst);
      txt.run(r.id, r.kind, `${r.id}\n${r.text}`);
    }
    db.exec('COMMIT');
    db.close();
    fs.renameSync(tmp, file);
    return { file: REL, records: rs.length, links: rs.reduce((n, r) => n + r.links.length, 0) };
  } catch (e) {
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(tmp, { force: true });
    return { error: `could not build the index: ${e.message}` };
  }
}

// Each word is matched as a quoted prefix term, so no FTS5 syntax from the caller reaches the engine.
const ftsQuery = q => String(q).split(/\s+/).filter(Boolean).map(w => `"${w.replace(/"/g, '""')}"*`).join(' ');

function withDb(dir, fn) {
  const file = path.join(dir, REL);
  if (!fs.existsSync(file)) return { error: `no index yet; run: designc-core index --registry ${dir}` };
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

function search(dir, q, { limit = 20 } = {}) {
  const m = ftsQuery(q);
  if (!m) return { error: 'search needs words' };
  return withDb(dir, db => ({
    hits: db.prepare('SELECT t.id AS id, t.kind AS kind, r.path AS path, r.status AS status, snippet(text, 2, \'[\', \']\', \'…\', 8) AS snippet FROM text t JOIN records r ON r.id = t.id AND r.kind = t.kind WHERE text MATCH ? ORDER BY rank LIMIT ?')
      .all(m, Math.max(1, Math.min(200, Number(limit) || 20))).map(r => ({ ...r })),
  }));
}

// Who points at a node: the inverse of links stored on one side (superseded_by, relied_on_by, scoped_by).
function inbound(dir, id) {
  const NAME = { supersedes: 'superseded_by', relies_on: 'relied_on_by', scope: 'scoped_by' };
  return withDb(dir, db => {
    const out = { superseded_by: [], relied_on_by: [], scoped_by: [] };
    for (const r of db.prepare('SELECT DISTINCT src, rel FROM links WHERE dst = ? ORDER BY src').all(String(id))) out[NAME[r.rel]].push(r.src);
    return { id: String(id), ...out };
  });
}

module.exports = { REL, rows, build, search, inbound, ftsQuery };
