#!/usr/bin/env node
'use strict';
// QA bugs against recorded parity (docs/parity-contract.md "QA bugs"). Reads a registry's parity/qa/<screen>.yaml, the
// scenarios with that screen, their baselines and the latest reports, and says for each logged bug whether the
// recorded behaviour caught it, and if not, why: not captured by this layer (look), state not recorded, or captured
// but not flagged (a diff rule gap). Read-only: it records nothing, writes nothing, and prints no bug text.
//
// Exit: 0 reported, 1 reported but a QA file has problems, 2 an error (nothing reported).
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const ParityQa = require('../renderer/parity-qa.js');
const { loadScenarios } = require('./parity-record.js');

const USAGE = 'usage: parity-qa --registry <dir> --screen <screen|all> [--json]';
const LABEL = { caught: 'caught', not_captured: 'not captured by this layer', state_not_recorded: 'state not recorded', not_flagged: 'captured but not flagged', triage: 'need triage' };

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--registry' || a === '--screen') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${a} needs a value`);
      o[a.slice(2)] = argv[++i];
    } else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.help) return o;
  for (const k of ['registry', 'screen']) if (!o[k]) throw new Error(`--${k} is required`);
  if (!/^[A-Za-z0-9._-]+$/.test(o.screen) || o.screen.startsWith('.')) throw new Error('--screen is a screen name of letters, digits, ".", "_" or "-", or all');
  return o;
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function oneScreen(registry, file, scenarios) {
  const rel = path.posix.join('parity', 'qa', path.basename(file));
  const qa = ParityQa.read(fs.readFileSync(file, 'utf8'), { parseYaml: yaml.load, file: rel });
  if (qa.bugs.some(b => b.screenshots.length) && !fs.existsSync(path.join(registry, 'parity', 'qa', 'shots', '.gitignore'))) {
    qa.problems.push('parity/qa/shots/.gitignore is missing; add one containing * so QA screenshots (which may show real data) stay out of git');
  }
  const baselines = {}, reports = {};
  for (const s of scenarios) {
    baselines[s.id] = readJson(path.join(registry, 'parity', 'baselines', s.id, 'legacy.json'));
    reports[s.id] = readJson(path.join(registry, 'parity', 'reports', `${s.id}.json`));
  }
  return { file: rel, ...ParityQa.report({ screen: qa.screen, scenarios, baselines, reports, qa }) };
}

function describe(r) {
  const c = r.counts;
  const lines = [`${r.screen}: ${r.bugs.length} QA bugs; ${ParityQa.BUCKETS.map(k => `${c[k]} ${LABEL[k]}`).join(', ')}. States recorded: ${r.states.join(', ') || 'none'}`];
  for (const p of r.problems) lines.push(`  problem: ${p}`);
  for (const b of r.bugs) lines.push(`  ${b.key} ${LABEL[b.bucket]}: ${b.reason}`);
  return lines.join('\n');
}

async function main(argv, { log = s => process.stdout.write(s + '\n'), err = s => process.stderr.write(s + '\n') } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  if (o.help) { log(USAGE); return 0; }
  if (!fs.existsSync(o.registry)) { err(`no folder ${o.registry}`); return 2; }
  const dir = path.join(o.registry, 'parity', 'qa');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort() : [];
  const picked = o.screen === 'all' ? files : files.filter(f => f.replace(/\.ya?ml$/, '') === o.screen);
  if (!picked.length) { err(o.screen === 'all' ? 'no QA files in parity/qa/' : `no parity/qa/${o.screen}.yaml; write the screen's QA bugs there (docs/parity-contract.md)`); return 2; }
  // A scenario that does not load cannot be matched against; its problems are the recorder's to report.
  const scenarios = loadScenarios(o.registry).filter(e => !e.problems.length).map(e => e.scenario);
  const results = picked.map(f => oneScreen(o.registry, path.join(dir, f), scenarios));
  if (o.json) log(JSON.stringify(results, null, 2));
  else for (const r of results) log(describe(r));
  return results.some(r => r.problems.length) ? 1 : 0;
}

if (require.main === module) main(process.argv.slice(2)).then(code => process.exit(code), e => { process.stderr.write(`${e.stack || e}\n`); process.exit(2); });

module.exports = { main, parseArgs };
