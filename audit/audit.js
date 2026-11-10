#!/usr/bin/env node
'use strict';
// designc audit: wraps open-source analyzers, maps their SARIF onto the design's elements. Calls no model.
// docs: "designc health overlay: schema and first slice", section "Audit CLI". The analysed repo is NEVER written to:
// scan works on a copy of the committed tree inside --out.
//
//   audit scan <repo> --out <dir> [--project <sln|csproj>] [--tools dotnet,eslint,jscpd,knip] [--sonar]      findings.sarif
//   audit rollup --sarif <file> --model <registry dir> --out <dir> [--repo <dir>] [--config <file>] [--baseline <file>] [--write-baseline] [--evidence <file>]
//                                                                        health.json
//   audit record --out <dir> --element <id> --property <idempotent|cached> --by <check name> --result <pass|fail> [--repo <dir>]
//                                                                        appends a `check` to <dir>/evidence.json, stamped with the repo's HEAD
//   audit diff <repo> --base <ref> [--project ...] [--tools ...]            SARIF of findings new since <ref>, on stdout
// Exit: 0 done (diff: no new findings), 1 (diff only) new findings, 2 could not run (bad arguments, no tool output).
// Analyzers: dotnet's own (a build of the copy), and eslint/jscpd/knip from audit/tools, installed once into ~/.cache/designc-audit.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const HealthMap = require('../renderer/health-map.js');
const Rollup = require('./rollup.js');

const SONAR_VERSION = '10.6.0.109712'; // SonarAnalyzer.CSharp; confirm against nuget.org before bumping

const die = msg => { console.error(`audit: ${msg}`); process.exit(2); };
const readJson = (p, what) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { die(`cannot read ${what} ${p}: ${e.message}`); } };

function parseArgs(argv, flags = []) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); if (flags.includes(k)) o[k] = true; else { if (argv[i + 1] === undefined) die(`--${k} needs a value`); o[k] = argv[++i]; } }
    else o._.push(a);
  }
  return o;
}

// Rewrite every result uri to repo-relative (forward slashes) and drop duplicates (one per project/target framework).
function relativise(sarif, root) {
  const seen = new Set();
  for (const run of sarif.runs || []) {
    run.results = (run.results || []).filter(r => {
      const loc = r.locations && r.locations[0] && r.locations[0].physicalLocation;
      if (!loc || !loc.artifactLocation) return true;
      // sonarjs puts a JSON blob in some messages; the readable text is its "message"
      if (r.message && typeof r.message.text === 'string' && r.message.text.startsWith('{')) { try { r.message.text = JSON.parse(r.message.text).message || r.message.text; } catch { /* keep */ } }
      const rel = HealthMap.normaliseUri(loc.artifactLocation.uri, root);
      if (rel !== null) loc.artifactLocation.uri = rel;
      const key = [r.ruleId, loc.artifactLocation.uri, loc.region && loc.region.startLine, loc.region && loc.region.startColumn, r.message && r.message.text].join('|');
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    run.artifacts = undefined; // large, and not read by anything here
  }
  return sarif;
}

// ---- producers -------------------------------------------------------------------------------------------------
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const gitIn = (repo, ...a) => run('git', ['-C', repo, ...a]);

// The tree to analyse, copied under `dest`. ref: a commit-ish (its committed tree), or null (the working copy:
// tracked and untracked-but-not-ignored files, so an uncommitted change is seen). The repo itself is only read.
function materialize(repo, ref, dest) {
  fs.rmSync(dest, { recursive: true, force: true }); fs.mkdirSync(dest, { recursive: true });
  const cmd = ref
    ? `git -C "${repo}" archive "${ref}" | tar -x -C "${dest}"`
    : `git -C "${repo}" ls-files -z --cached --others --exclude-standard | tar -c -C "${repo}" --null --ignore-failed-read -T - | tar -x -C "${dest}"`;
  const r = run('bash', ['-c', cmd]);
  if (r.status !== 0) die(`could not copy the tree${ref ? ` at ${ref}` : ''}: ${r.stderr}`);
}

// The analyzers live in one cache dir outside every repo; `npm ci --ignore-scripts` from audit/tools' lockfile.
function toolsDir() {
  const dir = process.env.DESIGNC_AUDIT_TOOLS || path.join(process.env.XDG_CACHE_HOME || path.join(require('os').homedir(), '.cache'), 'designc-audit', 'tools');
  const src = path.join(__dirname, 'tools');
  const stamp = ['package.json', 'package-lock.json'].map(f => fs.readFileSync(path.join(src, f), 'utf8')).join('\n');
  const marker = path.join(dir, '.installed');
  const current = fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === stamp;
  if (!current) {
    console.error('audit: installing analyzers (needs the network, once) into ' + dir);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['package.json', 'package-lock.json', 'eslint.config.mjs']) fs.copyFileSync(path.join(src, f), path.join(dir, f));
    const r = run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir });
    if (r.status !== 0) die(`could not install the analyzers:\n${String(r.stderr).slice(-1200)}`);
    fs.writeFileSync(marker, stamp);
  } else fs.copyFileSync(path.join(src, 'eslint.config.mjs'), path.join(dir, 'eslint.config.mjs'));
  return dir;
}

function dotnetRuns(work, o) {
  const target = o.project ? path.join(work, o.project) : findTarget(work);
  if (!target || !fs.existsSync(target)) die('no .sln or .csproj at the repo root; name one with --project');
  const props = path.join(work, '..', 'audit.targets');
  fs.writeFileSync(props, `<Project>
  <PropertyGroup>
    <ErrorLog>$(MSBuildProjectDirectory)/audit-$(MSBuildProjectName).sarif,version=2.1</ErrorLog>
    <RunAnalyzers>true</RunAnalyzers><EnableNETAnalyzers>true</EnableNETAnalyzers><AnalysisMode>All</AnalysisMode>
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors><EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
  </PropertyGroup>${o.sonar ? `
  <ItemGroup Condition="'$(ManagePackageVersionsCentrally)' == 'true'"><PackageVersion Include="SonarAnalyzer.CSharp" Version="${SONAR_VERSION}" /></ItemGroup>
  <ItemGroup Condition="'$(ManagePackageVersionsCentrally)' == 'true'"><PackageReference Include="SonarAnalyzer.CSharp" PrivateAssets="all" /></ItemGroup>
  <ItemGroup Condition="'$(ManagePackageVersionsCentrally)' != 'true'"><PackageReference Include="SonarAnalyzer.CSharp" Version="${SONAR_VERSION}" PrivateAssets="all" /></ItemGroup>` : ''}
</Project>
`);
  console.error(`audit: dotnet build ${path.relative(work, target)}`);
  const b = run('dotnet', ['build', target, '-t:Rebuild', '-nologo', '-v:q', `-p:CustomAfterMicrosoftCommonTargets=${props}`, '-p:TreatWarningsAsErrors=false'],
    { cwd: work, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } });
  const files = walk(work).filter(f => /[\\/]audit-[^\\/]+\.sarif$/.test(f)).sort();
  if (!files.length) die(`dotnet produced no SARIF (exit ${b.status}):\n${String(b.stdout + b.stderr).slice(-1500)}`);
  const runs = [];
  for (const f of files) { try { runs.push(...JSON.parse(fs.readFileSync(f, 'utf8')).runs); } catch { console.error(`audit: skipped unreadable ${path.basename(f)}`); } }
  return runs;
}

function eslintRuns(work, tools, out) {
  console.error('audit: eslint (typescript-eslint parser, sonarjs rules)');
  const sarif = path.join(out, 'eslint.sarif');
  run(path.join(tools, 'node_modules/.bin/eslint'), ['-c', path.join(tools, 'eslint.config.mjs'), '-f', path.join(tools, 'node_modules/@microsoft/eslint-formatter-sarif/sarif.js'), '-o', sarif, '.'], { cwd: work });
  if (!fs.existsSync(sarif)) die('eslint produced no SARIF');
  return JSON.parse(fs.readFileSync(sarif, 'utf8')).runs;
}

function jscpdRuns(work, tools, out) {
  console.error('audit: jscpd');
  const dir = path.join(out, 'jscpd');
  run(path.join(tools, 'node_modules/.bin/jscpd'), ['--reporters', 'sarif', '--output', dir, '--min-lines', '10', '--silent', '--ignore', '**/node_modules/**,**/dist/**,**/build/**,**/bin/**,**/obj/**', '.'], { cwd: work });
  const f = path.join(dir, 'jscpd-report.sarif');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).runs : [];
}

// knip's JSON has no SARIF route; convert unused files and exports (dependencies need the repo's node_modules, so they are left out).
function knipRuns(work, tools) {
  console.error('audit: knip (unused files and exports)');
  const r = run(path.join(tools, 'node_modules/.bin/knip'), ['--reporter', 'json', '--include', 'files,exports,types', '--no-progress'], { cwd: work });
  let j; try { j = JSON.parse(r.stdout); } catch { console.error('audit: knip printed no JSON; skipped'); return []; }
  const results = [];
  const at = (rule, file, text, line) => results.push({ ruleId: rule, level: 'warning', message: { text }, locations: [{ physicalLocation: { artifactLocation: { uri: file }, ...(line ? { region: { startLine: line } } : {}) } }] });
  for (const i of j.issues || []) {
    for (const f of i.files || []) at('knip/files', i.file, `Unused file ${f.name}`);
    for (const e of [...(i.exports || []), ...(i.types || [])]) at('knip/exports', i.file, `Unused export ${e.name}`, e.line);
  }
  return [{ tool: { driver: { name: 'knip' } }, results }];
}

// Give every result an identity that survives moved code: rule + path + hash of the code around it (the spec's fingerprint).
function stamp(sarif, work) {
  const cache = new Map();
  const lines = p => { if (!cache.has(p)) { try { cache.set(p, fs.readFileSync(path.join(work, p), 'utf8').split('\n')); } catch { cache.set(p, null); } } return cache.get(p); };
  for (const run of sarif.runs) for (const r of run.results) {
    const l = r.locations && r.locations[0] && r.locations[0].physicalLocation;
    const p = l && l.artifactLocation && HealthMap.normaliseUri(l.artifactLocation.uri, work);
    if (!p) continue;
    const ls = lines(p), i = ((l.region && l.region.startLine) || 1) - 1;
    const ctx = ls ? ls.slice(Math.max(0, i - 2), i + 3).join('\n') : undefined;
    r.partialFingerprints = { ...(r.partialFingerprints || {}), 'auditContext/v1': HealthMap.fingerprint({ ruleId: r.ruleId, message: r.message }, p, ctx).split('|').slice(1).join('|') };
  }
  return sarif;
}

// Analyse one materialised tree: the requested tools, merged into one SARIF log with repo-relative uris.
function scanTree(work, out, o) {
  const has = f => fs.existsSync(path.join(work, f));
  const want = o.tools ? o.tools.split(',') : [...(findTarget(work) || o.project ? ['dotnet'] : []), ...(has('package.json') ? ['eslint', 'jscpd', 'knip'] : [])];
  if (!want.length) die('nothing to analyse: no .sln/.csproj and no package.json (see --tools)');
  fs.mkdirSync(out, { recursive: true });
  const tools = want.some(t => t !== 'dotnet') ? toolsDir() : null;
  let runs = [];
  for (const t of want) {
    if (t === 'dotnet') runs.push(...dotnetRuns(work, o));
    else if (t === 'eslint') runs.push(...eslintRuns(work, tools, out));
    else if (t === 'jscpd') runs.push(...jscpdRuns(work, tools, out));
    else if (t === 'knip') runs.push(...knipRuns(work, tools));
    else die(`unknown tool ${t} (dotnet, eslint, jscpd, knip)`);
  }
  runs = relativise({ runs }, work).runs;
  const byTool = new Map(); // one run per tool: projects of one solution share a compiler
  for (const r of runs) { const k = (r.tool && r.tool.driver && r.tool.driver.name) || 'unknown'; if (!byTool.has(k)) byTool.set(k, r); else byTool.get(k).results.push(...(r.results || [])); }
  const merged = { version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json', runs: [...byTool.values()] };
  const seen = new Set(); // projects share files, so dedupe again after the merge
  for (const run of merged.runs) run.results = run.results.filter(r => { const l = r.locations && r.locations[0] && r.locations[0].physicalLocation; const k = JSON.stringify([r.ruleId, l && l.artifactLocation && l.artifactLocation.uri, l && l.region, r.message && r.message.text]); if (seen.has(k)) return false; seen.add(k); return true; });
  return stamp(merged, work);
}

function repoArg(o, usage) {
  const repo = o._[0] && path.resolve(o._[0]);
  if (!repo) die(usage);
  const r = gitIn(repo, 'rev-parse', 'HEAD');
  if (r.status !== 0) die(`${repo} is not a git repository with a commit`);
  return { repo, commit: r.stdout.trim() };
}
const outside = (out, repo) => { if (out === repo || out.startsWith(repo + path.sep)) die('--out must be outside the analysed repo'); };

function scan(argv) {
  const o = parseArgs(argv, ['sonar']);
  if (!o.out) die('usage: audit scan <repo> --out <dir> [--project <sln|csproj>] [--tools dotnet,eslint,jscpd,knip] [--sonar]');
  const { repo, commit } = repoArg(o, 'usage: audit scan <repo> --out <dir>');
  const out = path.resolve(o.out); outside(out, repo);
  const work = path.join(out, 'work');
  materialize(repo, commit, work); // the committed tree: the audit says which commit it is about
  const merged = scanTree(work, out, o);
  fs.writeFileSync(path.join(out, 'findings.sarif'), JSON.stringify(merged, null, 1));
  fs.writeFileSync(path.join(out, 'scan.json'), JSON.stringify({ repo: path.basename(repo), commit, tools: Rollup.toolsOf(merged), at: new Date().toISOString() }, null, 2));
  fs.rmSync(work, { recursive: true, force: true });
  const n = merged.runs.reduce((a, r) => a + r.results.length, 0);
  console.error(`audit: ${n} findings from ${merged.runs.length} run(s) -> ${path.join(out, 'findings.sarif')}`);
}

/* diff: the findings in the working copy that the base ref does not have. SARIF of just those on stdout, each named on
   stderr; exit 1 if there are any. A finding is the same finding when rule, path and the code around it match, so a
   moved block is not new; a second identical smell next to the first is (counted, not set-compared). */
function diff(argv) {
  const o = parseArgs(argv, ['sonar']);
  if (!o.base) die('usage: audit diff <repo> --base <ref> [--project <sln|csproj>] [--tools ...]');
  const { repo } = repoArg(o, 'usage: audit diff <repo> --base <ref>');
  if (gitIn(repo, 'rev-parse', '--verify', '--quiet', `${o.base}^{commit}`).status !== 0) die(`no such ref: ${o.base}`);
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'audit-diff-'));
  try {
    const side = (name, ref) => { const w = path.join(tmp, name, 'src'); materialize(repo, ref, w); return scanTree(w, path.join(tmp, name, 'out'), o); };
    console.error(`audit: base ${o.base}`); const base = side('base', o.base);
    console.error('audit: working copy'); const head = side('head', null);
    const PP = require('../renderer/pathpattern.js');
    const excl = defaultConfig().exclude;
    const key = r => `${r.ruleId}|${(r.partialFingerprints || {})['auditContext/v1']}`;
    const left = new Map();
    for (const run of base.runs) for (const r of run.results) left.set(key(r), (left.get(key(r)) || 0) + 1);
    const fresh = { version: '2.1.0', runs: [] };
    const named = [];
    for (const run of head.runs) {
      const keep = [];
      for (const r of run.results) {
        const l = r.locations && r.locations[0] && r.locations[0].physicalLocation;
        const p = l && l.artifactLocation && l.artifactLocation.uri;
        if (p && excl.some(g => PP.matches(g, p))) continue;
        const n = left.get(key(r)) || 0;
        if (n > 0) { left.set(key(r), n - 1); continue; }
        keep.push(r); named.push(`${p || '?'}${l && l.region ? ':' + l.region.startLine : ''}  ${r.ruleId}  ${r.message && r.message.text}`);
      }
      if (keep.length) fresh.runs.push({ ...run, results: keep });
    }
    process.stdout.write(JSON.stringify(fresh, null, 1) + '\n');
    if (named.length) { console.error(`audit: ${named.length} new finding(s) since ${o.base}:\n  ${named.join('\n  ')}`); process.exitCode = 1; }
    else console.error(`audit: no new findings since ${o.base}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function findTarget(dir) {
  const names = fs.readdirSync(dir);
  const pick = ext => names.filter(n => n.endsWith(ext)).sort()[0];
  const n = pick('.sln') || pick('.slnx') || pick('.csproj');
  return n ? path.join(dir, n) : null;
}
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

// Elements of the design model with the paths from d.code, ids as hierarchical labels (the key the overlay joins on).
function modelElements(dir) {
  const reg = require('../headless').open(dir);
  const m = reg.model;
  if (!m) die(`no design model in ${dir}`);
  const out = [];
  for (const [id, e] of m.elements) {
    const raw = e.props && e.props['d.code'];
    const dst = new Set(m.rels.filter(r => r.src === id).map(r => r.dst));
    // an edge to a database, or to a system outside this one, is where a cache could pay off
    const external = [...dst].some(d => { const t = m.elements.get(d); return t && (t.tags.has('Database') || (t.kind === 'softwareSystem' && t.id !== e.parent)); });
    out.push({ id: m.label(id), kind: e.kind, parent: e.parent ? m.label(e.parent) : undefined,
      paths: raw ? String(raw).split(',').map(s => s.trim()).filter(Boolean) : [], externalRead: external });
  }
  return out;
}

function rollup(argv) {
  const o = parseArgs(argv, ['write-baseline']);
  if (!o.sarif || !o.model || !o.out) die('usage: audit rollup --sarif <file> --model <registry dir> --out <dir> [--repo <dir>] [--config <file>] [--baseline <file>] [--write-baseline] [--evidence <file>]');
  const sarif = readJson(o.sarif, 'SARIF');
  const out = path.resolve(o.out); fs.mkdirSync(out, { recursive: true });
  const config = o.config ? readJson(o.config, 'config') : defaultConfig();
  const baselineFile = o.baseline || path.join(out, 'baseline.json');
  const baseline = fs.existsSync(baselineFile) ? readJson(baselineFile, 'baseline') : undefined;
  const evFile = o.evidence || path.join(out, 'evidence.json');
  const evidence = fs.existsSync(evFile) ? readJson(evFile, 'evidence') : {};
  const scanInfo = fs.existsSync(path.join(out, 'scan.json')) ? readJson(path.join(out, 'scan.json'), 'scan.json') : {};
  const repoDir = o.repo && path.resolve(o.repo);
  const readContext = repoDir ? (p, line) => { // ±2 lines around the finding, read from the repo, never written
    try { const ls = fs.readFileSync(path.join(repoDir, p), 'utf8').split('\n'); const i = (line || 1) - 1; return ls.slice(Math.max(0, i - 2), i + 3).join('\n'); } catch { return undefined; }
  } : undefined;
  const { health, mapped } = Rollup.build({
    sarif, elements: modelElements(path.resolve(o.model)), config, baseline, evidence, readContext,
    repo: { name: scanInfo.repo || (repoDir ? path.basename(repoDir) : 'unknown'), commit: (scanInfo.commit || '').slice(0, 7) || undefined },
    sources: Rollup.toolsOf(sarif).map(t => ({ tool: t, sarif: path.basename(o.sarif) })),
  });
  fs.writeFileSync(path.join(out, 'health.json'), JSON.stringify(health, null, 2) + '\n');
  if (o['write-baseline']) fs.writeFileSync(path.join(out, 'baseline.json'), JSON.stringify([...new Set(mapped.map(m => m.fingerprint))].sort(), null, 1));
  console.error(`audit: health.json: ${Object.keys(health.elements).length} elements, ${mapped.length} findings mapped, ${health.unmapped.findings} unmapped`);
}

// Excludes and the rule-prefix table (spec step 6 of the mapping). A starter list; unlisted rules are smells.
function defaultConfig() {
  return {
    exclude: ['**/bin/**', '**/obj/**', '**/node_modules/**', '**/*.g.cs', '**/*.Designer.cs', '**/Migrations/**'],
    categories: [
      { prefix: 'CA2100', category: 'security' }, { prefix: 'CA3', category: 'security' }, { prefix: 'CA5', category: 'security' }, { prefix: 'S2068', category: 'security' }, { prefix: 'S5', category: 'security' },
      { prefix: 'IDE0051', category: 'dead-code' }, { prefix: 'IDE0052', category: 'dead-code' }, { prefix: 'IDE0059', category: 'dead-code' }, { prefix: 'CS8019', category: 'dead-code' }, { prefix: 'S1144', category: 'dead-code' }, { prefix: 'S1481', category: 'dead-code' },
      { prefix: 'S1172', category: 'dead-code' }, { prefix: 'jscpd', category: 'duplication' }, { prefix: 'knip', category: 'dead-code' },
    ],
  };
}

// Only an executable check may call this: the evidence it writes is what the status model reads as `verified`.
function record(argv) {
  const o = parseArgs(argv);
  if (!o.out || !o.element || !o.property || !o.by || !['pass', 'fail'].includes(o.result)) die('usage: audit record --out <dir> --element <id> --property <name> --by <check> --result <pass|fail> [--repo <dir>]');
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(o.repo || '.'), encoding: 'utf8' });
  if (git.status !== 0) die(`${o.repo || '.'} is not a git repo with a commit: a check must be tied to a commit`);
  const f = path.join(path.resolve(o.out), 'evidence.json');
  const all = fs.existsSync(f) ? readJson(f, 'evidence') : {};
  const list = ((all[o.element] = all[o.element] || {})[o.property] = all[o.element][o.property] || []);
  // one current entry per check name: a re-run replaces the earlier result
  const i = list.findIndex(e => e.kind === 'check' && e.by === o.by);
  const entry = { kind: 'check', by: o.by, result: o.result, commit: git.stdout.trim() };
  if (i >= 0) list[i] = entry; else list.push(entry);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(all, null, 2) + '\n');
  console.log(`${o.element}.${o.property}: ${o.result} by ${o.by} @ ${entry.commit.slice(0, 12)}`);
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'scan') scan(rest); else if (cmd === 'rollup') rollup(rest); else if (cmd === 'diff') diff(rest); else if (cmd === 'record') record(rest);
  else die('usage: audit <scan|rollup|diff|record> ...');
}
module.exports = { modelElements, stamp, relativise, defaultConfig, parseArgs };
