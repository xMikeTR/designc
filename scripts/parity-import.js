#!/usr/bin/env node
'use strict';
// Drafts parity scenarios (docs/parity-contract.md) from a legacy app's Playwright tests and page objects, outside the
// app. Each test(...) becomes one draft scenario of goto, click, fill and select steps. Only what a scenario can say is
// translated: page.goto with a fixed path and getByRole locators (with .first() or .nth(n)), inline, held in a local
// const, or a page object's property; a page object's method is followed one level, its parameters taken from the call.
// Anything else (getByLabel, getByText, CSS locators, variables as values, loops, helpers) is flagged with its file and
// line, never guessed; assertions are counted and skipped, because parity compares the whole screen.
//   node scripts/parity-import.js --from <legacy tests folder> --registry <dir> [--write] [--json]
// Without --write it only reports. --write creates parity/scenarios/<id>.yaml and never overwrites a scenario.
// Exit: 0 drafted (or nothing to draft), 1 some calls could not be translated, 2 an error.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Parity = require('../renderer/parity.js');

const USAGE = 'usage: parity-import --from <folder> --registry <dir> [--write] [--json]';
const SOURCE = /\.(spec|test|page|po)?\.?[cm]?[jt]sx?$/;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'test-results', 'playwright-report']);

// Comments become spaces (newlines kept, so offsets keep their lines); strings and templates are left as written.
function blank(text) {
  let out = '', i = 0;
  while (i < text.length) {
    const c = text[i], d = text[i + 1];
    if (c === '/' && d === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') { while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { out += text[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      const q = c; out += c; i++;
      while (i < text.length && text[i] !== q) { if (text[i] === '\\') { out += text[i++]; } out += text[i++] || ''; }
      out += text[i] || ''; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

// The index just past the bracket that closes the one at `open`, skipping strings.
function closing(text, open) {
  const pair = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '\'' || c === '"' || c === '`') { const q = c; i++; while (i < text.length && text[i] !== q) { if (text[i] === '\\') i++; i++; } continue; }
    if (pair[c]) stack.push(pair[c]);
    else if (c === ')' || c === '}' || c === ']') { stack.pop(); if (!stack.length) return i + 1; }
  }
  return -1;
}

const lineAt = (text, at) => text.slice(0, at).split('\n').length;

// Statements of a block body at depth 0, split on ; and on line ends that do not continue a chain (.x on the next line).
function statements(body, base) {
  const out = [];
  let start = 0, depth = 0;
  const push = end => { const s = body.slice(start, end).trim(); if (s) out.push({ text: s.replace(/\s*\n\s*(?=[.?])/g, '').replace(/\s*\n\s*/g, ' '), at: base + start + (body.slice(start, end).length - body.slice(start, end).trimStart().length) }); start = end + 1; };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\'' || c === '"' || c === '`') { const q = c; i++; while (i < body.length && body[i] !== q) { if (body[i] === '\\') i++; i++; } continue; }
    if ('({['.includes(c)) depth++;
    else if (')}]'.includes(c)) depth--;
    else if (depth === 0 && c === ';') push(i);
    else if (depth === 0 && c === '\n' && !/^\s*[.?]/.test(body.slice(i + 1)) && !/[=+,(&|?:]\s*$/.test(body.slice(start, i))) push(i);
  }
  push(body.length);
  return out;
}

const STR = /^(['"])((?:\\.|(?!\1).)*)\1$/;
const literal = s => { const t = (s || '').trim(); const m = STR.exec(t) || /^`([^`$]*)`$/.exec(t); if (m) return { ok: true, value: (m[2] !== undefined ? m[2] : m[1]).replace(/\\(.)/g, '$1') }; if (/^-?\d+(\.\d+)?$/.test(t)) return { ok: true, value: Number(t) }; return { ok: false }; };

// "page.getByRole('button', { name: 'Save', exact: true }).nth(1)" (after the receiver) as {role, name, index?}, or a reason.
function roleLocator(expr) {
  const m = /^getByRole\(/.exec(expr);
  if (!m) {
    const other = /^(getBy\w+|locator|frameLocator)\(/.exec(expr);
    return { why: other ? `${other[1]}() is not a role and name; write the step with the element's role` : 'not a locator' };
  }
  const end = closing(expr, 'getByRole'.length);
  const args = expr.slice('getByRole('.length, end - 1);
  const role = /^\s*(['"])(\w+)\1/.exec(args);
  if (!role) return { why: 'getByRole() with a role that is not written out' };
  let name = '';
  const opts = /,\s*\{([\s\S]*)\}\s*$/.exec(args);
  if (opts) {
    const n = /name\s*:\s*([^,}]+)/.exec(opts[1]);
    if (n) { const v = literal(n[1]); if (!v.ok) return { why: `a name that is not written out (${n[1].trim()})` }; name = String(v.value); }
  }
  const out = { role: role[2], name };
  const rest = expr.slice(end);
  const nth = /^\.(first\(\)|nth\((\d+)\))/.exec(rest);
  if (nth) out.index = nth[2] ? Number(nth[2]) : 0;
  else if (/^\.last\(\)/.test(rest)) return { why: '.last() depends on how many there are; use .nth(n)' };
  const after = nth ? rest.slice(nth[0].length) : rest;
  return { loc: out, rest: after };
}

// Page object classes: {Name: {props: {prop: locatorOrWhy}, methods: {name: {params, body, at, file, text}}}}.
function pageObjects(files) {
  const classes = {};
  for (const f of files) {
    const text = blank(f.text);
    const re = /class\s+(\w+)[^{]*\{/g;
    let m;
    while ((m = re.exec(text))) {
      const open = m.index + m[0].length - 1, end = closing(text, open);
      if (end < 0) continue;
      const body = text.slice(open + 1, end - 1), base = open + 1;
      const c = classes[m[1]] = { props: {}, methods: {} };
      const prop = /(?:this\.)?(\w+)\s*(?::\s*Locator\s*)?=\s*(?:this\.)?page\.([^;\n]+)/g;
      let p;
      while ((p = prop.exec(body))) { const r = roleLocator(p[2].trim()); c.props[p[1]] = r.loc && !r.rest.trim() ? r.loc : { why: r.why || 'a locator chain that is not a role and name' }; }
      const getter = /get\s+(\w+)\s*\(\)\s*(?::\s*\w+\s*)?\{\s*return\s+(?:this\.)?page\.([^;}]+)/g;
      while ((p = getter.exec(body))) { const r = roleLocator(p[2].trim()); c.props[p[1]] = r.loc && !r.rest.trim() ? r.loc : { why: r.why || 'a locator chain that is not a role and name' }; }
      const method = /(?:async\s+)(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\{/g;
      while ((p = method.exec(body))) {
        const o = p.index + p[0].length - 1, e = closing(body, o);
        if (e < 0) continue;
        c.methods[p[1]] = { params: p[2].split(',').map(s => s.replace(/[:=].*$/, '').replace(/[?\s]/g, '')).filter(Boolean), body: body.slice(o + 1, e - 1), at: base + o + 1, file: f.path, text };
        method.lastIndex = e;
      }
    }
  }
  return classes;
}

// One statement as steps, or a flag. `scope` holds local locator consts, page object variables and parameter values.
function translate(st, scope, classes, depth) {
  let s = st.text.replace(/^await\s+/, '').replace(/;$/, '').trim();
  if (/^(expect|test\.expect)\b/.test(s) || /^await\s+expect\b/.test(st.text)) return { assertion: true };
  for (const [k, v] of Object.entries(scope.values)) s = s.replace(new RegExp(`(?<![.\\w$])${k}\\b`, 'g'), v);
  const decl = /^(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?([\s\S]+)$/.exec(s);
  if (decl) {
    const rhs = decl[2];
    const po = /^new\s+(\w+)\s*\(/.exec(rhs);
    if (po && classes[po[1]]) { scope.objects[decl[1]] = po[1]; return { steps: [] }; }
    const pl = /^(?:this\.)?page\.(.+)$/.exec(rhs);
    if (pl) { const r = roleLocator(pl[1]); if (r.loc && !r.rest.trim()) { scope.locators[decl[1]] = r.loc; return { steps: [] }; } return { why: r.why || 'a locator chain that is not a role and name' }; }
    return { why: 'a value worked out in the test; a scenario holds steps only' };
  }
  const go = /^(?:this\.)?page\.goto\(([^,)]+)/.exec(s);
  if (go) {
    const v = literal(go[1]);
    if (!v.ok) return { why: 'goto with a path that is not written out' };
    let p = String(v.value);
    if (/^https?:/i.test(p)) { try { const u = new URL(p); p = u.pathname + u.search; } catch { return { why: 'goto with a URL that does not parse' }; } }
    return { steps: [{ goto: { path: p || '/' } }] };
  }
  const act = /^([\s\S]+)\.(click|fill|selectOption)\(([\s\S]*)\)$/.exec(s);
  if (act) {
    const [, target, verb, arg] = act;
    let loc = null, why = null;
    const inline = /^(?:this\.)?page\.(getBy[\s\S]+|locator[\s\S]+)$/.exec(target);
    const member = /^(?:this|(\w+))\.(\w+)(\.(?:first\(\)|nth\(\d+\)))?$/.exec(target);
    if (inline) { const r = roleLocator(inline[1]); if (r.loc && !r.rest.trim()) loc = r.loc; else why = r.why || 'a locator chain that is not a role and name'; }
    else if (scope.locators[target]) loc = scope.locators[target];
    else if (member) {
      const cls = member[1] ? scope.objects[member[1]] : scope.self;
      let found = cls ? classes[cls] && classes[cls].props[member[2]] : null;
      if (!cls) { const hits = Object.values(classes).map(c => c.props[member[2]]).filter(Boolean); if (hits.length === 1) found = hits[0]; else if (hits.length > 1) why = `${member[2]} is a property of more than one page object`; }
      if (found && found.why) why = found.why;
      else if (found) { loc = { ...found }; if (member[3]) loc.index = /first/.test(member[3]) ? 0 : Number(/\d+/.exec(member[3])[0]); }
    }
    if (!loc) return { why: why || `${target} is not a locator the importer can see` };
    const k = verb === 'selectOption' ? 'select' : verb;
    const a = { role: loc.role, name: loc.name };
    if (loc.index) a.index = loc.index;
    if (k !== 'click') {
      const v = literal(arg.replace(/^\{\s*(?:label|value)\s*:\s*([^}]+)\}$/, '$1'));
      if (!v.ok) return { why: `${verb} with a value that is not written out; give it as a param` };
      a.value = v.value;
    }
    return { steps: [{ [k]: a }] };
  }
  const call = /^(?:this|(\w+))\.(\w+)\(([\s\S]*)\)$/.exec(s);
  if (call && depth < 1) {
    const cls = call[1] ? scope.objects[call[1]] : scope.self;
    const named = cls ? [cls] : Object.keys(classes).filter(n => classes[n].methods[call[2]]);
    const m = named.length === 1 && classes[named[0]] && classes[named[0]].methods[call[2]];
    if (m) {
      const args = splitArgs(call[3]);
      const values = {};
      m.params.forEach((p, i) => { if (args[i] !== undefined) values[p] = args[i]; });
      const inner = { locators: {}, objects: {}, values, self: named[0] };
      const steps = [], flags = [];
      for (const x of statements(m.body, m.at)) {
        const r = translate(x, inner, classes, depth + 1);
        if (r.steps) steps.push(...r.steps); else if (r.why) flags.push({ file: m.file, line: lineAt(m.text, x.at), text: x.text, why: r.why });
      }
      return { steps, flags };
    }
  }
  return { why: 'not a goto, click, fill or select the importer can translate' };
}

const splitArgs = s => { const out = []; let start = 0, depth = 0; for (let i = 0; i < s.length; i++) { const c = s[i]; if (c === '\'' || c === '"' || c === '`') { const q = c; i++; while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; } continue; } if ('({['.includes(c)) depth++; else if (')}]'.includes(c)) depth--; else if (c === ',' && !depth) { out.push(s.slice(start, i).trim()); start = i + 1; } } if (s.trim()) out.push(s.slice(start).trim()); return out; };

const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'scenario';

// Every test(...) in the files as a draft: {id, title, file, line, steps, flags[], assertions}.
function drafts(files, { taken = [] } = {}) {
  const classes = pageObjects(files);
  const used = new Set(taken);
  const out = [];
  for (const f of files) {
    const text = blank(f.text);
    const re = /\btest(?:\.(?:only|skip|fixme|fail|slow))?\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*,\s*(?:\{[^}]*\}\s*,\s*)?async\s*\(([^)]*)\)\s*=>\s*\{/g;
    let m;
    while ((m = re.exec(text))) {
      const open = m.index + m[0].length - 1, end = closing(text, open);
      if (end < 0) continue;
      const title = m[2];
      let id = slug(title);
      for (let n = 2; used.has(id); n++) id = `${slug(title).slice(0, 44)}-${n}`;
      used.add(id);
      const scope = { locators: {}, objects: {}, values: {}, self: null };
      const steps = [], flags = [];
      let assertions = 0;
      for (const st of statements(text.slice(open + 1, end - 1), open + 1)) {
        const r = translate(st, scope, classes, 0);
        if (r.assertion) assertions++;
        else if (r.why) flags.push({ file: f.path, line: lineAt(text, st.at), text: st.text, why: r.why });
        else { steps.push(...r.steps); flags.push(...(r.flags || [])); }
      }
      out.push({ id, title, file: f.path, line: lineAt(text, m.index), steps, flags, assertions });
      re.lastIndex = end;
    }
  }
  return out;
}

// The draft as a scenario file: a comment saying where it came from and what was not translated, then the scenario.
function toYaml(d) {
  const head = [`# Drafted by scripts/parity-import.js from ${d.file}:${d.line}. Check it before recording a baseline.`];
  if (d.assertions) head.push(`# ${d.assertions} assertion${d.assertions === 1 ? '' : 's'} skipped: parity compares the whole screen.`);
  for (const f of d.flags) head.push(`# not translated: ${f.file}:${f.line} ${f.text.slice(0, 100)} (${f.why})`);
  head.push('# Values are as the legacy test wrote them; move any that differ between the apps to params.');
  return `${head.join('\n')}\n${yaml.dump({ id: d.id, title: d.title, steps: d.steps }, { lineWidth: 120, flowLevel: 2 })}`;
}

function walk(dir, root = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, root, out);
    else if (SOURCE.test(e.name) && !e.name.endsWith('.d.ts') && fs.statSync(p).size <= 1024 * 1024) out.push({ path: path.relative(root, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
  }
  return out;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from' || a === '--registry') { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${a} needs a value`); o[a.slice(2)] = argv[++i]; }
    else if (a === '--write') o.write = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.help) for (const k of ['from', 'registry']) if (!o[k]) throw new Error(`--${k} is required`);
  return o;
}

function main(argv, { log = s => process.stdout.write(s + '\n'), err = s => process.stderr.write(s + '\n') } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  if (o.help) { log(USAGE); return 0; }
  if (!fs.existsSync(o.from) || !fs.statSync(o.from).isDirectory()) { err(`no folder ${o.from}`); return 2; }
  if (!fs.existsSync(o.registry)) { err(`no folder ${o.registry}`); return 2; }
  const dir = path.join(o.registry, 'parity', 'scenarios');
  const existing = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).map(f => f.replace(/\.ya?ml$/, '')) : [];
  const all = drafts(walk(o.from));
  const results = all.map(d => {
    const r = { id: d.id, title: d.title, from: `${d.file}:${d.line}`, steps: d.steps.length, assertions: d.assertions, flags: d.flags, problems: d.steps.length ? Parity.scenarioProblems({ id: d.id, steps: d.steps }) : ['no step could be translated'] };
    if (existing.includes(d.id)) r.status = 'exists, not overwritten';
    else if (!o.write) r.status = 'would write';
    else if (!d.steps.length) r.status = 'not written: no steps';
    else { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${d.id}.yaml`), toYaml(d), { flag: 'wx' }); r.status = 'written'; }
    return r;
  });
  if (o.json) log(JSON.stringify(results, null, 2));
  else {
    if (!results.length) log(`no test(...) found under ${o.from}`);
    for (const r of results) {
      log(`${r.id}: ${r.status} (${r.steps} steps from ${r.from}${r.assertions ? `, ${r.assertions} assertions skipped` : ''}${r.flags.length ? `, ${r.flags.length} not translated` : ''})`);
      for (const f of r.flags) log(`  ${f.file}:${f.line} ${f.why}`);
      for (const p of r.problems) log(`  problem: ${p}`);
    }
  }
  return results.some(r => r.flags.length || r.problems.length) ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, drafts, pageObjects, toYaml, roleLocator, statements, blank };
