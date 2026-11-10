#!/usr/bin/env node
'use strict';
// designc audit: wraps open-source analyzers, maps their SARIF onto the design's elements. Calls no model.
// docs: "designc health overlay: schema and first slice", section "Audit CLI". The analysed repo is NEVER written to:
// scan works on a copy of the committed tree inside --out.
//
//   audit scan <repo> --out <dir> [--project <sln|csproj>] [--sonar]      findings.sarif
//   audit rollup --sarif <file> --model <registry dir> --out <dir> [--repo <dir>] [--config <file>] [--baseline <file>] [--write-baseline] [--evidence <file>]
//                                                                        health.json
// Exit: 0 done, 2 could not run (bad arguments, no tool output).
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

function scan(argv) {
  const o = parseArgs(argv, ['sonar']);
  const repo = o._[0] && path.resolve(o._[0]);
  if (!repo || !o.out) die('usage: audit scan <repo> --out <dir> [--project <sln|csproj>] [--sonar]');
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  const sha = git('rev-parse', 'HEAD');
  if (sha.status !== 0) die(`${repo} is not a git repository with a commit`);
  const commit = sha.stdout.trim();
  const out = path.resolve(o.out);
  if (out === repo || out.startsWith(repo + path.sep)) die('--out must be outside the analysed repo');
  const work = path.join(out, 'work');
  fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
  // The committed tree, not the working copy: the audit says which commit it is about.
  const ar = spawnSync('bash', ['-c', `git -C "${repo}" archive HEAD | tar -x -C "${work}"`], { encoding: 'utf8' });
  if (ar.status !== 0) die(`could not copy the tree: ${ar.stderr}`);

  const target = o.project ? path.join(work, o.project) : findTarget(work);
  if (!target || !fs.existsSync(target)) die('no .sln or .csproj at the repo root; name one with --project');
  const props = path.join(out, 'audit.targets');
  fs.writeFileSync(props, `<Project>
  <PropertyGroup>
    <ErrorLog>$(MSBuildProjectDirectory)/audit-$(MSBuildProjectName).sarif,version=2.1</ErrorLog>
    <RunAnalyzers>true</RunAnalyzers><EnableNETAnalyzers>true</EnableNETAnalyzers><AnalysisMode>All</AnalysisMode>
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors><EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
  </PropertyGroup>${o.sonar ? `
  <ItemGroup><PackageReference Include="SonarAnalyzer.CSharp" Version="${SONAR_VERSION}" PrivateAssets="all" /></ItemGroup>` : ''}
</Project>
`);
  console.error(`audit: dotnet build ${path.relative(work, target)} (a copy of ${commit.slice(0, 7)} in ${work})`);
  const b = spawnSync('dotnet', ['build', target, '-t:Rebuild', '-nologo', '-v:q', `-p:CustomAfterMicrosoftCommonTargets=${props}`, '-p:TreatWarningsAsErrors=false'],
    { cwd: work, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } });
  const files = walk(work).filter(f => /[\\/]audit-[^\\/]+\.sarif$/.test(f));
  if (!files.length) die(`dotnet produced no SARIF (exit ${b.status}):\n${String(b.stdout + b.stderr).slice(-1500)}`);
  const runs = [];
  for (const f of files.sort()) { try { runs.push(...relativise(JSON.parse(fs.readFileSync(f, 'utf8')), work).runs); } catch (e) { console.error(`audit: skipped unreadable ${f}`); } }
  // one run per tool: projects of one solution all use the same compiler
  const byTool = new Map();
  for (const r of runs) {
    const k = (r.tool && r.tool.driver && r.tool.driver.name) || 'unknown';
    if (!byTool.has(k)) byTool.set(k, r); else byTool.get(k).results.push(...(r.results || []));
  }
  const merged = { version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json', runs: [...byTool.values()] };
  const seen = new Set(); // projects share files, so dedupe again after the merge
  for (const run of merged.runs) run.results = run.results.filter(r => { const l = r.locations && r.locations[0] && r.locations[0].physicalLocation; const k = JSON.stringify([r.ruleId, l && l.artifactLocation && l.artifactLocation.uri, l && l.region, r.message && r.message.text]); if (seen.has(k)) return false; seen.add(k); return true; });
  fs.writeFileSync(path.join(out, 'findings.sarif'), JSON.stringify(merged, null, 1));
  fs.writeFileSync(path.join(out, 'scan.json'), JSON.stringify({ repo: path.basename(repo), commit, tools: Rollup.toolsOf(merged), at: new Date().toISOString() }, null, 2));
  fs.rmSync(work, { recursive: true, force: true });
  const n = merged.runs.reduce((a, r) => a + r.results.length, 0);
  console.error(`audit: ${n} findings from ${merged.runs.length} run(s) -> ${path.join(out, 'findings.sarif')}`);
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

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'scan') scan(rest); else if (cmd === 'rollup') rollup(rest);
  else die('usage: audit <scan|rollup|diff> ...');
}
module.exports = { modelElements, relativise, defaultConfig, parseArgs };
