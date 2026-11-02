#!/usr/bin/env node
'use strict';
// The headless core's command line (intelligence plane phase 3), for agents and pipelines; no MCP needed.
//   verdicts --registry <dir> (--item <id> | --element <name>...) [--commit <sha>]
//   bundle   --registry <dir> --role <role> [--handover <id>] [--item <id>] [--task <id>] [--element <name>...]
//            [--jira <key>...] [--commit <sha>] [--out <file>]   (--out never overwrites)
//   episodes --registry <dir> (--item <id> | --element <name>...) [--limit N]   past runs and tasks on those elements
//   procedures --registry <dir>                 per procedure: judgement of the version in the file (System 3), and per version in traces: uses, passed, failed, delivered, causes
//   health   --registry <dir>                 knowledge health: live decisions per area, graduate and retire candidates, recurring failures, tokens per bundle
//   conflicts --registry <dir> (--element <name>... [--code <DCnnn>...] | --requirement <id> --business)   decisions a new one would overlap: same (supersede it) or near
//   index    --registry <dir>                 rebuild .designc/index.sqlite from the files
//   search   --registry <dir> <words...> [--limit N]
//   inbound  --registry <dir> <id>            who supersedes, relies on or scopes to <id>
// Add --json for machine output. Exit 0 done, 2 an error (nothing written). Read-only on the registry except the index.
const fs = require('fs');
const Headless = require('../headless/index.js');
const Store = require('../headless/store.js');

const USAGE = `usage: designc-core <verdicts|bundle|episodes|procedures|health|conflicts|index|search|inbound> --registry <dir> [options] [--json]
  verdicts  (--item <id> | --element <name>...) [--commit <sha>]
  bundle    --role <role> [--handover <id>] [--item <id>] [--task <id>] [--element <name>...] [--jira <key>...] [--commit <sha>] [--out <file>]
  episodes  (--item <id> | --element <name>...) [--limit N]
  procedures
  health
  conflicts (--element <name>... [--code <DCnnn>...] | --requirement <id> --business)
  index
  search    <words...> [--limit N]
  inbound   <id>`;
const VALUE = new Set(['--requirement', '--registry', '--item', '--commit', '--handover', '--task', '--role', '--out', '--limit']);
const MANY = new Set(['--element', '--jira', '--code']);

function parseArgs(argv) {
  const o = { words: [], element: [], jira: [], code: [] };
  const [cmd, ...rest] = argv;
  if (cmd === '--help' || cmd === '-h' || !cmd) return { help: true };
  if (!['verdicts', 'bundle', 'episodes', 'procedures', 'health', 'conflicts', 'index', 'search', 'inbound'].includes(cmd)) throw new Error(`unknown command ${cmd}`);
  o.cmd = cmd;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (VALUE.has(a) || MANY.has(a)) {
      if (i + 1 >= rest.length || rest[i + 1].startsWith('--')) throw new Error(`${a} needs a value`);
      if (MANY.has(a)) o[a.slice(2)].push(rest[++i]); else o[a.slice(2)] = rest[++i];
    } else if (a === '--json') o.json = true;
    else if (a === '--business') o.business = true;
    else if (a.startsWith('--')) throw new Error(`unknown argument ${a}`);
    else o.words.push(a);
  }
  if (!o.registry) throw new Error('--registry is required');
  if (o.cmd === 'verdicts' && !o.item && !o.element.length) throw new Error('verdicts needs --item or --element');
  if (o.cmd === 'verdicts' && o.item && o.element.length) throw new Error('give --item or --element, not both');
  if (o.cmd === 'episodes' && !o.item && !o.element.length) throw new Error('episodes needs --item or --element');
  if (o.cmd === 'episodes' && o.item && o.element.length) throw new Error('give --item or --element, not both');
  if (o.cmd === 'bundle' && !o.role) throw new Error('bundle needs --role');
  if (o.cmd === 'conflicts' && !o.element.length && !o.requirement) throw new Error('conflicts needs --element or --requirement');
  if (o.cmd === 'search' && !o.words.length) throw new Error('search needs words');
  if (o.cmd === 'inbound' && o.words.length !== 1) throw new Error('inbound needs one id');
  return o;
}

function describe(cmd, r) {
  if (cmd === 'verdicts') return [
    ...r.nodes.map(n => `${n.node_id}: ${n.conflict ? `conflict (${n.conflict.join(', ')})` : n.verdict || 'no verdict'}${n.evidence.length ? ` [${n.evidence.join(', ')}]` : ''}${n.stale ? ` (stale at another commit: ${n.stale.join(', ')})` : ''}`),
    ...(r.invalid || []).map(x => `not counted, invalid: ${x.path} (${x.errors.join('; ')})`),
  ].join('\n') || 'no nodes in scope';
  if (cmd === 'bundle') return `${r.bundle_id}\n${r.key.elements.length} elements, ${r.decisions.length} decisions, ${r.requirements.length} requirements, ${r.verdicts.length} verdict nodes${r.written ? `\nwritten to ${r.written}` : ''}`;
  if (cmd === 'episodes') {
    const c = r.summary;
    const causes = Object.entries(c.causes).map(([k, n]) => `${k} ${n}`).join(', ');
    return [`${c.tasks} tasks: ${c.passed} passed, ${c.failed} failed, ${c.open} not final${causes ? ` (${causes})` : ''}`,
      ...r.episodes.map(e => `${e.run}/${e.task}: ${e.outcome}${e.cause ? ` (${e.cause})` : ''}${e.success ? ', delivered' : ''}${e.procedures.length ? `, using ${e.procedures.map(p => `${p.id}@${p.version}`).join(', ')}` : ''}`)].join('\n');
  }
  if (cmd === 'procedures') return [
    ...r.review.rows.map(x => `${x.id} v${x.version}: ${x.judgement}, ${x.reason}${x.older.length ? `; earlier: ${x.older.map(o => `v${o.version} passed ${o.passed} of ${o.uses}`).join(', ')}` : ''}`),
    ...r.review.problems.map(m => `designc.json: ${m}`),
    ...r.review.invalid.map(x => `not judged, invalid: ${x.path} (${x.errors.join('; ')})`),
    '', 'given in traces (all versions):',
  ].join('\n') + '\n' + (r.procedures.map(p => `${p.id}@${p.version} (${p.hash}): used ${p.uses}, passed ${p.passed}, failed ${p.failed}, delivered ${p.success}${Object.keys(p.causes).length ? ` (${Object.entries(p.causes).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}`).join('\n') || 'no trace names a procedure');
  if (cmd === 'health') {
    const t = r.tokens, mean = x => x.mean == null ? 'none' : `${x.mean} mean over ${x.rows}`;
    return [`${r.live} live decisions (bound)`, ...r.areas.map(a => `  ${a.area}: ${a.live}${a.enforced ? `, ${a.enforced} enforced` : ''}`),
      `could graduate (enforced, cite by id): ${r.graduate.map(g => g.id).join(', ') || 'none'}`,
      `no recorded task touched (retire?): ${r.unused == null ? 'unknown, no tasks recorded yet' : r.unused.join(', ') || 'none'}`,
      `failure causes: ${r.recurrence.map(c => `${c.cause} ${c.count} in ${c.runs} run${c.runs === 1 ? '' : 's'}${c.recurring ? ' (recurring)' : ''}`).join(', ') || 'none'}`,
      `tokens per task: with a bundle ${mean(t.withBundle)} (${t.bundles} bundles), without ${mean(t.withoutBundle)}`].join('\n');
  }
  if (cmd === 'conflicts') return r.overlaps.map(x => `${x.id} (${x.status}): ${x.level === 'same' ? `already answers ${x.codes.join(', ')} on ${x.elements.join(', ')}; supersede it or change it instead of adding one` : `also about ${x.elements.join(', ') || 'the same requirement'}; consider superseding it`}${x.statement ? ` - ${x.statement}` : ''}`).join('\n') || 'no live or proposed decision overlaps';
  if (cmd === 'index') return `${r.file}: ${r.records} records, ${r.links} links`;
  if (cmd === 'search') return r.hits.map(h => `${h.kind} ${h.id} (${h.path}): ${h.snippet}`).join('\n') || 'no matches';
  return ['superseded_by', 'relied_on_by', 'scoped_by'].map(k => `${k}: ${r[k].join(', ') || 'none'}`).join('\n');
}

async function main(argv, { log = s => process.stdout.write(s + '\n'), err = s => process.stderr.write(s + '\n') } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  if (o.help) { log(USAGE); return 0; }
  let r;
  if (o.cmd === 'search') r = Store.search(o.registry, o.words.join(' '), { limit: o.limit });
  else if (o.cmd === 'inbound') r = Store.inbound(o.registry, o.words[0]);
  else {
    const reg = Headless.open(o.registry, { handover: o.cmd === 'bundle' ? o.handover || null : null });
    if (reg.error) { err(reg.error); return 2; }
    if (o.cmd === 'index') r = Store.build(reg);
    else if (o.cmd === 'episodes') r = Headless.episodes(reg, { work_item: o.item || null, elements: o.element.length ? o.element : null, limit: o.limit });
    else if (o.cmd === 'health') r = Headless.knowledge(reg);
    else if (o.cmd === 'conflicts') r = Headless.conflicts(reg, { binds: o.element, resolves: o.code, requirement: o.requirement || null, kind: o.business ? 'business' : 'technical' });
    else if (o.cmd === 'procedures') r = { procedures: Headless.procedureStats(reg), review: Headless.procedureReview(reg) };
    else if (o.cmd === 'verdicts') r = Headless.verdicts(reg, { scope: o.item ? { work_item: o.item } : { elements: o.element }, commit: o.commit || null });
    else {
      r = Headless.bundle(reg, { work_item: o.item || null, task: o.task || null, role: o.role, elements: o.element.length ? o.element : null, jira: o.jira.length ? o.jira : null, commit: o.commit || null });
      if (!r.error && o.out) {
        try { fs.writeFileSync(o.out, JSON.stringify(r, null, 2) + '\n', { flag: 'wx' }); }
        catch (e) { err(e.code === 'EEXIST' ? `${o.out} exists; a bundle file is never overwritten` : `could not write ${o.out}: ${e.message}`); return 2; }
        r = { ...r, written: o.out };
      }
    }
  }
  if (r.error) { err(r.error); return 2; }
  const { written, ...out } = r;
  log(o.json ? JSON.stringify(o.cmd === 'bundle' && written ? { bundle_id: out.bundle_id, written } : out, null, 2) : describe(o.cmd, r));
  return 0;
}

if (require.main === module) main(process.argv.slice(2)).then(code => process.exit(code), e => { process.stderr.write(`${e.stack || e}\n`); process.exit(2); });

module.exports = { main, parseArgs };
