'use strict';
// Declared intent: the `depends_on` list in the YAML front matter of one document in the repo (designc.json
// `extract.intent`, repo-relative). Read as plain lines, no YAML library, so only simple forms count:
// `- name`, `- name: x` / `- id: x` / `- system: x`, and `depends_on: [a, b]`. Anything else is skipped, never guessed.
const fs = require('fs');
const path = require('path');

const unquote = s => String(s).replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
const NAME_KEYS = /^(name|id|system|service|target)$/i;

function parse(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text).replace(/^﻿/, ''));
  if (!m) return { error: 'no YAML front matter (a block between two --- lines at the top)' };
  const lines = m[1].split(/\r?\n/);
  const at = lines.findIndex(l => /^depends_on\s*:/.test(l));
  if (at < 0) return { error: 'the front matter has no depends_on list' };
  const inline = /^depends_on\s*:\s*\[(.*)\]\s*$/.exec(lines[at]);
  if (inline) return { depends_on: inline[1].split(',').map(unquote).filter(Boolean) };
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (/^\S/.test(l)) break; // the next top-level key
    const item = /^\s*-\s+(.*)$/.exec(l);
    if (item) {
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(item[1]);
      const v = unquote(kv ? (NAME_KEYS.test(kv[1]) ? kv[2] : kv[1]) : item[1]); // `- snowflake: why` names snowflake
      if (v) out.push(v);
      continue;
    }
  }
  return { depends_on: out.filter(Boolean) };
}

function read(repo, rel) {
  if (!rel) return null;
  const file = path.resolve(repo, rel);
  if (path.relative(repo, file).startsWith('..') || path.isAbsolute(path.relative(repo, file))) return { file: rel, error: 'the path leaves the repository' };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { file: rel, error: 'the file could not be read' }; }
  return { file: rel, ...parse(text) };
}

module.exports = { parse, read };
