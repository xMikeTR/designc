#!/usr/bin/env node
'use strict';
// Feature journey runner CLI (docs/feature-map-contract.md, Runner). Runs a registry's features/*.yaml journeys, one run per
// journey x entry point, on a live app through an adapter, after the ready probe (designc.json verify.ready).
// Prints one result per feature: {feature, outcome, journeys: [{journey, entry, outcome, failures}]}, the feature_result row
// without kind, commit or by. It writes no ledger and never writes into the registry; --out <dir> keeps the final capture
// (.json) and screenshot (.png) of each run, outside it.
//
// Exit: 0 pass, 1 a journey failed, 2 an error (nothing judged), 3 a journey could not run (none failed).
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const FeatureMap = require('../renderer/featuremap.js');
const Journey = require('../recorder/journey.js');

const USAGE = `usage: feature-run --registry <dir> --feature <id|all> [--journey <id>]
       [--adapter web|fixture:<file.json>] [--base-url <url>] [--param name=value]...
       [--allow-writes] [--out <dir>] [--json]`;

function parseArgs(argv) {
  const o = { params: {}, adapter: 'web' };
  const value = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  const flags = { '--registry': 'registry', '--feature': 'feature', '--journey': 'journey', '--adapter': 'adapter', '--base-url': 'baseUrl', '--out': 'out' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags[a]) { o[flags[a]] = value(i, a); i++; }
    else if (a === '--param') {
      const kv = value(i, a); i++;
      const eq = kv.indexOf('=');
      if (eq < 1) throw new Error(`--param needs name=value, got "${kv}"`);
      o.params[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === '--allow-writes') o.allowWrites = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.help) return o;
  for (const k of ['registry', 'feature']) if (!o[k]) throw new Error(`--${k} is required`);
  return o;
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function makeAdapter(spec) {
  if (spec === 'web') return require('../recorder/adapters/web.js').create('web');
  if (spec.startsWith('fixture:')) return require('../recorder/adapters/fixture.js').create(path.resolve(spec.slice(8)));
  throw new Error(`unknown adapter ${spec}: use web or fixture:<file.json>`);
}

// Every features/*.yaml with what stops it running: it does not parse, or FeatureMap.problems (no ctx) finds any.
function loadFeatures(registry) {
  const dir = path.join(registry, 'features');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort().map(f => {
    const rel = path.posix.join('features', f);
    const parsed = FeatureMap.parseFile(rel, fs.readFileSync(path.join(dir, f), 'utf8'), yaml.load);
    if (!parsed.record) return { rel, problems: parsed.errors.map(e => e.msg) };
    const record = parsed.record;
    const problems = FeatureMap.problems([{ path: rel, record }], {}).map(p => `${p.code} ${p.msg}`);
    return { rel, id: typeof record.id === 'string' ? record.id : FeatureMap.baseName(rel), record, problems };
  });
}

const safe = s => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
const inside = (parent, child) => { const r = path.relative(path.resolve(parent), path.resolve(child)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

function writeEvidence(out, res) {
  for (const j of res.journeys) {
    if (!j.capture) continue;
    const dir = path.join(out, safe(res.feature));
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `${safe(j.journey)}--${safe(j.entry || 'none')}`);
    fs.writeFileSync(`${base}.json`, JSON.stringify(j.capture, null, 2) + '\n');
    if (j.shot && res.shots[j.shot]) fs.writeFileSync(`${base}.png`, res.shots[j.shot]);
  }
}

function describe(r) {
  const lines = [`${r.feature}: ${r.outcome.replace(/_/g, ' ')}`];
  for (const j of r.journeys) {
    lines.push(`  ${j.journey} via ${j.entry || 'no entry point'}: ${j.outcome.replace(/_/g, ' ')}`);
    for (const f of j.failures) lines.push(`    step ${f.step} ${f.kind}: ${f.msg}`);
  }
  return lines.join('\n');
}

function exitCode(results) {
  if (results.some(r => r.outcome === 'fail')) return 1;
  if (results.some(r => r.outcome === 'could_not_run')) return 3;
  return 0;
}

async function main(argv, { log = s => process.stdout.write(s + '\n'), err = s => process.stderr.write(s + '\n'), adapter } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  if (o.help) { log(USAGE); return 0; }
  if (!fs.existsSync(o.registry)) { err(`no folder ${o.registry}`); return 2; }
  if (o.out && inside(o.registry, o.out)) { err(`--out ${o.out} is inside the registry; evidence is kept outside it`); return 2; }
  const all = loadFeatures(o.registry);
  const picked = o.feature === 'all' ? all : all.filter(e => e.id === o.feature);
  if (!picked.length) { err(o.feature === 'all' ? 'no features in features/' : `no feature ${o.feature} in features/`); return 2; }
  const broken = picked.filter(e => e.problems.length);
  if (broken.length) {
    for (const e of broken) err(`${e.rel} cannot run: ${e.problems.join('; ')}`);
    return 2;
  }
  if (o.journey) {
    const none = picked.filter(e => !Journey.runs(e.record, o.journey).length);
    if (none.length === picked.length) { err(`no journey ${o.journey} in ${picked.map(e => e.id).join(', ')}`); return 2; }
  }
  let ad;
  try { ad = adapter || makeAdapter(o.adapter); } catch (e) { err(e.message); return 2; }
  const settings = readJson(path.join(o.registry, 'designc.json')) || {};
  const cfg = settings.verify && settings.verify.ready;
  const params = { ...o.params };
  if (o.baseUrl) params.baseUrl = o.baseUrl;
  const results = [];
  for (const e of picked) {
    if (o.journey && !Journey.runs(e.record, o.journey).length) continue;
    let res;
    try { res = await Journey.runFeature({ feature: e.record, adapter: ad, params, ready: cfg, journey: o.journey, allowWrites: !!o.allowWrites }); }
    catch (x) { err(`${e.id}: ${x.message}`); return 2; }
    if (o.out) writeEvidence(o.out, res);
    results.push({ feature: res.feature, outcome: res.outcome, journeys: res.journeys.map(j => ({ journey: j.journey, entry: j.entry, outcome: j.outcome, failures: j.failures })) });
  }
  if (o.json) log(JSON.stringify(results, null, 2));
  else for (const r of results) log(describe(r));
  return exitCode(results);
}

if (require.main === module) main(process.argv.slice(2)).then(code => process.exit(code), e => { process.stderr.write(`${e.stack || e}\n`); process.exit(2); });

module.exports = { main, parseArgs, loadFeatures, exitCode };
