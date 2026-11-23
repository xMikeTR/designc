# Ubiquitous Language — designc

> Single source of truth for domain terminology. Use these terms in code, tests,
> comments, and conversation. Never invent synonyms.
>
> Extracted from the code and `AGENTS.md` on 2026-10-02 during `/explore-codebase`.
> Not yet reviewed term by term by Mike. The "Agreed, not yet built" section holds
> terms settled in the grill of 2026-10-01/02 that no code uses yet
> (`test/doc-lint.test.js` fails when one of them already exists in code).

## Core Concepts

"Aggregate" marks a consistency boundary: one file or one stream that is changed as a
whole and referenced from outside by id or name only. The code does not name aggregates;
this marking is a reading of how the files are written and checked.

| Term | Type | Definition |
|------|------|-----------|
| Registry | Aggregate root (folder) | The folder designc opens. Plain files; git provides review and history. Everything below lives in it |
| Repo | Value (name) | A code repository an element's code lives in, named by `d.repo` on the element or its container and declared in `designc.json` `repos` (`Api`, `Ui`). Not the Registry: the registry holds the design, a repo holds code built from it. Each cross-repo relationship of a requirement must name what crosses it: `d.operation` (an operationId in a pinned OpenAPI file) or, async, `d.message` (an event of a pinned pack); an uncovered one raises gate clause `unpinned_contract`, and lint DC011 flags an untyped boundary. `Core.packEvents` lists pack events and `Core.resolveMessage` resolves `pack/Event` or a unique bare name |
| Language server | Process | `lsp/server.js`: a stdio LSP server over the headless core. Publishes the Problems rows (findings, registry YAML and ledger errors) per file, checks unsaved buffers through an overlay, and answers `d.*` hover and completion. Read-only; the app need not run |
| Interface | Value | An operation or event an element calls, serves, publishes or consumes, resolved from a typed relationship (`d.operation` / `d.message`) and written to both ends' entries in `elements.json` (schema /3) with the same `id`, `version` and `schema`/`fields`. A requirement owns a cross-repo rel only when both ends are its elements. |
| API contract | Value (file) | An OpenAPI 3.x YAML file in `contracts/openapi/` that the Api and Ui repos share. Frozen into the handover under `contracts_api:`. Pinned = directly in `contracts/openapi/` (`.yaml`/`.yml`, no subfolders); `Core.operations` lists their operations and `Core.resolveOperation` looks one up by operationId. Coverage, not existence: the gate checks that each cross-repo rel names an operation found here, so a file that exists but holds no matching operation covers nothing. Distinct from an agent contract (`contracts:`), which is a compiled agent policy |
| Design | Aggregate | The model in `model/workspace.dsl`: the source of truth. Code is a build output of it |
| Model file / include | Value | One `.dsl` file of a model; a root file pulls others in with `!include`, and `Model.sources` lists them root first |
| Model | Value | The parsed form of a design or as-built DSL text: elements, rels, errors |
| Element | Entity (inside a model) | A `person`, `softwareSystem`, `container` or `component`. Has a name, optionally an identifier, a parent, tags and properties |
| Identifier | Value Object | The DSL name before `=` on an element. Optional. Stable handle for an element; elements without one get a positional auto id |
| Rel | Entity (inside a model) | A relationship `a -> b` with description, technology and properties |
| Design property | Value Object | A `d.*` key on an element or rel (for example `d.interaction`, `d.delivery`, `d.zone`, `d.agent.autonomy`). Demand-driven: never globally required |
| Rule | Entity | A deterministic lint with a code: `DC000` to `DC006` in the core, `AG001` to `AG010` from the canvas. Each records the incident it came from in `source` |
| Finding | Value Object | One diagnostic from a rule: code, severity, message, location, hint. Also called a diagnostic in code (`diags`) |
| Unknown | Value Object | A finding of warning severity raised because a rule needed an undeclared property to decide |
| Suppression | Value Object | `d.suppress` on an element or rel: silences a named code there, and stays visible as suppressed |
| Principle | Value (property) | `d.style`, `d.api` or `d.ui` set on a system and inherited down the tree like `d.zone`; a nearer `none` switches it off below. `Core.principle(model, elementId, prop)` returns `{ value, from }`. Checked by DC012 to DC014; opt-in, so nothing changes until one is set. Changing one changes that system's fingerprint only |
| Gate | Service | The definition-of-ready check (`Core.gate`). Returns `ready` and a list of clauses |
| Clause | Value Object | One condition of the gate, blocking or not |
| Decision | Aggregate | A file in `decisions/`: id, status, effect, requirement, binds, resolves, statement, checks, rationale |
| Business decision | Aggregate (a Decision with `kind: business`) | Binds a requirement, promoted against its version, needs evidence on an allowed host; a technical accept relies on one |
| Effect | Value Object | What a decision does about a finding: `fix` (the model changes) or `accept` (keep the risk) |
| Check | Value Object | A shell command on a decision whose latest result must pass for the gate |
| Requirement | Aggregate | A file in `requirements/`: id (the Jira id), title, source, version, elements; optionally `risk`, `data_class`, `repo` (mapped from Jira by `jira-mapping.yaml`) and the raw `jira:` block |
| Inbox item | Aggregate | A file in `inbox/<KEY>.yaml` written by `scripts/sweep-jira.py`: a Jira issue assigned to you that is new or changed (id, title, `jira:`, `target: {jira: KEY}`, swept date). A suggestion only: the Work view's Accept makes the work item, Dismiss moves it to `inbox/dismissed/` |
| Proposal | Aggregate | A file in `proposals/`: a suggested change to the rules, from the improvement loop |
| Handover | Aggregate | The frozen package any coding agent consumes, in `handovers/`: the model, its resolved `elements.json`, requirements, bound decisions and behaviour. Immutable once written |
| Allow list | Value object | Per coded element, the elements its code may depend on, derived from the relationships; `dependencies.json` in the handover |
| Ledger | Aggregate (append-only streams) | `ledger/*.jsonl`. One event per line. Never rewritten; state changes are later events |
| Event | Entity | One ledger line, identified by `event_id`, with a `kind` |
| Envelope | Value Object | The common fields of an event. Two exist: `designc_v1` (snake_case kinds) and `harness_v1` (PascalCase kinds, `sessions.jsonl`) |
| Needs-decision | Entity | A question the pipeline could not settle. Open ones block the gate (designc kind only) |
| Escape origin | Value | Where an escape came from: `spec_gap`, `design_error`, `translation_error`, `gate_gap`. Beside the stage that should have caught it |
| Escape | Entity | A defect that got past the stage that should have caught it |
| Caught-by | Value Object | The stage that should have caught an escape |
| False positive | Entity | A recorded case of a rule firing wrongly; feeds rule health |
| Code map | Aggregate (generated) | The as-built model and its evidence in `asbuilt/`, extracted from the codebase |
| As-built | Qualifier | What the code actually is, as opposed to the design |
| Facts | Value | The extractor's output: projects, elements, edges, components, component edges, unresolved |
| Example rows | Value Object | `given` (seed) and `then` (expected) rows on a structured test scenario's example, keyed by domain pack aggregate (`Order` or `pack/Order`), literal values, matched on the listed fields only. Frozen in `scenarios.json` `/2` (`api`); a `request` on the examples makes it `/3`; the Factory generates API tests from them (C4) |
| Example request | Value Object | `request: {path, query, body}` on a structured scenario's example with rows: the inputs of the API call, as literal scalars (body only when there is no `effect.body`, which otherwise gives it). Checked against the operation's OpenAPI parameters and request body at mint and freeze; frozen in `scenarios.json` `/3`; the Factory's API tests send it (C4b) |
| Evidence | Value Object | The file and line behind an extracted element or edge. (In the agreed business decisions, also the link behind a decision) |
| Unresolved | Value Object | Something a scanner saw but could not resolve. Listed, never turned into an edge |
| Deployable | Entity | A project or package that runs on its own; becomes a container in the code map |
| Edge | Entity | A dependency in the code map (the as-built counterpart of a rel) |
| Consumes / Provides | Value Object | What a scanner reports a deployable calls or offers (http, hub, queue); the linker matches them into edges |
| Binding | Value Object | A `designc.json` `extract.bindings` entry resolving an env-only consume to a named element. (Distinct from a decision's `binds`) |
| Drift | Value | The difference between design and as-built: undeclared, unrealised, unmapped, unknown and missing |
| Level | Value Object | `context`, `container` or `component`: the C4 depth a model is viewed at |
| Role | Entity | An agent's job and policy: Architect, Grill-me, Analyst |
| Verdict | Value Object | The policy answer for a role and tool: `allow`, `ask` or `deny`. Unlisted is `deny` |
| Tool | Entity | A named action offered to an agent. Readers return data; writers return a card for approval |
| Approval | Entity | A human saying yes to one write card |
| Run | Entity | One agent trace from telemetry, grouped by trace id |
| Task | Entity | A unit of pipeline work; has status, reruns and tokens |
| Stencil | Value Object | A canvas palette entry that creates an element with a kind and tags |
| Trust zone | Value Object | `d.zone`, inherited from the nearest ancestor that declares it |
| Design review | Value | The generated document of NFR questions per element and STRIDE per trust-zone crossing, saved under `reviews/` |
| Fingerprint | Value | The hash and canonical content of one bound element (`Core.fingerprint` in `renderer/core.js`), recorded at promotion |
| Rename (fingerprint-safe) | Process | `Refactor.renamePlan`, served as LSP `rename`: updates every DSL and YAML reference to an element, proves with `diffModels` that only the name changed, and never touches a `promoted_against` hash. Bound decisions on the renamed element then read `changed since promotion` until a human re-binds them |
| Slug id | Value | An opaque id derived from a decision's or proposal's statement at mint time (`Core.slugId`); editable while `minted`, frozen once `bound` |
| Fingerprint | Value | The hash and canonical content of one bound element (`Core.fingerprint` in `renderer/core.js`), recorded at promotion |
| Semantic diff | Value | The difference between two models by element identity: added, removed, renamed, moved, changed (`Core.diffModels` in `renderer/core.js`) |
| Change impact | Value | What a change to the design touches: decisions, requirements, checks (`Core.changeImpact` in `renderer/core-blast.js`) |
| Blast radius | Value | What an element's failure reaches, in mode `unavailable` or `misbehaves`: down, degraded, unknown (`Core.blastRadius` in `renderer/core-blast.js`) |
| Deployment model | Value | `deploymentEnvironment`, deployment nodes and instances: where containers run (`renderer/core-deployment.js`) |
| System 1 / 2 / 4 | Context | Design compiler / coding pipeline on the MAF harness / improvement loop |

## Processes

| Term | Definition |
|------|-----------|
| Compile | Parse the design and run the rules (`recompile`) |
| Mint | Create a decision or proposal in status `minted`. The only write an agent may propose for them |
| Bind | A human promotes a decision to `bound`. Never an agent's action |
| Promote | The act of binding, as recorded (`promoted_by`, `promoted_at`) |
| Freeze Handover | Write a handover from the current registry |
| Extract | Run the scanners over the codebase to produce the code map |
| Link | Match consumes against provides into edges |
| Adopt | Splice a built container's components into the design |
| Grill-me | The interview that turns gaps in a design into questions and draft decisions |
| Classify | Record which stage should have caught an escape |
| Trust | The one-time human decision that a folder's commands may run |

## States

| Term | Definition |
|------|-----------|
| minted | A decision or proposal that exists but is not agreed |
| checked | Listed as a decision status; no code acts on it |
| bound | A decision a human has promoted. The only status that does not block the gate |
| superseded | A decision replaced by another |
| ready | The gate has no blocking clause |
| open / resolved | A needs-decision before and after its resolving event |
| matched / undeclared / unmapped / neutral | Drift status of a rel |
| unrealised | In the design, absent from the as-built model |
| passed / failed / blocked / running | Task status |
| pass / fail | Check outcome |
| dirty | A buffer with unsaved edits |

## Agreed, not yet built

| Term | Definition |
|------|-----------|
| Promoted against | What a decision was promoted against: element fingerprints, or a requirement version |
| Business decision / technical decision | `kind` of a decision: settles a rule in a requirement / constrains the design |
| Shared fate | Elements that fail together because of nesting or placement |
| Acceptance criterion | A file in `acceptance/`: what one UI element must do, bound to a requirement and optionally a decision. |
| Case | One given/when/then entry in an acceptance criterion, for one state. Not "scenario", which is a quality attribute scenario |
| State | `ready`, `loading`, `empty`, `error` or `forbidden`: a condition of a UI element every criterion must cover |
| Locator | A declared role and accessible name a case may refer to; the only way a generated spec finds an element |
| Origin | Where an escape's fault lies: `spec_gap`, `design_error`, `translation_error`, `gate_gap`. Beside caught-by, not instead of it |
| WIP limit | The number of work items active or awaiting a person at once |
| Digest | The Work view's four buckets: needs decision, failed a gate, done, waiting |

## Forbidden Synonyms

| Avoid | Use instead | Reason |
|-------|-------------|--------|
| Workspace, project, repo (for the opened folder) | Registry | The codebase is a separate, read-only folder. "Repo" is kept for the code repositories named by `d.repo` |
| Architecture, diagram (for the source) | Design, model | The drawing is a view; the DSL is the source |
| Relationship, link, connection | Rel (design), edge (code map) | The two sides are kept distinct on purpose |
| Node, box, service | Element, or its kind | "Node" is reserved for deployment nodes |
| Issue, error, violation, lint | Finding | Severity is a field, not the noun |
| Approve, accept (a decision) | Bind | `accept` is an effect; approval is for agent writes |
| ADR | Decision | A decision carries checks and bindings an ADR does not |
| Ticket, story | Requirement | |
| Snapshot, release, baseline | Handover | |
| Log, audit trail | Ledger | "Log" is the output panel |
| Reverse-engineered model, actual | As-built, code map | |
| Bug, defect, regression | Escape | An escape is defined by the stage it got past |
| Scan (for the whole operation) | Extract | Scanners are the per-language part |
| Persona, mode, agent type | Role | |
| Permission (for the policy answer) | Verdict | "Permission" is the ACP agent's own request |
| Ready-check, DoR | Gate | |

## Slice 22

| Term | Definition |
|------|-----------|
| Acceptance criterion | What a person sees in each state of a UI element, written before the build: `acceptance/*.yaml`, one case per required state |
| UI-facing | An element tagged `UI`; a requirement is UI-facing when any of its elements is |
| Hosted spec | A screen spec with a `host {screen, state, anchor}` field: an overlay (such as a popover) that opens over a state of another screen's spec, by clicking the anchor placement. It uses a template such as `popover-form`; the commit and its outcome state stay on the host. `hostRules` in `renderer/ui.js` checks it across specs. Also called an overlay |
| Scenario test | The Vitest browser test designc generates from a bound structured test scenario and one of its examples, at freeze: it clicks through the steps and expects the request body the scenario's effect names. Frozen in the handover at `ui-contract/tests/<screen>.scenarios.page.test.tsx`, listed in `scenarios.json`; the agent never edits it, the Factory runs it |
| Design tokens | Value | `design-tokens/tokens.json`, a W3C token file copied into each handover; text size tokens have a minimum |
| UX rule | Value | The `ux` block of an acceptance criterion: keyboard, focus order, focus return, breakpoints |
| Required state | A state a criterion must have a case for: ready, loading, empty, error, and forbidden behind a sign-in |
| Item handover | A handover frozen for one work item: the whole model with the item's elements marked `in_scope`, and only the requirement, decisions, scenarios and evals it touches |
| Scoped gate | The gate seen from one work item: only clauses that touch its elements, plus model-wide ones such as parse errors |
| Freeze horizon | Items frozen and not yet done, against WIP + 2 |
| Digest | The Work view's four buckets: needs a decision, failed a gate, done since last look, waiting |
| Work item | A file in `work/`: one requirement plus a subset of its elements (repo), or one target (document, jira, investigation), with its `done_when`. Backlog until Start, active until Done |
| Done-when | The entries that define a work item as done: `gate`, `checklist`, `review`, `judge` (shown, never required, never alone). Not "check", which is a decision's command |

## Slices 10 to 12

| Term | Definition |
|------|-----------|
| Deployment environment | A named `deploymentEnvironment` block (Live, Staging) holding deployment nodes. Parsed into `model.deployment`, never into `elements` |
| Container instance | A container placed on a deployment node; resolves to its element by identifier |
| Lost | In unavailable mode, an element whose every instance sits under the failed deployment node |
| Survivor | An element with an instance under the failed node and another elsewhere: reduced capacity, still up |
| Scenario | A quality attribute scenario in `scenarios/*.yaml`: stimulus, artifact, response, measure |
| Variance (extraction) | Process | Two independent extractions of one requirement page (run a, then run b in a fresh context), compared per BR sentence (`TestScenarios.diffRuns`) on screen, steps, operation and examples; a disagreement becomes a question on the scenario, which blocks binding. Not the spec variance. | |
| Run tag | Value Object | The `run:` a minted test scenario carries (`a`, `b`, ...): which extraction it came from. | |
| BR coverage | How many sentences of a requirement's imported page a structured test scenario quotes in its `source` (`TestScenarios.coverage`), shown as `covered/total sentences` on the requirement in the sidebar. Display only: not a gate clause (D6). Commit coverage and open questions do gate. Needs the import folder chosen in the session |
| Test scenario | One case in `test-scenarios/<id>.yaml` that proves part of a requirement, written by an agent from the requirement's page or by QA. **Flat**: `given`, `when`, `then` as sentences (a record with none of `screen`, `steps`, `effect`). **Structured**: `screen`, `steps` (verb plus locator plus value), `effect {operation, body, then_state}`, `given` as data, `examples`, `questions`, `source` (the page sentence, verbatim). `status` is `minted` (an agent proposed it, a person approved the card) or `bound` (a person pressed Bind); a scenario with open `questions` cannot be bound. `mint_test_scenarios` refuses a structured one whose source is not in the page, locator not in the screen's spec, operation not in a pinned OpenAPI file, commit without examples, or placeholder without a value (`renderer/test-scenarios.js`). Not the quality attribute scenario (`scenarios/*.yaml`) and not the parity scenario (`parity/scenarios/*.yaml`, the executable steps that may prove it through `test_scenarios`). `examples` may carry `given`/`then` rows (see Example rows). Two gate clauses (B4): a committing transition with no bound scenario with examples, and open questions |
| Fitness function | A shell command attached to a scenario; each run is a `fitness` ledger event |
| Effects | What a landing touches beyond its own nodes, read off the as-built model and never written: callers (through the component, or `via: container`), readers of a store, async consumers, and `unknown` rows where the map cannot say. One hop forward only (`Landing.effects`). | |
| Approval | A person's act of saying a landing note is where the requirement lands. The file records `approved: {by, at, hash, map_commit, effects}` and the ledger gets `landing_approved`; the note counts as approved only when both match its content (`Landing.approvalState`). An edit returns it to proposed. Human only. An approved, unchanged note travels in the handover as `landing.json` and BUILD.md's "Where it lands", and answers `review: landing`. | |
| Correction | A person changing what an agent proposed (`proposed` keeps the agent's version). A corrected note cannot be approved until `correction` names a principle the model now holds or a lint rule proposal that exists, so the next proposal can improve. | |
