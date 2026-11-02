#!/usr/bin/env node
'use strict';
// Records converter CLI, dry run only: reads decisions/*.yaml and decisions/*.md (YAML front matter, the body as
// rationale when there is none) and prints renderer/records-convert.js's report. Never writes.
//
// Exit: 0 nothing flagged, 1 something flagged, 2 an error.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const RecordsConvert = require('../renderer/records-convert.js');
const Core = require('../renderer/core.js');

const USAGE = 'usage: records-convert --registry <dir> [--json]';
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--registry') { if (i + 1 >= argv.length) throw new Error('--registry needs a value'); o.registry = argv[++i]; }
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.help && !o.registry) throw new Error('--registry is required');
  return o;
}

function readRegistry(dir) {
  const read = sub => { const d = path.join(dir, sub); return fs.existsSync(d) ? fs.readdirSync(d).filter(f => /\.(ya?ml|md)$/i.test(f)).sort().map(f => ({ path: `${sub}/${f}`, text: fs.readFileSync(path.join(d, f), 'utf8') })) : []; };
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(path.join(dir, 'designc.json'), 'utf8')); } catch { /* defaults */ }
  const modelFile = path.join(dir, settings.model || 'model/workspace.dsl');
  const model = fs.existsSync(modelFile) ? Core.parse(fs.readFileSync(modelFile, 'utf8')) : null;
  const elements = model ? [...model.elements.values()].map(e => e.name) : [];
  const requirements = read('requirements').map(f => { try { return String((yaml.load(f.text) || {}).id); } catch { return null; } }).filter(Boolean);
  return { files: read('decisions'), ctx: { elements, requirements } };
}

async function main(argv, { log = s => process.stdout.write(s + '\n'), err = s => process.stderr.write(s + '\n') } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  if (o.help) { log(USAGE); return 0; }
  if (!fs.existsSync(o.registry)) { err(`no folder ${o.registry}`); return 2; }
  const { files, ctx } = readRegistry(o.registry);
  if (!files.length) { err('no decision files in decisions/'); return 2; }
  const out = RecordsConvert.convert(files, { ...ctx, parseYaml: yaml.load });
  if (o.json) log(JSON.stringify(out, null, 2));
  else log(RecordsConvert.describe(out));
  return out.some(r => r.flags.length) ? 1 : 0;
}

if (require.main === module) main(process.argv.slice(2)).then(code => process.exit(code), e => { process.stderr.write(`${e.stack || e}\n`); process.exit(2); });

module.exports = { main, parseArgs };
