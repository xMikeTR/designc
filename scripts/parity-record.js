#!/usr/bin/env node
'use strict';
// Legacy parity recorder CLI (docs/parity-contract.md). Records one side of one or every scenario in a registry's
// parity/scenarios/ through an adapter, keeping only the normalised snapshot (renderer/parity.js), never page data.
//   --side legacy   writes parity/baselines/<id>/legacy.json (the baseline the new app is held to)
//   --side next     compares with that baseline, writes parity/reports/<id>.json and, with --ledger, appends a
//                   parity_result through the one ledger append path (ledger-store.js)
// Screenshots go to parity/shots/<sha256>.png, which git ignores; the gallery shows them, the diff never reads them.
// Read-only by default: committing clicks are blocked and the web adapter aborts any request that is not GET, HEAD or
// OPTIONS. Only the person running this can relax that (--allow-writes, --allow-request <url part>).
//
// Exit: 0 pass (or baseline recorded), 1 a scenario failed, 2 an error (nothing judged), 3 a scenario could not run.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Parity = require('../renderer/parity.js');
const Recorder = require('../recorder/index.js');
const { appendEvent } = require('../ledger-store.js');

const USAGE = `usage: parity-record --registry <dir> --scenario <id|all> --side <legacy|next>
       [--adapter web|fixture:<file.json>] [--base-url <url>] [--param name=value]...
       [--commit <sha>] [--item <work item>] [--ledger] [--by <name>] [--no-shots]
       [--allow-writes] [--allow-request <url part>]... [--json]`;

function parseArgs(argv) {
  const o = { params: {}, allowRequests: [], shots: true, adapter: 'web' };
  const value = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const flags = { '--registry': 'registry', '--scenario': 'scenario', '--side': 'side', '--adapter': 'adapter', '--base-url': 'baseUrl', '--commit': 'commit', '--item': 'item', '--by': 'by' };
    if (flags[a]) { o[flags[a]] = value(i, a); i++; }
    else if (a === '--param') {
      const kv = value(i, a); i++;
      const eq = kv.indexOf('=');
      if (eq < 1) throw new Error(`--param needs name=value, got "${kv}"`);
      o.params[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === '--allow-request') { o.allowRequests.push(value(i, a)); i++; }
    else if (a === '--allow-writes') o.allowWrites = true;
    else if (a === '--ledger') o.ledger = true;
    else if (a === '--no-shots') o.shots = false;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.help) return o;
  for (const k of ['registry', 'scenario', 'side']) if (!o[k]) throw new Error(`--${k} is required`);
  if (!['legacy', 'next'].includes(o.side)) throw new Error('--side is legacy or next');
  if (o.ledger && o.side !== 'next') throw new Error('--ledger records a comparison, so it needs --side next');
  return o;
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readYamlDir = dir => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort().map(f => {
    const rel = path.posix.join(path.basename(dir), f);
    try { return { rel, doc: yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')) }; }
    catch (e) { return { rel, error: `${rel} does not parse: ${e.message.split('\n')[0]}` }; }
  });
};

// Every scenario file, with the problems that stop it running. A file with no id is a problem, never skipped quietly.
function loadScenarios(registry) {
  return readYamlDir(path.join(registry, 'parity', 'scenarios')).map(f => {
    if (f.error) return { rel: f.rel, problems: [f.error] };
    const s = f.doc;
    const problems = s && typeof s === 'object' ? Parity.scenarioProblems(s) : ['the file is not a mapping'];
    return { rel: f.rel, id: s && typeof s.id === 'string' ? s.id : null, scenario: s, problems };
  });
}

function makeAdapter(spec) {
  if (spec === 'web') return require('../recorder/adapters/web.js').create('web');
  if (spec.startsWith('fixture:')) return require('../recorder/adapters/fixture.js').create(path.resolve(spec.slice(8)));
  throw new Error(`unknown adapter ${spec}: use web or fixture:<file.json>`);
}

function writeShots(registry, shots) {
  const dir = path.join(registry, 'parity', 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  for (const [sha, png] of Object.entries(shots)) {
    if (!/^[0-9a-f]{64}$/.test(sha)) continue;
    const f = path.join(dir, `${sha}.png`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, png);
  }
}

const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };

// Exceptions from the registry: acceptance criterion locators cover what the new app adds or changes, bound business
// decisions with removes: cover what it drops. Unreadable files are skipped here; the gate reports them.
function loadExceptions(registry) {
  const docs = dir => readYamlDir(path.join(registry, dir)).filter(f => f.doc && typeof f.doc === 'object').map(f => f.doc);
  return Parity.exceptions({ acceptance: docs('acceptance'), decisions: docs('decisions') });
}

async function runOne(o, entry, settings, adapter) {
  const { scenario } = entry;
  const params = { ...((settings.parity || {})[o.side] || {}), ...((scenario.params || {})[o.side] || {}), ...o.params };
  if (o.baseUrl) params.baseUrl = o.baseUrl;
  const base = path.join(o.registry, 'parity', 'baselines', scenario.id, 'legacy.json');
  let baseline = null;
  if (o.side === 'next') {
    baseline = readJson(base);
    if (!baseline) return { scenario: scenario.id, error: `no baseline for ${scenario.id}: record legacy first (--side legacy)` };
  }
  const rec = await Recorder.record({ scenario, side: o.side, adapter, params, screenshots: o.shots, allowWrites: !!o.allowWrites, allowRequests: o.allowRequests });
  if (rec.error) return { scenario: scenario.id, error: rec.error };
  // A login page is not the legacy app, so it must not replace a baseline. On the new app it is could not run, below.
  if (rec.wall && o.side === 'legacy') return { scenario: scenario.id, error: `legacy stopped at a login wall: ${rec.wall}. No baseline written. Run legacy with sign-in off, then record again.` };
  if (o.shots) writeShots(o.registry, rec.shots);
  const snap = Parity.snapshot(rec, scenario, { params });
  if (o.side === 'legacy') {
    writeJson(base, snap);
    const notOk = snap.steps.filter(s => s.status !== 'ok');
    return { scenario: scenario.id, recorded: path.relative(o.registry, base), steps: snap.steps.length, notOk: notOk.map(s => `step ${s.n}: ${s.status}${s.reason ? ` (${s.reason})` : ''}`) };
  }
  const result = Parity.compare({ scenario, legacy: baseline, next: snap, exceptions: loadExceptions(o.registry) });
  const report = path.posix.join('parity', 'reports', `${scenario.id}.json`);
  writeJson(path.join(o.registry, report), { commit: o.commit || null, item: o.item || null, next: snap, result });
  const out = { scenario: scenario.id, outcome: result.outcome, counts: result.counts, report, failures: Parity.failures(result) };
  if (o.ledger) {
    const ev = { ...Parity.resultEvent(result, { commit: o.commit || null, item: o.item, report }), by: o.by || process.env.USER || 'parity-record' };
    const r = await appendEvent(o.registry, ev);
    out.ledger = r.ok ? 'recorded' : `not recorded: ${r.errors.join('; ')}`;
  }
  return out;
}

const CODE = { pass: 0, recorded: 0, fail: 1, error: 2, could_not_run: 3 };
const RANK = [0, 3, 1, 2]; // worst wins: error > fail > could not run > pass

function exitCode(results) {
  return results.map(r => r.error ? CODE.error : r.recorded ? 0 : CODE[r.outcome]).reduce((a, b) => RANK.indexOf(b) > RANK.indexOf(a) ? b : a, 0);
}

function describe(r) {
  if (r.error) return `${r.scenario}: error: ${r.error}`;
  if (r.recorded) return `${r.scenario}: baseline written to ${r.recorded} (${r.steps} steps)${r.notOk.length ? `; ${r.notOk.join('; ')}` : ''}`;
  const lines = [`${r.scenario}: ${r.outcome.replace(/_/g, ' ')} (${r.counts.fail} failing, ${r.counts.covered} covered by a requirement, ${r.counts.could_not_run} steps could not run); report ${r.report}${r.ledger ? `; ledger ${r.ledger}` : ''}`];
  for (const f of r.failures) lines.push(`  step ${f.step} ${f.kind}: ${f.msg}`);
  return lines.join('\n');
}

async function main(argv, { log = s => process.stdout.write(s + '\n'), err = s => process.stderr.write(s + '\n'), adapter } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  if (o.help) { log(USAGE); return 0; }
  if (!fs.existsSync(o.registry)) { err(`no folder ${o.registry}`); return 2; }
  const settings = readJson(path.join(o.registry, 'designc.json')) || {};
  const all = loadScenarios(o.registry);
  const picked = o.scenario === 'all' ? all : all.filter(e => e.id === o.scenario);
  if (!picked.length) { err(o.scenario === 'all' ? 'no scenarios in parity/scenarios/' : `no scenario ${o.scenario} in parity/scenarios/`); return 2; }
  let ad;
  try { ad = adapter || makeAdapter(o.adapter); } catch (e) { err(e.message); return 2; }
  const results = [];
  for (const e of picked) {
    if (e.problems.length) results.push({ scenario: e.id || e.rel, error: `${e.rel}: ${e.problems.join('; ')}` });
    else results.push(await runOne(o, e, settings, ad));
  }
  if (o.json) log(JSON.stringify(results, null, 2));
  else for (const r of results) log(describe(r));
  return exitCode(results);
}

if (require.main === module) main(process.argv.slice(2)).then(code => process.exit(code), e => { process.stderr.write(`${e.stack || e}\n`); process.exit(2); });

module.exports = { main, parseArgs, loadScenarios, loadExceptions, exitCode };
