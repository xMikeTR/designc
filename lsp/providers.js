/* designc language server: the pure half. No vscode-languageserver import, no I/O except the `exists` and `textOf` callbacks passed in.
   Problems rows -> LSP diagnostics, DslAssist results -> LSP completion and hover, uri and registry-root helpers. server.js is the transport. */
'use strict';
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const Core = require('../renderer/core.js');

const uri = (root, rel) => pathToFileURL(path.join(root, rel)).href;
// POSIX registry-relative path of a file: URI, or null when it is not a file URI or lies outside the root.
function relOf(root, u) {
  let p; try { p = fileURLToPath(u); } catch { return null; }
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// The registry root for a document: the nearest ancestor holding designc.json; else the first explicit root
// (--registry, DESIGNC_REGISTRY, initializationOptions.registry), else the first workspace folder that is a registry; else null.
function rootFor(fsPath, { exists, fallback = {} }) {
  let dir = path.dirname(fsPath);
  for (;;) {
    if (exists(path.join(dir, 'designc.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const r of fallback.explicit || []) if (r) return r;
  for (const f of fallback.folders || []) if (isRegistry(f, exists)) return f;
  return null;
}
const isRegistry = (dir, exists) => exists(path.join(dir, 'designc.json')) || exists(path.join(dir, 'model', 'workspace.dsl'));

const SEVERITY = { error: 1, warning: 2 };
const severity = sev => SEVERITY[sev] || 3;

// 1-based `line` -> an LSP range over `text` (or just the line start when there is no text).
function rangeOf(line, text, { fromFirstNonSpace }) {
  const lines = text == null ? null : text.split('\n');
  const n = Math.max(line || 1, 1) - 1;
  if (!lines) return { start: { line: n, character: 0 }, end: { line: n, character: 0 } };
  const ln = Math.min(n, lines.length - 1), t = (lines[ln] || '').replace(/\r$/, '');
  const first = fromFirstNonSpace ? Math.max(t.search(/\S/), 0) : 0;
  return { start: { line: ln, character: first }, end: { line: ln, character: t.length } };
}

// groups: Problems.rows(...). -> Map<uri, Diagnostic[]>, in row order per URI.
function toDiagnostics(groups, { root, textOf, cfgModel, related = false }) {
  const out = new Map();
  for (const [rel, rows] of groups) {
    const u = uri(root, rel), text = textOf ? textOf(rel) : null;
    const list = out.get(u) || []; out.set(u, list);
    for (const r of rows) {
      const isModel = r.fi != null || r.code === 'parse';
      const d = { range: rangeOf(r.line, text, { fromFirstNonSpace: isModel }), severity: severity(r.sev), code: r.code, source: 'designc',
        message: r.msg + (r.unknown ? ' (undeclared property)' : '') + (r.f && r.f.hint ? `\n${r.f.hint}` : '') };
      if (related && r.f && r.f.related && r.f.related.length) {
        d.relatedInformation = r.f.related.map(x => {
          const rrel = Core.locFile(x, cfgModel);
          return { location: { uri: uri(root, rrel), range: rangeOf(x.line, textOf ? textOf(rrel) : null, { fromFirstNonSpace: true }) }, message: x.label };
        });
      }
      list.push(d);
    }
  }
  return out;
}

// What to publish: every URI in `next`, plus [] for each URI in `previous` that dropped out.
function withClears(next, previous) {
  const out = new Map(next);
  for (const u of previous || []) if (!out.has(u)) out.set(u, []);
  return out;
}

// DslAssist results -> LSP shapes (0-based; `line` is the 0-based line number).
function toCompletion(r, line) {
  if (!r) return null;
  const range = { start: { line, character: r.from }, end: { line, character: r.to } };
  return r.items.map(i => ({ label: i.label, kind: i.kind === 'value' ? 20 : 10, ...(i.detail ? { detail: i.detail } : {}), documentation: i.documentation,
    ...(i.snippet ? { insertTextFormat: 2 } : {}), textEdit: { range, newText: i.insertText } }));
}
function toHover(h, line) {
  if (!h) return null;
  return { contents: { kind: 'markdown', value: h.markdown.join('\n\n') }, range: { start: { line, character: h.from }, end: { line, character: h.to } } };
}

module.exports = { uri, relOf, rootFor, isRegistry, severity, rangeOf, toDiagnostics, withClears, toCompletion, toHover };
