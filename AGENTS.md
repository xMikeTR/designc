# AGENTS.md: designc desktop

Technical context for coding agents (and people) changing this codebase. Read this before editing. It describes what exists as of version 0.1.0; where the code and this file disagree, the code wins and this file should be fixed in the same change.

## What designc is

designc is an Electron desktop IDE for system design in which the design is the source of truth and code is a build output. It hosts three systems of a design-to-code factory in one window:

| View | System | Purpose |
| --- | --- | --- |
| Design | System 1, design compiler | Structurizr DSL model with `d.*` design properties, live lint (DC000 to DC006), C4 sheet, decisions, requirements, definition-of-ready gate, grill-me, handover |
| Code map | As-built | Deterministic extraction of a .NET and JS/TS codebase into a C4 model with evidence, down to component level, overlaid on the design as drift (`Core.driftModels` for containers, `Core.driftComponents` for components) |
| Build | System 2, coding pipeline | Agent runs from Langfuse plus pipeline events from the ledger: tokens per passing task, reruns, decision check results, needs-decision items, drift |
| Improve | System 4, improvement loop | Escapes by the stage that should have caught them, rule health, proposals, escape suggestions from telemetry |
| Deployment | As designed | Read-only view of one declared deployment view or whole `deploymentEnvironment` (picker; default `designc.json` `deployment`); click a node to see what is lost and what goes down if it is unavailable |
| Agent panel | All | Chat pane with roles (Architect, Grill-me, Analyst). Three agent kinds: built-in through an OpenAI-compatible gateway, any Agent Client Protocol (ACP) agent, or a remote AG-UI agent service such as a MAF host |

The governing principle, which every change must preserve: **probabilistic components propose; deterministic components and humans decide.** Agents never write anything without a policy check and, for writes, an explicit human approval.

## Stack and conventions

The app is plain Electron 33 with vanilla JavaScript. There is no framework, no bundler and no TypeScript. Monaco (0.52, AMD build) is loaded from `node_modules/monaco-editor/min/vs`, and js-yaml from its UMD bundle. Keep it that way unless there is a strong reason: the renderer is loaded as classic scripts from `file://` under a strict CSP.

Code style: 2-space indent, single quotes, semicolons, small pure functions, `const` over `let`. Renderer files share one global script scope: `app.js` declares the state object `A` and helpers (`$`, `esc`, `plural`, `trunc`, `hash`, `fmtN`, `when`, `nextId`, `debounce`, `toast`, `yamlList`, `yamlStr`, `readText`, `openFile`, `save`, `recompile`, `renderAll` and others) that `agent.js` uses directly. Do not introduce ES modules into the renderer without converting all three renderer scripts.

Every HTML string built in the renderer must pass user or file content through `esc()`. There is no templating library; `innerHTML` is used throughout, so escaping is the XSS boundary.

UI text follows plain, specific wording: sentence case, no ALL CAPS except VS Code-style sidebar section headers, no exclamation marks. Error messages say what happened and what to do next.

## Running, building, testing

```
npm install
npm start                        # opens the app
npm start -- /path/to/registry   # opens straight into a registry folder
npm run dist:win | dist:mac | dist:linux   # electron-builder installers in dist/
```

Requires Node 20 or later. Installers are unsigned.

There is no unit test runner in this repo. Tests are done three ways. Note that mock servers must be started in the same shell command as the app when running under a sandbox that kills background processes between commands.

The three ways, and a change should use whichever applies:

1. **Core logic in Node.** `renderer/core.js`, `extract.js` and `telemetry.js` are plain CommonJS-compatible modules and can be required from Node directly, for example `node -e "const C=require('./renderer/core.js'); ..."`. The compiler core must keep producing the same findings as the Python CLI in `python/designc` (same rule codes, messages and severities; `test/designc-cli.test.js` compares them) on `sample-registry/model/workspace.dsl`: 2 errors (DC002, DC004), 4 warnings (DC001, DC003, DC005, DC006, two of them `unknown`), 1 suppressed (DC005 on Cat Model Adapter).
2. **Headless app runs.** `main.js` has a screenshot harness enabled only by environment variables: `DESIGNC_SNAPSHOT=<prefix>` and `DESIGNC_STEPS='<JSON array of renderer scripts>'`. It waits 4 s after load, runs each script with `executeJavaScript` (logging `[step] <result>`), waits 1.5 s, writes `<prefix>-N.png`, then quits. Renderer console errors are printed as `[renderer] ...`. On Linux: `xvfb-run -a -s "-screen 0 1440x920x24" npx electron . --no-sandbox --disable-gpu /path/to/registry`. Always run against a copy of `sample-registry` (and `sample-codebase` copied as a sibling named `designc-sample-codebase`) because flows write files.
3. **Mocks.** `dev/mock-agui-server.js` is a scripted AG-UI service shaped like a MAF host on port 8790 (set `MOCK_REGISTRY` to let its approved tool write the model, and `EXPECT_AUTH` to require a bearer header). `dev/mock-gateway.js` is a scripted OpenAI-compatible streaming gateway (tool calls included) on port 8765. `dev/mock-acp-agent.js` is a scripted ACP v1 agent that connects to designc's MCP server, sends a plan, asks permission, writes through `fs/write_text_file`, attempts a write outside the registry, and mints a decision over MCP. Set `MOCK_BYPASS=1` in its env to also make it write a file directly on disk and append a forged check to the ledger (both must be flagged as `unapproved_change`), and attempt two ACP writes designc must refuse: a path that leaves the registry through `..`, and a decision with `status: "bound"`.

## Process model

| Process | Files | Responsibilities |
| --- | --- | --- |
| Main | `main.js`, `acp.js`, `extract.js`, `telemetry.js` | Owns the file system, scoped to the open folder; file watcher; ledger appends; decision check runs; LLM gateway calls; Langfuse reads; codebase extraction and search; ACP agent processes; the MCP bridge HTTP server; menus |
| Preload | `preload.js` | The only bridge. Exposes `window.host` via `contextBridge`. Context isolation on, Node off in the renderer, sandbox on |
| Renderer | `renderer/index.html`, `core.js`, `app.js`, `agent.js`, `styles.css` | All UI and all policy decisions for agents: compiler, views, panels, approvals |
| MCP server | `designc-mcp.js` | Stateless stdio MCP server launched by ACP agents. Forwards `tools/list` and `tools/call` to the main process over 127.0.0.1 with a per-run bearer token; the main process asks the renderer |

Security invariants in the main process: every registry path goes through `inside(rel)`, which calls `confine` in `paths.js`: it rejects anything outside the open folder, lexically and after resolving symlinks. Child processes (check runner, ACP agents) get `childEnv`, the environment minus names that look like secrets (KEY, SECRET, TOKEN, PASSWORD, CREDENTIAL, AUTH); `designc.json` `inheritEnv` (checks) and `acpAgents.<key>.inherit` list names to pass through anyway. Codebase paths go through `codebaseDir(p)` and the `codebase:read` handler rejects escapes. Codebase access is read-only everywhere. `will-navigate` is blocked and external links open in the system browser.

## File map

| File | Lines | What it holds |
| --- | --- | --- |
| `main.js` | ~390 | Window, menus, IPC handlers, file watcher, check runner with folder trust, gateway chat (streaming SSE with tool-call assembly), codebase search, MCP bridge server, ACP hub wiring, UI request/reply (`askUi`), snapshot harness |
| `preload.js` | ~40 | `window.host` API (see IPC contract) |
| `paths.js` | ~30 | `confine(root, rel)` (symlink-aware path scope) and `childEnv(env, inherit)` (secret-free child environment). Pure Node, requirable from tests |
| `acp.js` | ~125 | `AcpConnection` (spawn, newline-delimited JSON-RPC 2.0) and `AcpHub` (connect, prompt, cancel, handle agent-to-client requests) |
| `designc-mcp.js` | ~50 | Stdio MCP server proxying to the app |
| `extract.js` | 3 | Shim: `module.exports = require('./extract/index.js')`, kept so `require('./extract')` and the packaged build still resolve |
| `extract/index.js` | ~90 | Walks the repo once, runs every registered scanner (`extract/csharp.js`, `extract/js.js`) over a shared `ctx`, merges Facts, calls `extract/link.js`, renders via `extract/dsl.js`, computes stats |
| `extract/csharp.js` | ~330 | Deterministic .NET scanner (moved verbatim from the old `extract.js`, then hardened): EF/Redis/Blob/Cosmos stores, `AddHttpClient` sync edges, Service Bus sender/processor as queue `consumes`/`provides`, minimal-API/controller/Functions HTTP routes, `MapHub`, Service Bus attributes, and the shared `extract/catalogue.js` SDK list |
| `extract/js.js` | ~130 | JS/TS package discovery (SPA/Node API/library classification from `package.json` deps, dev port, source ownership by deepest package dir) and Express/router HTTP route detection (`provides`, route mounts followed across files) |
| `extract/js-calls.js` | ~200 | Outbound HTTP/hub/SDK call detection: fetch/axios/ky (direct or through a same-module base+path wrapper), Vite dev proxy, SignalR `.withUrl`, Azure Service Bus sender/receiver, and the shared `extract/catalogue.js` SDK list |
| `extract/link.js` | ~110 | Matches `consumes` against `provides` across scanners into edges and `unresolved`: queue by exact key; http/hub by exact key or whole-segment prefix (longest wins), grouped by provider deployable with a `devTarget`-port tie-break when more than one deployable matches; `opts.bindings` resolves env-only consumes to a named element (existing or newly created) with synthetic `designc.json` evidence |
| `extract/dsl.js` | ~15 | Renders merged elements/edges as workspace DSL text |
| `extract/catalogue.js` | ~15 | The only place shared external/store names live (Entra ID, Key Vault, Snowflake, etc.) |
| `extract/components.js` | ~170 | Component seam: assigns each scanner unit to one component per owner container (overrides first, then the language rules), builds `facts.components` and `facts.componentEdges`, pins container edges to components |
| `extract/components-cs.js`, `extract/components-js.js` | ~180, ~100 | Per-language assignment (C# anchors, output-binding types, DI and type references; JS/TS support and grouping folders, import edges) |
| `extract/glob.js` | ~25 | Pure `**`/`*`/`?` matcher for `designc.json` `extract.components` paths |
| `telemetry.js` | ~120 | Langfuse reader (Observations API v2, Scores API v3), normalised into runs |
| `renderer/core.js` | ~450 | Design compiler: DSL tokenizer and parser, IR, property schema, rules DC000 to DC006, suppressions, gate, ledger drift, model drift |
| `renderer/app.js` | ~1130 | Workbench: state `A`, registry loading, Monaco setup and Structurizr language support, tabs, sidebar views, problems and output panels, status bar, C4 drawing (`layout`, `drawModel`), code map, dashboards, checks, grill-me and proposal drafting buttons, telemetry aggregation, events |
| `renderer/agent.js` | ~460 | Agent panel: roles, fail-closed policy, tool definitions, readers and writers, shared `runTool`, built-in loop, ACP client side, MCP call handling, write policy, bypass detection, rendering |
| `git.js` | ~150 | Main-process git, no Electron: the only caller of the git binary. `execFile` with fixed argument arrays, hardened config, reduced env, confined to the registry by pathspec (the registry may sit inside a larger repo). `findRepo`, `status`, `refs`, `log`, `show` (full commit hash only), and the daily-loop writes `stage`, `unstage`, `commit` (message on stdin; refuses when files outside the registry are staged), `branch`, `switchTo` (existing branch names only), `fetch`, `pull` (`--ff-only`), `push` (never forces; refuses with no upstream), `publish` (first push, exactly one remote), `hasLedgerUnion`/`addLedgerUnion` (`ledger/*.jsonl merge=union`). Hooks never run. `test/git.test.js` covers it |
| `renderer/gitview.js` | ~90 | Classic script after `app.js`: status bar git item, History section for the open file, Compare tab (Monaco diff editor, revision on the left, read-only), and the Source control view (branch, fetch/pull/push, stage, commit; a successful commit records a `gate` event through `recordGate`). Refuses switch and pull while any buffer is dirty, then reloads the folder. Escapes all git output |
| `renderer/policy.js` | ~55 | Agent policy, pure and requirable from Node like `ledger.js`: `WRITE_TOOLS`, `WRITE_PATHS`, `verdict(cfg, tool)`, `writeVerdict(role, rel, content, parseYaml)`, `unapprovedChanges(paths, {approved, ownAppends, now})`. `agent.js` calls it; `test/policy.test.js` covers it |
| `python/designc/` | ~900 | The Python CLI, `designc check <registry>`: `dsl.py` (tokenizer and parser), `rules.py` (SPECS, DC000 to DC006, `check`, `fingerprint`, `slug_id`), `gate.py` (gate and scenario report), `registry.py` (settings, YAML dirs, ledger, handover ids), `ledger.py` (the one Python append path, schema in `ledger_schema.json`), `record.py` (gate event, git state of gate inputs), `verify.py` (`verify-ledger`), `cli.py`. Standard library plus PyYAML. `test/designc-cli.test.js` runs it and `core.js` on the same folders and compares findings and gate clauses |
| `renderer/styles.css` | ~290 | Theme tokens (light and dark via `prefers-color-scheme`), workbench layout grid, all component styles |
| `integrations/DesigncTelemetry.cs` | ~85 | .NET sketch of the Langfuse tagging convention for the MAF harness (not compiled here) |
| `sample-registry/` | | Worked example: pricing engine model, decision, requirement, P model, sample ledger, sample Langfuse data, `designc.json` |
| `sample-codebase/` | | Small .NET solution matching the pricing engine, with one undeclared dependency and one legacy store |
| `dev/` | | Mock gateway, mock ACP agent, mock AG-UI service |
| `integrations/maf-agui-host/` | | Sketch of the MAF host exposing Grill-me and Architect over AG-UI (uncompiled) |

## IPC contract (`window.host`)

Invoke methods (renderer to main, returning a promise):

| Method | Channel | Returns |
| --- | --- | --- |
| `boot()` | `app:boot` | `{recent, root, user, platform}` |
| `openFolder()`, `openPath(p)`, `openSample()` | `folder:*` | `{root, name}` or null |
| `tree()` | `fs:tree` | Nested `{name, path, dir, children}`; skips `.git`, `node_modules`, `bin`, `obj` and similar |
| `read(rel)`, `exists(rel)`, `write(rel, text)` | `fs:*` | Registry-scoped. `write` creates folders |
| `list(dir, exts)` | `fs:list` | `[{path, text}]` for files in one folder |
| `appendLedgerEvent(event)` | `ledger:event` | The single append path (R-5): validates `event` against the ledger schema (`renderer/ledger.js`), routes it to the right stream file by `kind`, stamps the envelope, and appends. Returns `{ok, errors}` on failure; writes nothing if invalid. Called only by `sendLedgerEvent` (both `recordEvent` for designc kinds and `recordSessionEvent` for harness kinds) |
| `runCheck(id, cmd)`, `cancelCheck(id)` | `check:*` | `{code, ms}` or `{cancelled}`. Asks to trust the folder on first use. Output streams on `check:output` |
| `gitStatus()`, `gitTrust()`, `gitRefs()`, `gitLog(rel, max)`, `gitShow(hash, rel)` | `git:*` | Read-only git. `gitStatus` is `{repo:false}`, `{repo:true, trusted:false}` or the status; every other call returns `{error}` until the folder is trusted. One trust decision (`ensureTrusted`) covers checks and git. No agent tool reaches git |
| `gitStage(paths)`, `gitUnstage(paths)`, `gitCommit(message)`, `gitBranch(name)`, `gitSwitch(name)`, `gitFetch()`, `gitPull()`, `gitPush()`, `gitPublish()`, `gitAttrs()`, `gitAddUnion()` | `git:*` | `{ok}` (`gitCommit` also `hash`; `gitAttrs` returns `{union}`) or `{error}`. Same trust gate. Nothing forces; the renderer cannot pass flags |
| `chat(messages)` | `llm:chat` | Non-streaming gateway call used by the grill-me and draft buttons: `{text}` or `{error}` |
| `agentChat(id, payload)`, `agentCancel(id)` | `agent:*` | Streaming gateway call with tools: `{message, usage, model}`, `{cancelled}` or `{error}`. Text deltas on `agent:delta` |
| `chooseCodebase()` | `codebase:choose` | Path relative to the registry if possible |
| `extract(p)` | `codebase:extract` | `{dsl, facts, stats}` or `{error}` |
| `readCode(p, rel)`, `searchCode(p, q, max)` | `codebase:*` | Read-only codebase access |
| `telemetry()` | `telemetry:fetch` | `{runs, meta}` or `{error}` |
| `acpAgents()` | `acp:agents` | `{key: {label, command}}`, presets merged with `designc.json` |
| `aguiAgents()` | `agui:agents` | `{key: {label, url, clientTools, sendState}}` from `designc.json` `aguiAgents` |
| `aguiRun(id, key, body)`, `aguiCancel(id)` | `agui:*` | POSTs a RunAgentInput and streams SSE; each event arrives on `agui:event` as `(id, event, n)`. Returns `{ok, events}` or `{error}` or `{cancelled}` |
| `acpConnect(key, meta)`, `acpPrompt(key, text)`, `acpCancel(key)`, `acpDisconnect(key)` | `acp:*` | Connect returns `{info}` or `{error}`; prompt returns `{stopReason}` or `{error}` |
| `uiReply(id, value)` | `ui:reply` | Answers a `ui:call` |

Events (main to renderer), subscribed with `host.onX(fn)` or `host.onAcp(channel, fn)`: `cmd` (menu commands), `fs:changed` (debounced list of changed relative paths), `folder:opened`, `check:output`, `agent:delta`, `acp:update`, `acp:log`, `acp:exit`, `agui:event`, and `ui:call`.

IPC events and invoke replies are **not ordered** relative to each other. `agui:run` therefore returns the number of events it sent, and the renderer's `drainAgui(n)` waits until it has handled that many before acting on the run's outcome. Without this, a final `RUN_FINISHED` carrying an approval interrupt can be dropped. Apply the same pattern to any new streaming channel whose last event matters.

`ui:call` is a request/reply channel from main to renderer (`askUi` in `main.js`): channels `acp:permission`, `acp:write`, `mcp:list` and `mcp:call`. The renderer must always reply through `host.uiReply(id, value)`, including on error, or the agent hangs.

Menu commands sent on `cmd`: `save`, `close-tab`, `view:explorer|design|codemap|build|improve`, `toggle-sheet`, `toggle-agent`, `panel:problems`, `panel:output`, `run-checks`, `grill`, `extract`, `freeze`, `open-settings`, `help:props`.

## The registry folder (the contract)

designc opens a registry folder. Everything is plain files so git provides review and history.

| Path | Format | Written by |
| --- | --- | --- |
| `model/workspace.dsl` | Structurizr DSL subset with `d.*` properties | Human, approved agent edits |
| `behaviour/*.p` | P models | Human |
| `requirements/*.yaml` | `id, title, source, version, elements[]` | Human |
| `decisions/*.yaml` | See below | Human; agents create `minted` only |
| `proposals/*.yaml` | `id, status, kind, evidence, statement, check` | Human; agents create `minted` only |
| `scenarios/*.yaml` | Quality attribute scenarios: `id, title, attribute, artifact, stimulus, response, measure, fitness[]` | Human |
| `handovers/*.yaml` | `id, revision, created, by, model, requirements[], decisions[]` | Freeze Handover |
| `asbuilt/workspace.dsl`, `asbuilt/facts.json` | Generated as-built model and evidence | Extract Code Map |
| `ledger/*.jsonl` | One JSON event per line, append-only | Pipeline, app, agents |
| `telemetry/` | Sample Langfuse data (sample registry only) | |
| `designc.json` | Settings | Human |

Decision file:

```yaml
id: D-0001
status: minted          # minted | checked | bound | superseded
effect: fix             # fix (the model changes) | accept (keep the risk)
requirement: HRE-1234
binds: [Quotes DB]      # design element names
resolves: [DC002]       # finding codes
statement: "Quote writes use optimistic concurrency"
checks:
  - "p check -tc tcOptimistic"
rationale: "..."
```

`designc.json`:

```json
{
  "model": "model/workspace.dsl",
  "deployment": "Live",
  "evidenceHosts": ["jira.example.com"],
  "codebase": "../pricing-repo",
  "chainHops": 4,
  "llm": { "baseUrl": "https://gateway/v1", "model": "claude-sonnet", "apiKeyEnv": "DESIGNC_LLM_API_KEY", "litellmMetadata": true },
  "langfuse": { "baseUrl": "https://cloud.langfuse.com", "publicKeyEnv": "LANGFUSE_PUBLIC_KEY", "secretKeyEnv": "LANGFUSE_SECRET_KEY",
    "lookbackDays": 14, "tags": ["designc"], "outcomeScore": "task_passed", "sampleFile": "",
    "fields": { "system": "system", "element": "element", "task": "task", "decision": "decision", "outcome": "outcome", "attempt": "attempt" } },
  "agents": { "architect": { "model": "...", "instructions": "...", "allow": [], "ask": [], "deny": [] } },
  "acpAgents": { "claude": { "label": "Claude Code", "command": "npx", "args": ["-y", "@agentclientprotocol/claude-agent-acp"], "env": {}, "enabled": true } },
  "aguiAgents": { "maf-architect": { "label": "Architect (MAF)", "url": "http://127.0.0.1:5100/architect", "headers": { "Authorization": "Bearer ${env:DESIGNC_MAF_TOKEN}" }, "clientTools": true, "sendState": true } }
}
```

Secrets never live in `designc.json`: only the names of environment variables that hold them, or `${env:NAME}` references in AG-UI header values.

### Ledger envelope v1

`renderer/ledger.js` (dual-loaded like `core.js`: `<script>` in the renderer, `require()` from `ledger-store.js` and tests) owns the schema. Every event has a `designc_v1` envelope: `schema_version: 1`, `event_id`, `ts` (epoch ms), `kind`, `by`, plus the kind's own fields. Two rules make this the one append path: `ledger-store.js` (`appendEvent`) validates against `Ledger.validate`, stamps the envelope, routes by `kind` to its stream file, and appends — it is the only writer; there is no legacy bridge and no code anywhere hand-rolls a `ledger/*.jsonl` line (`test/ledger-guard.test.js` asserts this). `Ledger.order(events)` merges the per-file streams: it drops a repeated `event_id` and stable-sorts by `_ts`, so a union-merged ledger reads the same in any order. Escape ids are minted by `Ledger.escapeId(uuid)` (`E-` plus 8 hex), not counted. `Ledger.parse` upcasts pre-v1 lines that have no `schema_version` (`_legacy: true`, a synthetic `event_id`) so old and new lines read back as one stream; a line carrying an `envelope_version` instead is a `harness_v1` (System 2 / MAF) event, a disjoint kind set in the same files, not a designc kind.

**Two envelopes.** `harness_v1` is the grill-me / MAF session and charter envelope (`Ledger.HARNESS_KINDS`, 15 PascalCase kinds — `SessionStarted`, `GateFailed`, `NeedsDecision`, `HumanDecision`, etc. — ported as-is from the harness's own `event.py`), routed to `ledger/sessions.jsonl` via `Ledger.validateHarness` and `recordSessionEvent`. It is disjoint from the designc kind set (R-3): a designc kind carrying `envelope_version`, or a harness kind carrying `schema_version`, is rejected. `parse()` dispatches per line on which version key is present and stamps every loaded event with `_ts` (epoch ms; designc keeps its numeric `ts`, harness's ISO `ts` is `Date.parse`d) — `Core.latestCheck` and the Improve escape sort read `_ts`, never the raw `ts`. `Ledger.resolvedEventIds(events)` finds harness `NeedsDecision` events a `HumanDecision.payload.cites_event_id` has answered; the designc `needs_decision` kind is still resolved by `needs_decision_resolved` via `derive()` — the gate only ever counts the designc kind (R-4), so an open harness `NeedsDecision` never blocks it.

The ledger is append-only. The app never rewrites a line; state changes are later events that `Ledger.derive()` folds in (`escape_classified` sets an escape's `caught_by`; `needs_decision_resolved` closes a needs-decision).

| `kind` | Key fields | Source |
| --- | --- | --- |
| `task` | `task, status (passed/failed/blocked/running)` — v1-locked: `title?, element?, reruns?, turns?, tokens?, tokens_in?, tokens_out?, cost?, model?, tier?`. `Ledger.totalTokens(ev)` sums `tokens_in`+`tokens_out`, falling back to `tokens`, else `0` | Pipeline |
| `check` | `decision, check, outcome (pass/fail), source (local/pipeline), ms?, exit_code?, reason?` — v1-locked: `exit_code` or `reason` is required when `outcome` is `fail` | Pipeline, or the app's check runner (`checks.jsonl`) |
| `needs_decision` | `id, question, status (open/resolved)` — v1-locked: `task?, element?` | Pipeline |
| `needs_decision_resolved` | `id` | App (`designc.jsonl`) |
| `asbuilt_edge` | `from, to` — v1-locked | Pipeline (legacy drift source; the code map supersedes it) |
| `escape` | `id, description` — v1-locked: `element?, task?` (envelope-optional), `code?, caught_by? (Ledger.CAUGHT_BY member or null), source?, traces[]?`. Legacy `rule`/`stage` names are upcast to `code`/`caught_by`, no longer accepted on a v1 write | Pipeline, or the app from telemetry |
| `escape_classified` | `escape, caught_by` — v1-locked: `caught_by` is required (nullable — `null` means "not classified"), must be a `Ledger.CAUGHT_BY` member or `null`. Legacy `stage` is upcast to `caught_by` | App |
| `false_positive` | `code` — v1-locked: `note?` | Human or pipeline |
| `handover` | `handover, revision` — v1-locked: `commit? (string or null), dirty?` | App (`freezeHandover`) |
| `gate` | `source (local/pipeline), revision, ready, verdict, clauses[], findings[]` — v1-locked: `commit?, dirty?`. A snapshot of what the gate said (no messages, lines or hints); `verdict` is `hash16` of the canonical JSON of `{ready, clauses, findings}`. Skipped when the latest event from the same source has the same revision, commit and verdict | `designc check` (`python/designc/record.py`, `checks.jsonl`) |
| `fitness` | `scenario, check, outcome (pass/fail), source (local/pipeline)` — v1-locked: `ms?, exit_code?, reason?`; `exit_code` or `reason` required on `fail` | App's fitness runner (`checks.jsonl`) |
| `decision_promoted` | `decision` — v1-locked: `fingerprints[]?` (`{element, name, hash}`) | App (`bindDecision`, `designc.jsonl`) |
| `extraction` | `repo, revision, projects, deployables, tests, elements, edges, unresolved` — v1-locked. Any other stat (e.g. `modules`) goes under `payload.stats` | App |
| `agent_turn` | `agent, role, via (builtin/acp/agui)` — v1-locked: `model?, ms?, tokens?, tokens_in?, tokens_out?, stop_reason?, context_used?, run_id?` (envelope-optional: `system, session`). Builtin turns keep `tokens`; ACP turns use `context_used`/`stop_reason`, not `tokens`/`stopReason`; AG-UI turns use `run_id`. Legacy `stopReason`/`runId`/`tokens` are upcast with `via` inferred | Agent panel (`agents.jsonl`) |
| `agent_tool` | `agent, role, tool, verdict (allow/ask/deny/agent), outcome, via (builtin/designc/acp/agui)` — v1-locked: `tool_kind?, path?`. Legacy `toolKind` is upcast to `tool_kind` | Agent panel |
| `agent_permission` | `agent, role, tool, outcome, via (acp)` — v1-locked: `tool_kind?`. Legacy `toolKind` is upcast to `tool_kind` | Agent panel (ACP) |
| `agent_approval` | `agent, role, tool, interrupt, outcome, via (agui)` — v1-locked | Agent panel (AG-UI interrupts) |
| `unapproved_change` | `agent, role, path, via (acp/agui)` — v1-locked. Legacy lines with no `via` are upcast to `acp` | Agent panel |

Events with `"sample": true` are sample data and the UI labels them. The Improve view reads `agents.jsonl` back: `Ledger.agentActivity(events)` (pure, `test/agent-activity.test.js`) gives one row per agent and role (turns, tokens, tool verdicts, declined writes, permissions, approvals, unapproved changes), shown as "Agent activity" with an "Unapproved changes" list in `improveDash`.

## The design compiler (`renderer/core.js`)

`Core.parse(src)` tokenizes and parses a Structurizr DSL subset: `workspace`, `model`, `person`, `softwareSystem`, `container`, `component`, identifiers with `=`, `properties`, `tags`, `description`, `technology`, relationships `a -> b "desc" "tech" { properties {...} }` including implicit-source `-> b` inside element bodies. Unknown blocks such as `views` are skipped. It returns a model with `elements` (Map), `rels`, `errors` (with 1-based lines), and helpers `label`, `isAncestor`, `locEl`, `locRel`.

`Core.check(model, {chainHops})` runs `validate` (DC000: unknown `d.*` keys with did-you-mean, malformed values), then every rule in `RULES`, then applies `d.suppress` suppressions. Diagnostics have `{code, sev, msg, loc: {kind, id, label, names, line}, hint, unknown, suppressed, related[]}`.

Properties are **demand-driven**: nothing is globally required. A rule emits an `unknown` warning only where it needs an undeclared property to decide. Keep new rules this way.

`Core.gate({model, diags, decisions, requirements, ledger})` returns `{ready, clauses[]}`. Blocking clauses: parse errors; unsuppressed findings not covered by a bound `accept` decision that binds the element and resolves the code; decisions not bound; bound decisions without checks or without a passing latest check; `fix` decisions whose finding still fires; untraced requirements; open needs-decisions; a repeated decision or requirement id (`duplicate id <id>`); any registry file that does not parse (`<path> does not parse`, from the optional `registryErrors` input, fed by `A.yamlErrors`). A repeated proposal id is shown in Problems, not in the gate.

`Core.slugId(statement, taken)` makes decision and proposal ids from what they say (kebab-case, at most 48 characters, `-2`, `-3` on a clash) so two branches minting at once do not both take the next number. `nextId` remains for handovers only.

**Handover folder.** `Core.handoverPlan({date, now, by, model, requirements, decisions, behaviour, vocabulary})` is pure and returns `{id, files[]}`. The id is `<yyyymmdd>-<hash8>`; the hash covers the copied content only. Freeze writes `handovers/<id>/handover.yaml` (id, revision `r-<hash8 of the model>`, created, by, model path, requirement and decision ids, a path and hash per copied file) plus verbatim copies of the model, requirements, bound decisions, `behaviour/*.p` and `vocabulary/*.yaml` if present. `freezeHandover` refuses while the gate is not ready, any buffer is dirty, or (in a git repository, after asking for folder trust) a gate input has uncommitted changes (`Core.dirtyInputs` over `Core.GATE_INPUTS` plus the model path; `ledger/` is never one), so a handover always names a commit; outside git it records `commit: null`. It records a `gate` event (`recordGate`, skipped when unchanged), then appends a `handover` event with `commit` and `dirty`, then (in a trusted git repo) stages `handovers/<id>` and pre-fills the commit message in Source control for the human to review and commit. `loadRegistry` reads folder handovers beside the older flat `handovers/*.yaml`, ordered by `created`. Agents cannot write under `handovers/` (no role lists it in `WRITE_PATHS`). Extraction needs no skip: it reads source extensions only and a handover holds `.dsl`, `.yaml` and `.p`.

**Business decisions.** A decision carries `kind: business | technical` (absent means technical; anything else blocks). A business decision binds a requirement (`requirement: <id>`), needs no check, and is promoted against that requirement's `version` (`promoted_against: [{requirement, version}]`); bumping the version blocks it as `changed since promotion`. `evidence` is mandatory: an https URL whose host is listed in `designc.json` `evidenceHosts` (no list means no host is allowed). `agreed_by` is optional and human-written. A technical decision with `effect: accept` must list a bound business decision in `relies_on`, else the gate says `<id> accepts a risk without a bound business decision`. Agents may draft business decisions (`mint_decision` with `kind: business`, statement prefixed `PROPOSED:`; grill-me's "Draft business decision" does the same) but `Policy.writeVerdict` refuses any agent write carrying `evidence` or `agreed_by`.

`Core.blastRadius(model, elementId, {mode: 'misbehaves'})` returns `{down[], degraded[], unknown[], paths[]}` (`{id, name}` entries; `paths` is `{to, kind, via[]}`, one shortest route per affected element). It walks relationships backwards from the element, ignoring ancestor/descendant pairs: a sync caller goes `down` and the damage continues through it; an async caller is `degraded` and stops; a caller with no `d.interaction` is `unknown` and stops (nothing is guessed). An element reached several ways keeps the worst class. Any other mode returns `{error}`. The C4 sheet's badge selector has "Badges: blast radius": select a box and the affected boxes show `down`, `deg` or `?`.

`Core.changeImpact(before, after, {decisions, requirements, chainHops})` says what a model change touches: `decisions` (bound or checked, whose bound element or an incident rel changed, was added or was removed, by fingerprint), `requirements` (those tied to an affected decision or listing a touched element), `introduced` and `resolved` findings (keyed by code and element, suppressed and notes ignored) and a `changed` count from `diffModels`. The Compare tab shows it under the semantic summary for `.dsl` files.

`Core.fingerprint(model, elementId)` returns `{hash, content}` for one element: kind, parent, name, technology, every `d.*` (including `d.suppress`) and every incident rel (direction, other end, technology, its `d.*`). Description, tags, comments, whitespace, order, lines, descendants and rel descriptions are left out. The hash is two FNV-1a 32-bit passes as 16 hex digits, and mirrored in `python/designc/rules.py` (over UTF-16 code units, so it matches for any name). `bindDecision` (human only) writes `promoted_against: [{element, name, hash}]` beside `promoted_by` and `promoted_at`, and appends a `decision_promoted` ledger event. `Core.gate` adds clauses `<id> is bound without a fingerprint`, `<id>: <name> changed since promotion` and `<id>: binding <name> does not resolve` (an entry resolves by its recorded identifier, then by name). `Policy.writeVerdict` refuses agent writes to a decision that carries any of the three promotion fields. Decisions bound before this slice have no fingerprint and block until a human re-binds them: `Core.rebindable(gate)` lists the decisions blocked by a `promotion` clause, the decisions list shows Re-bind on each, and the gate shows one "Re-bind N decisions" button (`rebindAll`, one confirmation, human only, same `bindDecision` path). Re-binding records the current state as accepted, so look at the Compare tab first when the design changed.

`Core.latestHandoverModel(handovers)` returns `{id, path}` of the model copy in the newest handover. The Explorer shows "Compare with last handover" on the model file and opens it in the Compare tab, so a folder that is not a git repository can still see what changed since the last freeze.

`Core.diffModels(before, after)` compares two parsed models by meaning and returns `{elements[], rels[], summary}`. Identity: same DSL identifier is the same element (a name change is a rename, a parent change a move); otherwise same normalised name under the same matched parent; otherwise removed plus added. No fuzzy matching and `d.aka` plays no part. Rels are keyed on matched ends plus their ordinal among parallel rels. It diffs `name`, `kind`, `technology`, `parent` (by name) and every `d.*` key; description, tags, order, whitespace and lines never count. The Compare tab calls it through `semanticDiffHtml` in `gitview.js` for `.dsl` files and says so when either side has parse errors.

`Core.driftModels(design, asbuilt)` matches elements by normalised name (lowercase alphanumerics) or `d.aka`, and returns `toDesign`, `toBuilt`, `relStatus` (matched, undeclared, unmapped), `undeclared`, `unrealised`, `unknownEls` and `missingEls`.

`Core.atLevel(model, level)` folds every element deeper than `context`, `container` or `component` into its nearest ancestor at that level, lifting rels (explicit rels beat lifted ones, self-loops drop, ids preserved). `Core.containerLevelText(text)` removes component declarations and any rel touching a component from raw DSL text, leaving every other line byte-identical; it relies on the one-line forms `dsl.js` writes.

`Core.view(model, {level, scope})` projects a model for the Code map: `context` and `container` are `atLevel`; `component` keeps everything, or, with `scope` set to a container id, that container's components plus its neighbours folded to container level. Rollup rels covered by visible component rels are dropped; rel ids are preserved.

`Core.driftComponents(design, built)` judges components only inside a container whose design declares components (*scored*). Components elsewhere are *neutral*, so a container-only design never shows component warnings. It also returns `adoptable` (built containers with components whose design match has none). Rel status adds `neutral` to matched, undeclared and unmapped; cross-container component rels also match the lifted container-level design rel.

`Core.spliceComponents(designText, design, designId, built, builtId)` returns `{text}` or `{error}`. It inserts one built container's components and the rels between them into the design container's block (adding a block if there is none), changing no other line. It refuses if the design container already has components or its block cannot be located. The Code map's "Adopt these components" button calls it, and refuses while the design buffer has unsaved edits.

### Adding a lint rule

Only add rules from an observed incident or post-mortem, and record it in `source`. Add an entry to `RULES` in `core.js` with `code`, `title`, `source`, `doc` and `fn(model, opts)` returning diagnostics built with `D(code, sev, msg, loc, {hint, unknown, related})`. If it needs a new property, add it to `SPECS` in `core.js` and to `PROPS` in `app.js` (completions and hovers). Mirror the rule in `python/designc/rules.py` so CI and the IDE agree; `test/designc-cli.test.js` fails when they differ, so add a case that fires it. Check it fires on the model that motivated it and that the sample findings above are unchanged unless intended.

## Code map extraction (`extract/`)

Deterministic, pattern-based. `extract/index.js` owns the repo walk (SKIP set, file extension filter) and the scanner seam: it builds a shared `ctx = { repo, files, rel, read, opts }`, runs every registered scanner's `scan(ctx)` (`extract/csharp.js`, real; `extract/js.js`, real for package discovery and inbound HTTP routes, delegating outbound calls to `extract/js-calls.js`, also real), merges their Facts (`projects`, `elements`, `edges`, `consumes`, `provides`, `unresolved`), calls `extract/link.js` (passing `opts` through) to match `consumes` against `provides` into edges across languages — including `designc.json` bindings for env-only consumes — and renders the result via `extract/dsl.js`. `opts` comes from `main.js`'s `codebase:extract` handler as `readSettings().extract || {}`, so a `designc.json` with an `extract.bindings` object supplies bindings. Nothing is guessed: anything a scanner sees but can't resolve goes to `unresolved` with file and line instead of becoming an edge.

`extract/csharp.js` (.NET only):

| Source | Becomes |
| --- | --- |
| `.csproj`/`.fsproj` with Web or Worker SDK, or Exe output | Containers, carrying `ports` from `launchSettings.json`. Libraries fold into deployables that reference them transitively; test projects are skipped |
| EF Core `DbContext` subclasses | Stores (`QuotesDbContext` becomes `QuotesDb`), provider from `UseSqlServer` and similar, data edges to deployables whose own sources use the context; `SaveChanges` marks reads and writes |
| `ConnectionMultiplexer.Connect`, `AddStackExchangeRedisCache`, `new BlobServiceClient`, `new CosmosClient` | Stores named by connection string |
| `AddHttpClient` with a base address from configuration | Sync edges, emitted directly (not through `link.js`). localhost URLs match projects by `launchSettings.json` port; other hosts match project names or become external systems named by host |
| Service Bus `CreateSender` | queue `consumes`, matched by `extract/link.js` |
| Service Bus `CreateProcessor`/`CreateReceiver`/`CreateSessionProcessor` | queue `provides`, matched by `extract/link.js` |
| Minimal API `Map(Get\|Post\|Put\|Patch\|Delete\|Methods)`/`MapGroup` | http `provides`, keyed by normalised route. Prefix chains resolve through local variables in a file, and across files when `<var>.Map<Name>()` calls an extension method `Map<Name>(this IEndpointRouteBuilder\|RouteGroupBuilder <p>)` found in the deployable's closure |
| Controller `[Route]` + `[Http(Get\|Post\|...)]` | http `provides`; `[controller]` replaced by the class name minus `Controller` |
| Azure Functions `[HttpTrigger(..., Route = "...")]` (literal or `$"{X.Y}/..."` against a `const string Y` in the closure) | http `provides`, prefixed by `host.json`'s `extensions.http.routePrefix` (default `'api'`, `''` respected) |
| `MapHub<T>('<path>')` | hub `provides` |
| `[ServiceBusTrigger]` / `[ServiceBusOutput]` | queue `provides`/`consumes`; a `'%Name%'` value resolves from `local.settings.json` `Values` or `appsettings`, else carries `env` with `key: null` |
| Functions projects (`Microsoft.Azure.Functions.Worker`) | container `tech` becomes `'Azure Functions (.NET isolated)'` |
| `new SnowflakeDbConnection`/`SqlConnection`/`NpgsqlConnection`, `new SecretClient`, `AddJwtBearer`/`AddMicrosoftIdentityWebApi`/`GetSection("AzureAd")`, `APPLICATIONINSIGHTS_CONNECTION_STRING`/`AddApplicationInsightsTelemetry`, PackageReference `NewRelic.Agent` | catalogue stores/externals via `extract/catalogue.js` (Snowflake, SQL Server, PostgreSQL, Key Vault, Entra ID, Application Insights, New Relic) |

Configuration is read from `appsettings.json` and `appsettings.Development.json` (comments stripped, keys flattened with `:`, case-insensitive), searched across the deployable's reference closure. To add a pattern, add a scan over the source-line array and attach evidence with `ev(s)`; prefer adding to `unresolved` over inventing a target. `extract/catalogue.js` is the only place shared external/store names live — reuse it rather than inventing a spelling. Roslyn-based extraction is the intended upgrade when patterns stop scaling.

## Telemetry (`telemetry.js`)

Uses `GET /api/public/v2/observations` (cursor pagination, `fields=core,basic,usage,metadata,model,trace_context`, `expandMetadata` for the mapped keys, optional `tags` filter) and `GET /api/public/v3/scores`. Do not use `/api/public/traces` or the v1 observations endpoint: they are removed on Langfuse Cloud on 16 November 2026 and on self-hosted v4. Rows are grouped by `traceId` into runs `{traceId, projectId, name, start, durationMs, system, element, task, decision, attempt, outcome, tokens, cost, generations, model, errors, firstError, tags, url}`. Outcome comes from the mapped metadata key, else the outcome score (1 is passed), else `error` if any observation has level ERROR, else `unknown`. When keys are missing and `sampleFile` is set, the same normaliser runs on a local file in the same response shapes. Aggregation into tasks and elements lives in `telAgg()` in `app.js`.

## Agent panel (`renderer/agent.js`)

### Roles and policy

`ROLES` defines `architect` (S1), `grill` (S1) and `analyst` (S4), each with `allow` (reads), `ask` (writes needing approval), `instructions` and starter prompts. `roleCfg(role)` merges overrides from `designc.json` `agents`. `verdict(role, tool)` (rules in `Policy.verdict`) **fails closed**: `deny` wins, then `ask`, then `allow`, and anything unlisted is `deny`. A write tool (`Policy.WRITE_TOOLS`) listed under `allow` in `designc.json` still returns `ask`: settings can deny a write tool, never make it silent. Tools not permitted for a role are not even offered to the model (`toolSpecs`), and are still refused if called.

### Tools

Readers (`READERS`): `read_model`, `get_findings`, `get_gate`, `list_decisions`, `read_registry_file`, `get_code_map`, `search_codebase`, `read_code`, `get_telemetry`. Writers (`WRITERS`): `propose_model_edit`, `mint_decision`, `mint_proposal`. A writer validates deterministically first (for example, a model edit's `find` must match exactly once) and returns an error without asking the user if invalid. Otherwise it returns `{title, detail, preview, apply}`: the card is shown and `apply` runs only on Approve.

All tool execution goes through `runTool(role, name, args, chat, opts)`, shared by the built-in loop and the MCP bridge. It records an `agent_tool` ledger event every time.

To add a tool: add its schema to `TOOLS`, a reader or writer implementation, then add it to the relevant roles' `allow` or `ask`. A write tool must be in `ask`, never `allow`. It must validate before asking, and must mark the path it writes in `AG.approved` inside `apply` so bypass detection doesn't flag it.

### Built-in agent

`send()` runs up to 12 turns: stream a completion from the gateway (`agent:chat`), render text deltas, execute tool calls via `runTool`, and feed results back as `tool` messages. The workspace summary and the editor selection are appended to each user message as `[context]`. It is model-agnostic through the OpenAI-compatible gateway; the model must support tool calling.

### ACP agents

designc is an ACP v1 client (`acp.js`). `AcpHub.connect` spawns the agent in the registry folder, calls `initialize` (advertising `fs.readTextFile` and `fs.writeTextFile`, no terminal), then `session/new` with `cwd` and one MCP server, `designc`, run as Electron's own Node with `ELECTRON_RUN_AS_NODE=1` and env `DESIGNC_MCP_URL`, `DESIGNC_MCP_TOKEN` and `DESIGNC_MCP_SESSION`. The first prompt of a session is prefixed with `ACP_RULES` and the role instructions.

Agent-to-client handling:

| Request | Handling |
| --- | --- |
| `session/update` | `onAcpUpdate` renders `agent_message_chunk`/`agent_message`, `agent_thought_chunk`, `tool_call` and `tool_call_update` (both treated as upserts by `toolCallId`, so v2-style streams also render), `plan` and `usage_update`; others are ignored |
| `session/request_permission` | `onAcpPermission` shows a card with the agent's own options; replies `{outcome: {outcome: 'selected', optionId}}` or `cancelled` |
| `fs/read_text_file` | Main process, allowed only inside the registry or the configured codebase; supports `line`/`limit` |
| `fs/write_text_file` | `acp.js` resolves the path first (`registryRel`) and passes `rel` to the renderer, `null` when outside the registry; it refuses to write a `null` `rel` whatever the renderer answers. `onAcpWrite` then applies `Policy.writeVerdict`: the role may only write its folders (`WRITE_PATHS`: Architect `model/` and `decisions/`, Grill-me `decisions/`, Analyst `proposals/`); files in `decisions/` and `proposals/` must be `.yaml` and parse as a mapping; a decision's parsed `status` can't be `bound` or `superseded`; then a diff card. On approval the main process writes the file; otherwise it returns a JSON-RPC error |
| MCP `tools/list`, `tools/call` | `onMcpList` and `onMcpCall`, using the role recorded for that session in `AG.sessRoles` |
| anything else | JSON-RPC error -32601 |

### AG-UI agents

`sendAgui(text)` keeps a per-chat thread `{threadId, messages, state, resolved, executed}` and runs up to 12 AG-UI runs per user message. Each run POSTs `{threadId, runId, messages, tools, context, state, forwardedProps}`: `tools` are designc's role-filtered tools as frontend tools, `state` is the agent's last state merged with `designcState()` (model revision, findings, gate, drift, decisions), `context` carries the rules and role instructions plus `contextNote()`. A resume run sends `messages: []` and `resume: [...]`.

Events handled: `TEXT_MESSAGE_START/CONTENT/END/CHUNK`, `TOOL_CALL_START/ARGS/END/RESULT`, `STATE_SNAPSHOT`, `STATE_DELTA` (JSON Patch via `applyPatch`), `MESSAGES_SNAPSHOT`, `STEP_STARTED`, `RUN_ERROR`, `RUN_FINISHED`, and any `*THINKING*`/`*REASONING*` event with a `delta`. After a run finishes: unresolved interrupts become approval cards (option ids `accept`/`reject`) and the next run resumes them, each interrupt id at most once (`resolved`); otherwise frontend tool calls without a `TOOL_CALL_RESULT` are executed through `runTool`, each call id at most once (`executed`), and the results are appended as `tool` messages; otherwise the turn ends. An approval sets a 30-second grace window (`AG.graceUntil`) in which registry writes by the host are not flagged.

`agentSawChange(paths)` (called from the file watcher) flags any registry file that changes during an ACP turn without a recent approval in `AG.approved`, shows it in the panel and records `unapproved_change`. Ledger files are included: a change to `ledger/*.jsonl` is flagged unless the app itself appended to that file in the last 8 seconds (`OWN_APPENDS` in `app.js`), so a pipeline appending during an agent turn is flagged too. designc governs what flows through ACP and its own MCP tools; it does not sandbox the agent process.

## Invariants: do not break these

| Invariant | Where it is enforced |
| --- | --- |
| Agents cannot write without a policy check and a human approval | `Policy.verdict`, `Policy.writeVerdict`, `runTool`, `WRITERS`, `onAcpWrite`, `AcpHub.registryRel` |
| Policy fails closed; deny wins; a write tool always asks | `Policy.verdict` in `policy.js` |
| Freezing a handover is a human action in the app | `freezeHandover` is only reachable from the Design view and the menu; there is no CLI or agent tool for it, because either could bypass the gate, the clean-commit check and the human decision |
| Binding a decision is a human action, never an agent's | No bind tool exists; `Policy.writeVerdict` rejects a parsed `status` of `bound`; `bindDecision` asks for confirmation |
| The codebase is read-only in designc | `codebase:read`, `codebase:search`, `onAcpWrite`, no codebase write handler |
| Registry access is scoped to the open folder, symlinks included | `inside()` in `main.js`, `confine` in `paths.js` |
| Agent and check processes do not inherit secrets | `childEnv` in `paths.js` |
| A change to `designc.json` during an agent turn is flagged | `Policy.unapprovedChanges` |
| The ledger is append-only | Only `ledger:append` writes it; state changes are new events |
| Every ledger write goes through one validated append path per runtime | `ledger-store.js` `appendEvent` in JS and `python/designc/ledger.py` `append_event` in Python; no other code writes `ledger/*.jsonl` (`test/ledger-guard.test.js`) |
| Extraction never invents edges | `extract.js` pushes to `unresolved` instead |
| Decision checks and git run only in a trusted folder | `ensureTrusted` in `main.js`: trust is per folder like VS Code workspace trust. A trusted ancestor covers its subfolders (`isTrusted` in `paths.js`); the dialog offers this folder, the repository around it, or the parent (`trustChoices`, never the home folder or filesystem root). Saved in `state.json`. The user can skip the question entirely with `"trustAllFolders": true` in the app's `state.json` (user data folder, named after `productName`: `~/.config/designc` on Linux). It is read only from there, never from `designc.json`, and only the boolean `true` counts. |
| Secrets stay in environment variables | Settings hold only env var names |
| Every tool call, permission, write and turn by an agent is recorded | `ledger()` calls in `agent.js` |
| All interpolated HTML is escaped | `esc()` everywhere `innerHTML` is built |
| An AG-UI interrupt is resolved at most once, and a frontend tool call executes at most once | `T.resolved`, `T.executed` in `sendAgui` |
| Streamed runs act on their outcome only after every event has been handled | `drainAgui` |
| The MCP bridge only accepts local calls with the per-run token | `bridge` in `main.js`, bound to 127.0.0.1 |

## Recipes

**Add a view or dashboard.** Add an activity bar button in `index.html` with `data-act="<name>"`, a title in `renderSidebar`'s `titles`, a sidebar builder, and, for a full editor-area view, a special tab id `special:<name>` handled in `renderSpecial`, `tabTitle` and `renderCrumbs`. Special tabs hide the C4 sheet automatically.

**Add a design property.** Add it to `SPECS` in `core.js` (validation) and `PROPS` in `app.js` (completions and hovers), use it from a rule, and document it in `README.md`.

**Add an ACP agent preset.** Add it to `ACP_PRESETS` in `main.js` with `label`, `command` and `args`. Users can override or disable presets in `designc.json` `acpAgents`.

**Change what the Build view shows.** Telemetry aggregation is `telAgg()` and `telSuggestions()` in `app.js`; the ledger part is `buildDash()`; the telemetry block is `telemetryBlock()`.

**Change the layout of the C4 drawings.** `layout(m)` (layered, left to right, barycentric ordering) and `drawModel(m, L, opts)` in `app.js` are shared by the design sheet and the code map. Style hooks are `nodeStyle(e)` and `edgeStyle(r)` in the options, plus `extra` for ghost edges.

### Components (`facts.components`, `facts.componentEdges`)

`extract/components.js` assigns each source unit, per owner container, to exactly one component. Precedence:

1. `designc.json` `extract.components` overrides, first matching entry wins.
2. C# anchors: a class with a `[Function]` method, a controller (name ends in `Controller` or derives from `ControllerBase`/`Controller`), or a static class calling `Map*`. Named after the class.
3. C# output-binding types (the `T` a `[Function]` method returns) join that function class's component, even if the class was overridden.
4. A library project or package is one component inside each owner container.
5. Files directly in the project root are `App shell`.
6. JS/TS support folders (`types`, `constants`, `styles`, `assets`, `test`, `tests`, `mocks`, `__mocks__`) are `Shared`.
7. A grouping folder (`features`, `modules`, `domains`) first steps down one level.
8. Otherwise the first folder names the component. F# uses rules 4, 5 and 8 only.

Overrides look like `"extract": { "components": [ { "name": "Ordering", "paths": ["api/src/Shop.Api/Endpoints/**"] } ] }`. A file matched in several containers becomes that component in each. A bad entry, or a glob that matches no source file, goes to `unresolved` (where `designc.json`).

`facts.components` is `{id, key, container, name, owner, basis, tech, files, evidence}`; `facts.componentEdges` is `{from, to, kind, label, tech, via, evidence}` with `via` one of `container-edge`, `queue-internal`, `type`, `di`, `di-candidate`, `import`. Rollup invariant: folding every component edge end to its container and dropping self-loops gives exactly the `(from, to, kind)` set of `facts.edges`, which keeps its container-level shape. The DSL nests components inside their container; container-level rels render as before, and each component rel is one line (`a -> b "label" "tech" { properties { "d.interaction" "sync" } }`) so `Core.containerLevelText` can strip them.

Limits: calls through extension methods make no component edge; a type name resolves only if exactly one declaration in the deployable's closure has it (otherwise no edge); an interface with several registrations gives `Uses (DI candidate)` edges plus one `unresolved` entry. `test/extract-invariants.test.js` runs the extract-* governance checks (no app-specific names, built-in requires only) in the gate.

### Levels, drill-down and adopting components

The Code map has a Context, Containers and Components switcher. Double-clicking a container (or a group at Components level) scopes Components to it, the breadcrumb's All shows every container, and double-clicking empty canvas or pressing Backspace on the map goes up one level. Components is disabled when the as-built model has none (re-extract). Components come from function classes, controllers and endpoint classes, libraries, first folders, and overrides in `designc.json` `extract.components`.

## Known limitations

The DSL parser covers the subset above, not all of Structurizr (no `!include`, dynamic views or archetypes; deployment environments are parsed for display and blast radius only; their relationships and `views { deployment ... }` declarations are read, but there is no layout or drawing of a deployment view beyond the Deployment tab). P models are not run inside the app; only their checks run, as shell commands from decisions. The .NET extractor is regex-based and covers the common registrations listed; other languages are not extracted. The C4 layout is automatic and basic. The built-in agent loop is not MAF: it follows the same contract (role, tools, policy, ledger) so it can later be pointed at a MAF host. `integrations/DesigncTelemetry.cs` is an uncompiled sketch. ACP support targets protocol v1. It has been tested against the mock agent and, on 2026-10-02, against the real `@agentclientprotocol/claude-agent-acp` 0.85.1 (initialize, session/new and a prompt all work through the filtered child environment, using the Claude Code login in `~/.claude`). Codex, Gemini and Copilot adapters are not tested. Agents that authenticate through an environment variable need it listed in the preset's `inherit` or in `designc.json` `acpAgents.<key>.inherit`; `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` are listed for Claude, and Bedrock or Vertex credentials are not. AG-UI support has been tested against `dev/mock-agui-server.js`, not yet against a real MAF host; `integrations/maf-agui-host/` is uncompiled. Installers are unsigned.

Adopted in-process component rels count as DC003 sync hops (only ancestor/descendant pairs are exempt), so a long in-process chain can raise a DC003 warning. Adopted async rels get a DC001 warning until a `d.delivery` is declared.

## The Python CLI

`python/designc` is the CI form of the compiler: `cd python && python3 -m designc check <registry> [--json]` (or `pip install ./python`, then `designc check`). It reads the same folder as the app (`designc.json`, `model/`, `decisions/`, `requirements/`, `scenarios/`, `ledger/`) and prints findings and gate clauses. Exit code 0 is ready, 1 not ready, 2 the folder cannot be read.

`designc verify-ledger <registry> [--json]` checks the ledger trail (exit 0 clean, 1 errors, 2 the folder cannot be read) and `designc check` records a `gate` event (see the ledger table). Verify rules, identical in `Ledger.verify` (`renderer/ledger.js`, shown in Improve as "Ledger integrity") and `python/designc/verify.py`: V1 every handover follows a ready `gate` event at its revision (a warning when it predates the first gate event; the `r-` prefix is ignored), V2 no handover is dirty, V3 every technical `decision_promoted` follows a passing `check` (decisions not in the registry or of kind business are not judged), V4 every line validates, V5 no repeated `event_id` with different content, V6 open `unapproved_change` events (warning), V7 `handovers/` and `handover` events agree both ways. `sample: true` events are skipped. Both read raw `{path, text}` files, so they see invalid lines and repeats that the loaders drop.

It covers the parser, DC000 to DC006, `d.suppress`, the gate (all clauses, including fingerprints, business evidence, scenarios and the ledger's checks and needs-decisions) and `slug_id`. It does not cover drift, diff, blast radius, handover planning, change impact or the code extractor. Differences to know: the canvas extension rules (`registerRules`) do not exist in the CLI; ledger lines are validated only for the kinds the gate reads (`check`, `fitness`, `needs_decision`, `needs_decision_resolved`); finding order uses an approximation of `localeCompare`. YAML is read with `yes`/`no` as strings, as js-yaml does.

When you change `core.js` behaviour that the CLI covers, change `python/designc` in the same commit and extend `test/designc-cli.test.js`.

## Related systems

designc is one of three systems: System 1 (design compiler, this app's Design view), System 2 (the agentic coding pipeline on the MAF harness, which consumes handovers and writes the ledger), and System 4 (the improvement loop, this app's Improve view). The Python CLI in `python/designc` is the CI form of the same compiler and must stay rule-for-rule compatible with `renderer/core.js` (see "The Python CLI" below).

**Deployment models (slice 10).** `Core.parse` reads `deploymentEnvironment` blocks (nested `deploymentNode` with an optional instance count, `infrastructureNode`, `containerInstance`, `softwareSystemInstance`) into `model.deployment = {environments[]}`. They are never added to `elements`, so lint, drift and fingerprints are unaffected. Relationships between deployment elements (`a -> b "desc" "tech"`, or `-> b` inside a node body) resolve against the identifiers declared in the same environment into `env.rels` (`{src, dst, description, technology, line}`, `src`/`dst` as `Node/Child` paths); an unknown identifier is an error with a line. `views { deployment <scope> <environment> "key" }` declarations are listed in `model.deployment.views` and must name a declared environment. Both are mirrored in `python/designc/dsl.py`, and the Deployment tab shows a Links table and the declared view keys. A container instance resolves to its element by identifier; an unknown one is an error with a line. A deployment view's scope must be `*` or a declared software system, else an error (mirrored in `dsl.py`); each view carries `system` (an element id). `Core.deploymentChoices(model)` lists the picker entries (declared views as `key · scope · environment`, then `All of <env>`; ids `view:<key>` / `env:<name>`). `Core.deploymentView(model, wanted)` reads `designc.json` `deployment` as a view key first, then an environment name, and returns `{env, view, choices}`. `Core.deploymentScope(model, env, view)` keeps the nodes holding the system's instances (plus ancestors and linked or contained infrastructure), collapses other systems' instances to `shared` counts and filters the Links. `Core.bySystem` / `splitBySystem` group blast-radius results per software system (this view vs other systems). The Deployment activity (`special:deployment`) draws it read-only as nested boxes with a picker shown when there is a declared view or more than one environment; the last pick is kept per registry in renderer `localStorage`. Edit the DSL in the Design view. The tokenizer now emits bare numbers as `id` tokens.

**Blast radius, unavailable mode (slice 11).** `Core.blastRadius(model, 'Azure/Zone A', {mode: 'unavailable', environment})` takes a deployment node path. An element is *lost* when every instance of it in that environment sits under the node; instances elsewhere make it a *survivor* (reduced capacity, still up). Each lost element then spreads as in `misbehaves` and the worst class wins; lost elements are not repeated under down or degraded. Errors: no deployment, unknown environment, unknown node path. The Deployment view shows it when a node header is clicked.

**Quality attribute scenarios and fitness functions (slice 12).** `scenarios/*.yaml` (human-written; no agent role may write there) holds `id, title, attribute, artifact` (an element name), `stimulus, response, measure {metric, op, value, unit}, requirement?, fitness[]`. `Core.scenarioReport({model, scenarios, ledger})` returns per scenario `status` (`resolved` or `unresolved`), `analytic` and `fitness`. Only availability scenarios have an analytic check: the artifact's `d.availability` times that of everything it depends on through declared sync relationships (async and undeclared are left out, as in `blastRadius`); a missing `d.availability` makes it `unknown` and names the element. No new `d.*` property was added. Every other attribute is judged by its fitness function alone: shell commands run through `host.runCheck` ("Run all fitness functions" in the Scenarios section), recorded as `fitness` ledger events (`checks.jsonl`; `scenario, check, outcome, source`, failure needs `exit_code` or `reason`). Gate clauses: unresolved artifact, availability not met, failing fitness, a scenario missing artifact, attribute or measure. Unknown and unchecked never block, as with demand-driven properties.
