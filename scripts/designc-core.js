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
//   holdout-spec --registry <dir> --criterion <id> --case <n>   the generated spec for one holdout acceptance case (stdout; never in a handover)
//   check    [<dir> | --registry <dir>] [--json] [--item <id>] [--record | --no-record] [--by <who>] [--source local|pipeline]
//            lint the model and run the gate, the same JSON and exit codes as `python -m designc check` did: 0 ready, 1 not ready,
//            2 cannot run. Records a gate event in ledger/ unless CI is detected (then pass --record), --no-record is given or --item is.
//   eval     [<dir> | --registry <dir>] [--id <eval>] [--source local|pipeline] [--by <who>]
//            run the evals that agents name, score the results against their thresholds and record pass/fail in ledger/checks.jsonl.
//            Exit 0 all passing, 1 any failing, 2 the registry cannot be read (the same as `python -m designc eval` did).
// Add --json for machine output. Exit 0 done, 2 an error (nothing written). Read-only on the registry except the index.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Core = require('../renderer/core.js');
const Ledger = require('../renderer/ledger.js');
const Domain = require('../renderer/domain.js');
const yaml = require('js-yaml');
const LedgerStore = require('../ledger-store.js');
const Git = require('../git.js');
const Headless = require('../headless/index.js');
const Store = require('../headless/store.js');

const USAGE = `usage: designc-core <check|eval|verdicts|bundle|episodes|procedures|health|conflicts|index|search|inbound|holdout-spec> --registry <dir> [options] [--json]
  check     [<dir>] [--item <id>] [--record | --no-record] [--by <who>] [--source local|pipeline]
  eval      [<dir>] [--id <eval>] [--source local|pipeline] [--by <who>]
  verdicts  (--item <id> | --element <name>...) [--commit <sha>]
  bundle    --role <role> [--handover <id>] [--item <id>] [--task <id>] [--element <name>...] [--jira <key>...] [--commit <sha>] [--out <file>]
  episodes  (--item <id> | --element <name>...) [--limit N]
  procedures
  health
  conflicts (--element <name>... [--code <DCnnn>...] | --requirement <id> --business)
  index
  search    <words...> [--limit N]
  inbound   <id>
  holdout-spec --criterion <id> --case <n>`;
const VALUE = new Set(['--by', '--source', '--requirement', '--registry', '--item', '--commit', '--handover', '--task', '--role', '--out', '--limit', '--criterion', '--case', '--id']);
const MANY = new Set(['--element', '--jira', '--code']);

function parseArgs(argv) {
  const o = { words: [], element: [], jira: [], code: [] };
  const [cmd, ...rest] = argv;
  if (cmd === '--help' || cmd === '-h' || !cmd) return { help: true };
  if (!['check', 'eval', 'verdicts', 'bundle', 'episodes', 'procedures', 'health', 'conflicts', 'index', 'search', 'inbound', 'holdout-spec'].includes(cmd)) throw new Error(`unknown command ${cmd}`);
  o.cmd = cmd;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (VALUE.has(a) || MANY.has(a)) {
      if (i + 1 >= rest.length || rest[i + 1].startsWith('--')) throw new Error(`${a} needs a value`);
      if (MANY.has(a)) o[a.slice(2)].push(rest[++i]); else o[a.slice(2)] = rest[++i];
    } else if (a === '--json') o.json = true;
    else if (a === '--business') o.business = true;
    else if (a === '--record') o.record = true;
    else if (a === '--no-record') o.noRecord = true;
    else if (a.startsWith('--')) throw new Error(`unknown argument ${a}`);
    else o.words.push(a);
  }
  if (o.cmd === 'check' || o.cmd === 'eval') {
    if (o.words.length > 1) throw new Error(`${o.cmd} takes one registry folder`);
    if (o.words.length && o.registry) throw new Error('give the registry as an argument or with --registry, not both');
    o.registry = o.registry || o.words[0] || '.';
    return o;
  }
  if (!o.registry) throw new Error('--registry is required');
  if (o.cmd === 'verdicts' && !o.item && !o.element.length) throw new Error('verdicts needs --item or --element');
  if (o.cmd === 'verdicts' && o.item && o.element.length) throw new Error('give --item or --element, not both');
  if (o.cmd === 'episodes' && !o.item && !o.element.length) throw new Error('episodes needs --item or --element');
  if (o.cmd === 'episodes' && o.item && o.element.length) throw new Error('give --item or --element, not both');
  if (o.cmd === 'bundle' && !o.role) throw new Error('bundle needs --role');
  if (o.cmd === 'conflicts' && !o.element.length && !o.requirement) throw new Error('conflicts needs --element or --requirement');
  if (o.cmd === 'search' && !o.words.length) throw new Error('search needs words');
  if (o.cmd === 'holdout-spec' && (!o.criterion || o.case === undefined)) throw new Error('holdout-spec needs --criterion and --case');
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
    ...r.review.external.map(x => `${x.id} v${x.version} (${x.hash}, ${x.source}): ${x.judgement}, ${x.reason}${x.older.length ? `; earlier: ${x.older.map(o => `${o.hash} passed ${o.passed} of ${o.uses}`).join(', ')}` : ''}`),
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
  if (cmd === 'holdout-spec') return r.spec.replace(/\n$/, '');
  return ['superseded_by', 'relied_on_by', 'scoped_by'].map(k => `${k}: ${r[k].join(', ') || 'none'}`).join('\n');
}

const CI_VARS = ['CI', 'TF_BUILD', 'GITLAB_CI', 'GITHUB_ACTIONS'];
const inCi = () => CI_VARS.some(v => process.env[v]);
const who = by => by || process.env.DESIGNC_BY || (() => { try { return os.userInfo().username; } catch { return 'unknown'; } })();

// The text report (cli.py render).
function renderCheck(r) {
  const lines = [];
  for (const e of r.errors) lines.push(`model:${e.line}  error  ${e.msg}`);
  for (const f of r.findings) {
    const tag = f.suppressed ? 'suppressed' : f.sev + (f.unknown ? ' (unknown)' : '');
    lines.push(`${f.code}  ${tag.padEnd(18)} ${f.label}: ${f.msg}`);
  }
  const n = r.gate.clauses.length;
  lines.push('');
  lines.push(r.gate.ready ? 'Ready for handover.' : `Not ready: ${n} clause${n === 1 ? '' : 's'} block the gate.`);
  for (const c of r.gate.clauses) lines.push(`  - ${c.text}`);
  for (const x of r.gate.notes || []) lines.push(`  unknown: ${x}`);
  return lines.join('\n');
}
// Run each eval an agent names, record a pass or fail (cli.py eval_cmd). Exit 0 all passing, 1 any failing, 2 the registry cannot be read.
async function evalCommand(o, { log, err }) {
  if (o.source !== undefined && !['local', 'pipeline'].includes(o.source)) { err('designc: --source must be local or pipeline.'); return 2; }
  const dir = path.resolve(o.registry);
  const st = Headless.checkState(dir);
  if (st.error) { err(st.error); return 2; }
  const source = o.source || (inCi() ? 'pipeline' : 'local');
  const evals = st.assembled.gateInputs.evals || [];
  const byId = new Map(evals.map(e => [String(e.id), e]));
  if (o.id !== undefined && !byId.has(o.id)) { err(`designc: no eval ${o.id} in evals/. Check the id, or add evals/${o.id}.yaml.`); return 2; }
  let failed = 0;
  const named = new Set();
  for (const r of Core.evalReport({ model: st.model, evals, ledger: [] })) {
    if (r.autonomy === 'suggest' && !r.evalId) { log(`warning  ${r.agent} (suggest) has no eval; it is not blocked, but consider one.`); continue; }
    const eid = r.evalId ? String(r.evalId) : null;
    if (eid === null || named.has(eid) || (o.id !== undefined && eid !== o.id)) continue;
    named.add(eid);
    const d = byId.get(eid);
    if (!d) { log(`fail  ${eid}: not in evals/`); failed++; continue; }
    const problems = Core.evalProblems(d);
    if (problems.length || d.agent !== r.agent) { log(`fail  ${eid}: ` + (problems.join('; ') || `eval is for "${d.agent}", not ${r.agent}`)); failed++; continue; }
    const t0 = Date.now();
    const p = spawnSync(d.command, { shell: true, cwd: dir, stdio: 'inherit' });
    const ms = Date.now() - t0, exit = p.status === null ? -1 : p.status;
    let scored;
    try { scored = Core.scoreEval(d, JSON.parse(fs.readFileSync(path.join(dir, d.results), 'utf8'))); }
    catch (ex) { scored = { error: `${d.results} could not be read as JSON: ${ex.message}` }; }
    const base = { kind: 'eval', eval: eid, agent: r.agent, source, ms, exit_code: exit, fingerprint: Core.fingerprint(st.model, r.agentId).hash, eval_hash: Core.evalHash(d), by: who(o.by) };
    let ev;
    if (scored.error) ev = { ...base, outcome: 'fail', metrics: {}, cases: 0, reason: scored.error };
    else {
      ev = { ...base, outcome: scored.outcome === 'pass' && exit === 0 ? 'pass' : 'fail', metrics: scored.metrics, cases: scored.cases };
      if (ev.outcome === 'fail') ev.reason = scored.reason || `the command exited with ${exit}`;
    }
    const res = await LedgerStore.appendEvent(dir, ev);
    if (!res.ok) { err('designc: could not record the eval event: ' + res.errors.join('; ')); return 2; }
    log(`${ev.outcome}  ${eid} (${r.agent})${ev.outcome === 'pass' ? '' : ': ' + ev.reason}`);
    if (ev.outcome !== 'pass') failed++;
  }
  if (!named.size && o.id === undefined) log('No agent names an eval.');
  return failed ? 1 : 0;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// A domain registry has packs and no model: check each domain/<key>.yaml, exit 0 clean, 1 with problems (cli.py domain_registry_cmd).
function domainRegistryCheck(dir, asJson, log) {
  const problems = [], d = path.join(dir, 'domain');
  let names = []; try { names = fs.readdirSync(d).filter(n => /\.ya?ml$/.test(n)).sort(); } catch { /* none */ }
  for (const n of names) {
    const key = n.replace(/\.[^.]+$/, ''), rel = `domain/${n}`;
    let text; try { text = fs.readFileSync(path.join(d, n), 'utf8'); } catch { continue; }
    const r = Domain.read(text, yaml.load, key);
    if (r.error) problems.push(`${rel} ${r.error}`); else problems.push(...r.problems.map(x => `${rel}: ${x}`));
  }
  if (asJson) log(JSON.stringify({ ready: !problems.length, problems }, null, 2));
  else { for (const x of problems) log(x); log(!problems.length ? 'Domain packs are valid.' : `${plural(problems.length, 'problem')} in the domain packs.`); }
  return problems.length ? 1 : 0;
}

// What `python -m designc check` did, exit codes included: 0 ready, 1 not ready, 2 cannot run.
async function checkCommand(o, { log, err }) {
  if (o.record && o.noRecord) { err('designc: --record and --no-record cannot be used together.'); return 2; }
  if (o.source !== undefined && !['local', 'pipeline'].includes(o.source)) { err('designc: --source must be local or pipeline.'); return 2; }
  const dir = path.resolve(o.registry);
  let kind = null;
  try { kind = JSON.parse(fs.readFileSync(path.join(dir, 'designc.json'), 'utf8')).kind; } catch { /* no settings, or not JSON: checkState says */ }
  if (fs.existsSync(dir) && kind === 'study') { log('designc: study registry: nothing to check. Its topics are for learning; decisions are made in a project registry.'); return 0; }
  if (fs.existsSync(dir) && kind === 'domain') return domainRegistryCheck(dir, o.json, log);
  const r = o.item !== undefined ? Headless.gate(dir, { item: o.item }) : Headless.check(dir);
  if (r.error) { err(r.error); return 2; }
  const { report, state } = r;
  if (o.item !== undefined) {
    if (o.json) log(JSON.stringify(report, null, 2));
    else {
      log(`Gate for work item ${o.item} (${plural(report.outside, 'clause')} outside its elements not counted)`);
      log(renderCheck(report));
      if (report.warnings.length) log(`${plural(report.warnings.length, 'warning')} on its elements to check, not blocking.`);
    }
    return report.gate.ready ? 0 : 1;
  }
  const note = o.json ? err : log;
  log(o.json ? JSON.stringify(report, null, 2) : renderCheck(report));
  const source = o.source || (inCi() ? 'pipeline' : 'local');
  if (o.noRecord) { /* never record */ }
  else if (inCi() && !o.record) note('CI detected: not recording a gate event. Pass --record to record one.');
  else await recordGate(dir, state, source, o.by, note, err);
  return report.gate.ready ? 0 : 1;
}

// Append one gate event unless the latest one from this source already says the same (cli.py record_gate). Git facts as the app's gateGit.
async function recordGate(dir, state, source, by, note, err) {
  let git = null;
  const s = await Git.status(dir);
  if (s && !s.error) git = { commit: s.head || null, dirty: Core.dirtyInputs(s.files || [], state.cfg).length > 0 };
  const ev = Core.gateRecord({ modelText: state.modelText, diags: state.diags, gate: state.gate, source, git });
  if (Ledger.gateUnchanged(state.assembled.ledgerRaw, ev)) { note('gate unchanged, not recorded'); return; }
  const res = await LedgerStore.appendEvent(dir, { ...ev, by: who(by) });
  if (res.ok) note('recorded gate event in ledger/'); else err('designc: could not record the gate event: ' + res.errors.join('; '));
}

async function main(argv, { log = s => process.stdout.write(s + '\n'), err = s => process.stderr.write(s + '\n') } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  if (o.help) { log(USAGE); return 0; }
  if (o.cmd === 'check') return checkCommand(o, { log, err });
  if (o.cmd === 'eval') return evalCommand(o, { log, err });
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
    else if (o.cmd === 'holdout-spec') r = Headless.holdoutSpec(reg, { criterion: o.criterion, case: o.case });
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
