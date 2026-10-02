# Session Handoff — 2026-10-02 Grill closed (26 decisions), codebase explored, ready for `/plan`

## What we were doing
Finished `/grill-me` on the next designc slices, then ran `/explore-codebase`. The grill is closed: 26 decisions, 12 slices in an agreed order. `ARCHITECTURE.md` and `UBIQUITOUS_LANGUAGE.md` now exist. No code changed. Next session is `/plan`, slices 1 to 3 first.

Goal, in Mike's words: designc is the tool he lives in daily for designing systems, regular or agentic. Git is a full part of it. Nothing is refused for good; only the order matters.

## Decisions 1 to 12 (2026-10-01, still standing)
1. **Diff baseline.** Two baselines: the last handover's frozen DSL for "compare with last handover", and a per-decision promotion fingerprint for re-promotion. `Core.gate` never depends on git.
2. **Element identity.** Same DSL identifier = same element (name differs = renamed, parent differs = moved). Else same normalised name under the same parent (identifier changed). Else removed + added. No fuzzy matching, `d.aka` plays no part. Rels keyed on (source identity, destination identity, ordinal among parallel rels).
3. **Bindings.** `binds:` and `elements:` keep names. The fingerprint records the resolved identifier; the gate resolves by recorded identifier, then name. New blocking clause "binding does not resolve".
4. **Fingerprint scope.** Per bound element: kind, parent identity, name, technology, all `d.*` including `d.suppress`, every incident rel (direction, other end's identity, technology, its `d.*`). Excluded: description, tags, comments, whitespace, order, lines, descendants, rel description.
5. **Fingerprint storage.** Decision YAML gains `promoted_against` (`- { element: quotesDb, name: Quotes DB, hash: 9f3a1c20 }`), written by `bindDecision`. Small built-in hash in `core.js`, matched by the Python package. New ledger kind `decision_promoted` carrying the canonical content. `bound` without `promoted_against` blocks. Agents may not write `promoted_against`, `promoted_by`, `promoted_at`.
6. **Business vs technical.** Technical constrains the design, binds elements, reopens on design change. Business settles a rule in a requirement, binds the requirement, promoted against its `version`, reopens when the version changes. A technical `effect: accept` must cite a bound business decision (`relies_on`) and reopens with it.
7. **Representation (amended by 16).** One `decisions/` folder, field `kind: business | technical`, missing = technical. Ids are slugs, not a `D-` series.
   | | technical | business |
   | --- | --- | --- |
   | `requirement` | required | required |
   | `binds` | required, non-empty | absent or empty |
   | `effect`, `resolves` | as today | not allowed |
   | `checks` | required to pass the gate | optional |
   | `relies_on` | required when `effect: accept` | not allowed |
   | `promoted_against` | element fingerprints | `{ requirement: HRE-1234, version: 7 }` |
8. **Authority.** `evidence` (URL) mandatory on a business decision; `agreed_by` optional free text. designc never fetches the URL. Agents may mint business decisions but never write `agreed_by` or `evidence`.
9. **Grill-me routing.** A `business` question gets "Draft business decision": a `minted` file, statement prefixed "PROPOSED:", evidence empty. Promotion refused while the prefix remains. Second action copies the question for Jira.
10. **Handover shape (amended by 17 to 19).** Freeze writes a folder `handovers/<id>/` with `handover.yaml`, `model/workspace.dsl`, `requirements/*.yaml`, bound `decisions/*.yaml`, `behaviour/*.p`. Copies. Immutable. Old flat handovers still read.
11. **Evidence safety.** `designc.json` `evidenceHosts`; evidence must be `https` on a listed host; no list = every business decision blocks. Optional `evidence_version`.
12. **Order.** Replaced by decision 25/26.

## Decisions 13 to 26 (2026-10-02)
13. **Where the registry lives.** Inside the code repo. So `gitShow` and friends must stay inside the registry root, and extraction will walk the registry unless told not to.
14. **Git scope.** First cut: status, history, compare with a revision; stage and unstage whole files; commit with a file list; create and switch branch; fetch, pull (fast-forward only), push. Later: conflict UI, hunk staging, rebase, cherry-pick, amend, reset, stash, PRs. Never: any git action by an agent. Refuse when a pull cannot fast-forward or a switch would overwrite unsaved edits. One folder-trust decision covers checks and git. No repo = quiet fallback to "compare with last handover".
15. **Ledger in git.** Committed whole. `.gitattributes`: `ledger/*.jsonl merge=union`. Readers order by `_ts` and drop duplicate `event_id`s.
16. **Ids.** Decision and proposal ids are opaque slugs derived by designc from the statement at mint time, editable while `minted`, frozen once `bound`. Old `D-0001` ids stay valid. Duplicate id = blocking gate clause. Requirements keep Jira ids.
17. **Handover id.** `<yyyymmdd>-<hash8>` over the frozen file set. "Last handover" = latest `created` on the current branch.
18. **Freeze and git.** Freeze writes the folder, then opens the commit dialog pre-filled. No tag. Warn if a handover folder differs from its committed version.
19. **Vocabulary.** Freeze copies `vocabulary/*.yaml` if present.
20. **`git.js` interface.** Slice 1: `gitStatus()`, `gitRefs()`, `gitLog(rel, max)`, `gitShow(ref, rel)`. Slice 2: `gitStage(paths)`, `gitUnstage(paths)`, `gitCommit(message)`, `gitBranch(name)`, `gitSwitch(ref)`, `gitFetch()`, `gitPull()`, `gitPush()`. Rules: installed binary via `execFile` with fixed argument templates, no passthrough; `rel` through `inside()` and after `--`; refs only from `gitRefs()`/`gitLog()` output, never starting with `-`; staging confined to the registry; commit message on stdin; hooks run only under folder trust; config overrides disable fsmonitor, external diff, textconv, pager, optional locks; never force; push only to the configured upstream, with an explicit confirmation the first time a branch is published; output through `esc()`; not in `TOOLS`, not on the MCP bridge.
21. **Diff and fingerprint.** `Core.diffModels(before, after) -> { elements[], rels[], summary }` and `Core.fingerprint(model, elementId) -> { hash, content }`.
22. **Change impact** is its own slice: what a design change touches (decisions, requirements, checks).
23. **Blast radius** is its own slice, not parked: `Core.blastRadius(model, elementId, { mode }) -> { down[], degraded[], unknown[], paths[] }`, modes `unavailable` and `misbehaves` (the agentic one).
24. **Shared fate** comes from C4 nesting and deployment models, done properly: `deploymentEnvironment`, nested `deploymentNode` with `instances`, `containerInstance`, `softwareSystemInstance`, `infrastructureNode`, `d.*` on nodes, one environment chosen in `designc.json`, read-only on the canvas at first.
25/26. **Slice order.**
   1. Git read-only (status, history, compare with revision)
   2. Git daily loop, union merge, ordered de-duplicated ledger reads
   3. Slug ids, duplicate-id clause
   4. Semantic diff and compare view
   5. Fingerprints, technical decisions resurfaced on change
   6. Business decisions
   7. Handover folder
   8. Change impact
   9. Blast radius, `misbehaves`
   10. Deployment models
   11. Blast radius, `unavailable`
   12. Quality attribute scenarios, then fitness functions (not grilled)

### Interface changes flagged
- **`window.host`:** the twelve git methods above. New main-process module `git.js`.
- **Core exports:** `diffModels`, `fingerprint`, `blastRadius`; parser grows deployment models.
- **Decision file:** slug `id`, `kind`, `relies_on`, `promoted_against`, `evidence`, `agreed_by`, `evidence_version`.
- **Handover:** file becomes a folder; id format changes.
- **`designc.json`:** `evidenceHosts`, chosen deployment environment.
- **Ledger:** new kind `decision_promoted`; readers de-duplicate by `event_id` and order by `_ts`.
- **Gate clauses, new:** duplicate id; binding does not resolve; changed since promotion; bound without fingerprint; malformed kind; `accept` without a bound business decision; business decision without evidence; evidence host not allowed.
- **Agent policy:** protected decision fields; `handovers/` unwritable; no git.
- **Registry:** `.gitattributes`.

## Decisions NOT yet made
- **Escape ids.** Recommended twice, never confirmed: key escapes on `event_id`, keep `E-…` as display text. Needed before slice 2 is planned.
- Slice 10: does placement enter a container's fingerprint; `instances` on the node vs `d.instances`.
- Slice 11: tolerant callers and redundancy.
- Slice 12: how scenarios and fitness functions relate to the canvas's existing quality properties (`d.latency.p99`, `d.rto`, …). Not grilled.
- Slice 6: is the grill-me `business` flag stable; when the Python package mirrors the business rules.
- `agreed_by` convention (role vs person): free text, not confirmed.

## What exploration found that the plan must account for
Full detail in `ARCHITECTURE.md` (Domain Rules, Known Risks). By slice:
- **1, 2 (git):** the file watcher cannot see a branch switch as such; dirty buffers plus outside changes show mixed state; folder trust is keyed on the registry path; `inside()` is lexical (no symlink resolution); checks and ACP agents inherit the full `process.env`; ledger readers depend on line order today.
- **3 (ids):** `nextId` is used in four places, including `agent.js:124,141` and escapes at `app.js:1188`. A broken YAML file is dropped and stops blocking the gate.
- **4, 5 (diff, fingerprint):** element auto ids and rel ids are positional, so neither may key on them. The parser silently skips any unknown block, including `group` (elements inside vanish). There is no hash in `core.js`. The gate matches `binds` by exact name and never checks the name exists. `bindDecision` has no precondition and records no event. The rule set depends on whether the canvas is loaded; Python parity holds for DC rules only.
- **6:** `superseded` blocks the gate forever; a `TODO` check counts as a check; the ACP bind guard misses `status: "bound"` (quoted).
- **7 (handover):** the loader reads one flat folder; use `tree()` + `read()`, no new host method. "Last handover" is by id sort. Freeze reads buffers, so it should refuse while registry buffers are dirty. Extraction walks the registry when it sits inside the codebase, so frozen copies would be scanned.
- **10 (deployment):** the grammar exists twice, in `Core.parse` and in `renderer/canvas/dsl-edit.js` `locate()`. Both change together. The inspector's `CORE_PROPS` is a second copy of core's property list.
- **Not tied to a slice, worth a fix slice of their own:** ACP writes can leave the registry (`onAcpWrite` does not normalise `..`, `acp.js` writes the path as given); an ACP agent can append a passing `check` line to the ledger on disk unflagged; `designc.json` can put a write tool in a role's `allow`; `mint_decision`/`mint_proposal` write `requirement`/`kind` into YAML unquoted. These are open breaks of "agents cannot write without a policy check" and are not in the 12-slice order. Raise at the start of `/plan`.

## Where we got to
No code changed. Files written this session: `ARCHITECTURE.md`, `UBIQUITOUS_LANGUAGE.md`, this note. `npm test` 101/101 on 2026-10-02. `ARCHITECTURE.md` says which areas were read and which were outlined only (scanners, linker, components, AG-UI loop, dashboards, C4 drawing, `canvas.js`): read the relevant one before a slice changes it. `UBIQUITOUS_LANGUAGE.md` was written without Mike's term-by-term review. `AGENTS.md` is out of date (Electron version, no canvas, no `ledger.js`/`ledger-store.js`/`test/`) and was not edited.

## What to load on restart
- This file, `ARCHITECTURE.md`, `UBIQUITOUS_LANGUAGE.md`.
- `AGENTS.md` sections "IPC contract" and "The registry folder".
- For slices 1 to 3: `main.js`, `preload.js`, `renderer/ledger.js`, and `renderer/app.js` around `nextId` (72), `loadYamlDir`, `onDiskChanged`.
- Skill: `/plan`.

## Watch out for
- Mike answered most questions "agreed" to a recommendation; each decision above is the recommendation as put. If one reads wrong, re-ask.
- Do not check in after every step, and keep reports short. Mike said so.
- Do not call anything "out of scope"; say where it sits in the order.
- designc is plain Electron and Monaco, not a VS Code fork.
- Uncommitted changes no session made: `fixtures/fullstack/{asbuilt/*, model/workspace.dsl, ledger/designc.jsonl}` and .NET `obj/` AssemblyInfo files. Do not commit or revert without asking.
- Atlassian is never fetched: evidence is a link.
- Not up for debate: `core.js` dependency-free and node-requirable; no new dependencies in `extract/`; no new `d.*` properties without agreement; sample registry compiles to 2 errors, 4 warnings, 1 suppressed; TDD in small steps; shared `app.js` regions get new statements, not rewritten lines; `app.js` is not requirable (scratch vm harness).
- `SESSION_HANDOFF.md` is ephemeral: do not commit it. Commit or push only when asked.
