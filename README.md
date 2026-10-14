# designc desktop

A system design IDE in which **the design is the source and code is a build output**. It opens a *registry folder* (plain files: a Structurizr DSL model, decisions, requirements, a ledger) and hosts three systems of a design-to-code factory in one window: a design compiler, an as-built code map, and a pipeline and improvement view.

The rule behind every feature: **probabilistic components propose; deterministic components and humans decide.** Agents (LLMs) can draft and suggest. Nothing they produce is written without a policy check and your explicit approval, and the gate that says "ready for handover" is plain code, not a model.

![Explorer](docs/explorer.png)

## Contents

- [Quick start](#run-it) and [installers](#build-an-installer)
- [The views](#the-views), one by one
- [Code map](#code-map), its levels, code quality and coverage
- [Agent panel](#agent-panel), [Langfuse](#langfuse-build-and-improve), [settings](#settings-designcjson)
- [Registry folder](#the-registry-folder), [command line](#command-line-ci), [tests](#tests-and-mocks), [code layout](#layout-of-the-code)
- Deeper reference for contributors and coding agents: [AGENTS.md](AGENTS.md) and [ARCHITECTURE.md](ARCHITECTURE.md)

## The views

The activity bar on the left switches views. Menu: View, or the shortcuts shown in tooltips.

| View | What it is for | What you do there |
| --- | --- | --- |
| **Explorer** | The registry folder as files | Open the model, decisions, requirements, scenarios, evals. Right-click the model for "Compare with last handover" |
| **Design** | The design compiler | Edit the DSL with live lint (DC000 to DC009) and a C4 sheet beside it. Sidebar: findings, decisions (mint, bind, re-bind), requirements, scenarios and fitness functions, agent evals, the **definition-of-ready gate**, grill-me, and **Freeze handover** |
| **Canvas** | Draw the design | Boxes and arrows that write back to the DSL; connections can start from any side, templates for agent systems |
| **Deployment** | Where it runs (as designed) | Pick a declared deployment view or a whole environment; click a node to see what is lost and what goes down if it is unavailable |
| **Agent topology** | Who calls what | Agents and the elements they touch, with irreversible calls that lack human approval flagged |
| **Code map** | What the code actually is (as built) | Extract a .NET, TS/JS or F# codebase into a C4 map with evidence, down to **types and methods**, overlaid on the design as drift, with code quality warnings. See [Code map](#code-map) |
| **Build** | The coding pipeline | Agent runs from Langfuse plus ledger events: tokens per passing task, reruns, decision checks, needs-decision items, drift, handover cost forecast against actual |
| **Work** | Work items for the build | Backlog and active items, New item, Start, Run gates, Freeze item (against a scoped gate), Done (needs evidence for every `done_when` entry and, for a repo item, a passing gate at a commit on main). A digest at the top says what needs you, what failed a gate, what is done since you last looked and what is waiting, including items over budget. Cards show the pipeline's judge score as a gradient that never decides Done |
| **Source control** | Git, daily loop | Branch, fetch, pull (fast-forward only), push (never forces), stage, commit. Freezing a handover pre-fills the commit. Compare tab shows a meaning-level diff of the model |
| **Improve** | Evals and the improvement loop | Escapes by the stage that should have caught them, rule health, proposals, agent activity, ledger integrity, agent evals, factory suite runs, failure modes, eval tasks, judge calibration, escapes in other registries |
| **Set up** | First-run settings page | Model file, LLM provider and Langfuse; each skippable, with Test connection. Keys stay in environment variables |
| **Agent panel** (right) | Chat with roles | Architect, Grill-me and Analyst; built-in, ACP or AG-UI agents. Every write is a diff card you approve |

The Design sidebar opens with **Since last look**: what changed in the gate, findings, decisions, drift and extraction since you last marked the registry as seen (display only, never a gate input). View > Terminal (Ctrl+`) opens a shell in the registry folder after you trust the folder; it is for you, no agent reaches it.

Typical flow: sketch or import the design (Canvas, Design, or "Start the design from this map" on a legacy codebase), let lint and the gate tell you what is missing, record decisions, freeze a handover for the build pipeline, then watch Build and Improve for what the pipeline did and where it escaped.

## Run it

Needs Node 20 or later.

```
npm install
npm start                      # opens the app
npm start -- /path/to/registry # opens straight into a folder
```

File > Open Sample Registry copies a worked example (the pricing engine design, plus a small .NET solution to map) to your Documents folder and opens it.

## Build an installer

```
npm run dist:win    # dist/designc Setup 0.1.0.exe
npm run dist:mac    # dist/designc-0.1.0.dmg
npm run dist:linux  # dist/designc-0.1.0.AppImage
```

The installers are unsigned. On a managed Windows machine SmartScreen or Intune may block them until the build is signed with a company certificate (set `CSC_LINK` and `CSC_KEY_PASSWORD` for electron-builder), so check with IT before handing it to others.

## Code map

Set `"codebase"` in `designc.json` (or use the Code map view's "Choose codebase folder"), then Run > Extract Code Map (Ctrl+Shift+R). The codebase is only read, never changed. The result is written to `asbuilt/workspace.dsl` and `asbuilt/facts.json` in the registry, so extractions are versioned with everything else, and an `extraction` event goes to the ledger.

![Code map](docs/codemap.png)

The .NET extractor reads:

| Source | Becomes |
| --- | --- |
| Web, Worker and Exe projects (`.csproj`, `.fsproj`) | Containers. Libraries fold into the deployables that reference them; test projects are skipped |
| EF Core `DbContext` classes | Stores, with the provider from `UseSqlServer` etc., linked to deployables that use them |
| Redis, Blob and Cosmos clients | Stores, named by connection string |
| `AddHttpClient` with a base address from appsettings | Sync edges, matched to projects by launch port or name; other hosts become external systems |
| Service Bus `CreateSender` / `CreateProcessor` | Async edges, matched on queue or topic name |

It never guesses. Anything it sees but can't tie to an element, such as a queue with no consumer in the repo or an HTTP client whose URL matches nothing, is listed under **Unresolved** with its file and line, not drawn.

Matching to the design is by normalised name (`Referral.Worker` matches `Referral Worker`). When code and design use different names for the same thing, put `"d.aka" "<code name>"` on the designed element. Drift appears in the Code map sidebar, as amber on the map, in the sheet's title block, and in the Build dashboard:

- **In code, not in the design:** an undeclared dependency, or an element the design doesn't have.
- **Designed, not found in code:** dotted edges on the map, and designed elements with no match.

**Code areas** in the sidebar compare each element's `d.code` (see [Code areas](#code-areas-dcode)) with every file in the codebase (any type, so `db/migrations/*.sql` counts; the folders extraction skips, such as `bin`, `obj`, `node_modules` and dot-folders, do not): how many files each pattern matches, which patterns match none, and which files are in no area. An exact path that names a folder (`src/Api` with files under it) says so and suggests `src/Api/**`, because an exact path matches one file. It is information only, never a finding or a gate clause. A map extracted before this existed says "Re-extract to see code areas".

With no design yet, "Start the design from this map" turns the as-built model into `model/workspace.dsl`, which is the quickest way into a legacy codebase.

### Languages

.NET (`.csproj`, `.fsproj`) is the deepest: stores, HTTP and Service Bus edges, routes. JS/TS packages (SPA, Node API, library) and Express routes, and outbound `fetch`/`axios`, SignalR and Service Bus calls are read too. Types and methods (below) are read for C#, TS/JS and F#.

### Levels

The switcher on the Code map runs **Context, Containers, Components, Code**: C4 levels 1 to 4. Double-click a container to scope Components to it, a component to open its types, empty canvas or Backspace to go up. Components come from function classes, controllers, libraries, first folders and `extract.components` overrides in `designc.json`.

### Code level (C4 level 4)

Code shows the **types** (class, record, struct, interface, enum, module) of one component and the types they use in other components, with edges `inherits`, `new` and `uses` resolved by name inside a container. A name declared twice in one container is listed under Unresolved rather than guessed. Select a type for its methods, worst complexity first, with file and line.

Cyclomatic complexity, size and coupling are computed by designc itself (pattern-based, no compiler). Limits: C# property accessors and operators are not measured; TS/JS object-literal methods and UMD-wrapped files are not; F# type headers must keep `=` on the first line and a `let` bound to a lambda counts as a value. These numbers are for review, not precise to the compiler.

### Code quality (warnings, never blocking)

Set limits in `designc.json`:

```json
{
  "quality": { "cyclomatic": 10, "crap": 30, "methodLines": 60, "coupling": 8, "typeMethods": 20 },
  "extract": { "coverage": ["**/coverage.cobertura.xml", "coverage/lcov.info"] }
}
```

A number is a maximum; `{ "min": n }` or `{ "max": n }` say it explicitly. A breach is strictly beyond the limit. Methods are judged one by one and rolled up as worst value and breach count per type, component and container, shown as badges on every level, in the type panel, and in Problems (click to open file and line). They are warnings only: they never reach the gate and the Python CLI does not know them. CRAP needs coverage: Cobertura (coverlet) and lcov reports named by `extract.coverage` are read at extraction, and **with no coverage CRAP is unknown (`?`), never zero**. Coverage is as fresh as the last extraction. Paths in reports are matched by trailing segments because CI roots differ; an ambiguous match is not guessed.

More checks plug into a registry without touching the judge or the UI: `Quality.register({ id, code, title, scope, better, value })` in `renderer/quality.js`.

## Langfuse (Build and Improve)

designc reads agent runs from Langfuse and ties each one to the design: which element it worked on, which task and decision it served, how many attempts it took, what it cost, and why it failed.

- **Build:** tokens per passing task, pass rate, cost per element, recent failed runs with a link into Langfuse, and tagging gaps (runs that can't be tied to the design).
- **Design sheet:** the badge menu switches boxes between lint findings, agent failures and agent cost.
- **Improve:** tasks that took three or more attempts, failed or escalated are suggested as escapes; one click records one in the ledger with its trace ids.

It uses the **Observations API v2** and **Scores API v3**. The older `GET /api/public/traces` and v1 observations reads stop working on Langfuse Cloud on 16 November 2026 and on self-hosted v4, so nothing here depends on them. Self-hosted Langfuse v3 doesn't have the v2 API; the app says so if it gets a 404.

### Settings

```json
"langfuse": {
  "baseUrl": "https://cloud.langfuse.com",
  "publicKeyEnv": "LANGFUSE_PUBLIC_KEY",
  "secretKeyEnv": "LANGFUSE_SECRET_KEY",
  "lookbackDays": 14,
  "tags": ["designc"],
  "fields": { "system": "system", "element": "element", "task": "task", "decision": "decision", "outcome": "outcome", "attempt": "attempt" },
  "outcomeScore": "task_passed",
  "sampleFile": ""
}
```

Keys come from the environment variables named here, never from the repo. `sampleFile` loads a local file in the same response shapes instead of calling Langfuse; the sample registry uses it, and it's ignored once real keys are set.

### The assumptions, and how to change them

| Assumption | Default | If yours differs |
| --- | --- | --- |
| Runs are tagged | `designc` | Set `tags` to your tag, or `[]` to read every trace |
| Trace metadata names the design element | `element` | Set `fields.element` to your key |
| …and the task, decision, system, attempt | `task`, `decision`, `system`, `attempt` | Set the matching `fields` entries |
| Pass or fail | `outcome` metadata, else a `task_passed` score (1 = passed), else "error" if any observation is ERROR | Change `fields.outcome` or `outcomeScore` |
| Element names match the design | Normalised name match, or `d.aka` | Add `d.aka` on designed elements |
| Cost | Langfuse's `totalCost`, shown in dollars | — |

The .NET side of the convention for the MAF harness is in `integrations/DesigncTelemetry.cs`: a `BeginRun` scope that puts the keys in OpenTelemetry baggage, and a processor that copies them onto every span as `langfuse.trace.metadata.*` with the `designc` tag. It is a sketch, not compiled here, so check the source names against your MAF version.

## Agent panel

Ctrl+Alt+I, or the chat icon at the bottom of the activity bar. Pick a role:

![Agent panel](docs/agent.png)


| Role | System | Reads | Needs your approval |
| --- | --- | --- | --- |
| Tutor | S1 | the model, findings and gate (read-only) | nothing: it cannot write |
| Architect | S1 | model, findings, gate, decisions, registry files, code map, codebase search, telemetry | `propose_model_edit`, `mint_decision` |
| Grill-me | S1 | the same, without telemetry | `mint_decision` |
| Analyst | S4 | everything above | `mint_proposal` |

The Tutor teaches system design while you design: it explains in plain words, ties the answer to your model, names sources and ends with one question. Use "Ask the tutor" on a finding. When you answer "I don't know" to Grill-me, a technical question is researched and answered with options, sources (or a statement that it is unsourced) and a recommendation, and you choose; a business question is never answered by research, Grill-me says who should answer and offers a `PROPOSED:` business decision. Grill-me can also map an imported requirement page to design elements (`map_requirement`), and draft acceptance criteria (`mint_acceptance`); both are diff cards you approve.

How it stays governed:

- **Fail closed.** A role can only call tools it lists; anything else, including made-up tool names, is refused and the refusal goes back to the model. Deny always wins.
- **Validate, then ask.** A model edit is checked deterministically first (its `find` must match the model exactly once); only a valid change reaches you, as a diff.
- **Nothing is written without Approve.** Decisions and proposals are created as `minted`. Binding stays a human action outside the panel, and no agent can run checks, edit code or touch the ledger directly.
- **Everything is recorded.** Every tool call (allowed, denied, approved, declined) and every turn's token count goes to `ledger/agents.jsonl`, so Improve and the value metrics can see what the agents did.

The panel includes your editor selection and a short workspace summary with each message. It talks to the same OpenAI-compatible gateway as grill-me (`llm` in `designc.json`); the model must support tool calling. Per-role overrides:

```json
"agents": {
  "architect": { "model": "claude-opus", "instructions": "Prefer ownership over locking for new entities." },
  "analyst": { "deny": ["search_codebase"] }
},
"llm": { "baseUrl": "…", "model": "claude-sonnet", "apiKeyEnv": "DESIGNC_LLM_API_KEY", "litellmMetadata": true }
```

`litellmMetadata` adds LiteLLM's `metadata` (tags `designc` and `ide-agent`, the role and session) so IDE agent turns land in Langfuse under the same convention. Leave it off for gateways that reject unknown fields.

### Any agent, any model: ACP

The agent menu at the top of the panel lists two kinds of agent:

- **designc (gateway):** the built-in loop above. It is model-agnostic through the gateway: any model LiteLLM routes that supports tool calling.
- **ACP agents:** any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com). designc is the ACP client; the agent runs as its own process with its own model and login. Presets:

| Agent | Command |
| --- | --- |
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp` |
| Codex | `npx -y @zed-industries/codex-acp` |
| Gemini CLI | `npx -y @google/gemini-cli --acp` |
| GitHub Copilot | `copilot --acp --stdio` |

Adapter package names move quickly; if a preset fails to start, check the agent's docs or the ACP registry. Add or override agents in `designc.json`; a MAF host with an ACP adapter plugs in the same way:

```json
"acpAgents": {
  "maf": { "label": "MAF harness", "command": "dotnet", "args": ["run", "--project", "../harness/Designc.AcpHost"] },
  "gemini": { "enabled": false }
}
```

What designc does for an ACP agent:

- Starts it with the registry as its working directory and speaks ACP v1 over stdio (newline-delimited JSON-RPC). Tool calls are treated as upserts, so a v2 agent's `tool_call_update` stream renders too.
- **Gives it designc's tools as an MCP server** named `designc`: the same tools as the built-in agent, filtered by the selected role. The server is a small stdio process (`designc-mcp.js`, run with Electron's own Node) that forwards to the running app over 127.0.0.1 with a per-run token, so the role policy and approval cards apply unchanged.
- **Shows its permission requests** (`session/request_permission`) as cards with the agent's own options, such as Allow once or Reject.
- **Governs file writes** (`fs/write_text_file`): writes outside the registry are refused (the codebase is read-only here; code changes go through the coding pipeline), each role may only write its own folders (Architect: `model/` and `decisions/`; Grill-me: `decisions/`; Analyst: `proposals/`), a decision can't be written as bound, and everything else is a diff you approve.
- **Lets it read** the registry and the configured codebase through `fs/read_text_file`, nothing else.
- **Flags bypasses.** An external agent can still change files directly with its own tools. Anything that changes in the registry during an ACP turn without an approved write is flagged in the panel and recorded as `unapproved_change` in the ledger.
- **Records** its tool calls, permission answers, writes and turns in `ledger/agents.jsonl`, tagged with the agent name, next to the built-in agent's.

The limit to be clear about: designc governs everything that flows through ACP and its own MCP tools. It does not sandbox the agent process. What an agent does with its own native tools depends on that agent's permission settings, so leave its auto-approve modes off, and run it inside the MAF harness under ACS where you need hard enforcement rather than detection.

For offline demos, `dev/mock-acp-agent.js` is a scripted ACP agent that uses the MCP bridge, asks permission, writes through the client and tries a write the policy refuses:

```json
"acpAgents": { "mock": { "label": "Mock agent", "command": "node", "args": ["<path>/dev/mock-acp-agent.js"] } }
```

### Your own agents as services: AG-UI

The third kind of agent is a remote service that speaks [AG-UI](https://docs.ag-ui.com/introduction), typically a MAF host exposing agents with `MapAGUIServer`. This is the governed path: the agent's own tools run in the host under ACS, so enforcement happens there rather than being detected afterwards.

```json
"aguiAgents": {
  "maf-architect": { "label": "Architect (MAF)", "url": "http://127.0.0.1:5100/architect",
                     "headers": { "Authorization": "Bearer ${env:DESIGNC_MAF_TOKEN}" },
                     "clientTools": true, "sendState": true }
}
```

Header values can reference environment variables as `${env:NAME}`, so tokens stay out of the repo.

Each run POSTs the conversation, designc's tools as **frontend tools** (the same role-filtered tools as the other agents), the design as **shared state** (model revision, findings, gate, drift, decisions) and the role instructions as **context**. designc then:

- streams text, reasoning, steps and backend tool calls with their results;
- keeps the agent's own state from `STATE_SNAPSHOT` and `STATE_DELTA` (shown under "Agent state");
- runs frontend tools the agent calls under the role policy and approval cards, once per tool call id, and sends the results in the next run;
- turns a `RUN_FINISHED` interrupt (MAF's `ApprovalRequiredAIFunction` produces `reason: "tool_call"` with the function call in `metadata.agent_framework`) into an approval card, then resumes the thread with `resume: [{ interruptId, status: "resolved", payload: { accepted } }]`, or `status: "cancelled"` on Stop. Each interrupt is resolved at most once;
- records runs, frontend tool calls and approvals in `ledger/agents.jsonl` with `via: "agui"`;
- allows registry writes by the host for 30 seconds after an approval; any other registry change during the turn is flagged as `unapproved_change`.

`integrations/maf-agui-host/` is a sketch of the host (Grill-me and Architect, gateway client, registry tools with approval-gated writes, bearer check). It has not been compiled. For offline demos, `dev/mock-agui-server.js` behaves like a MAF host: frontend tool call, backend tool, shared state, and an approval interrupt that only writes after the resume says accepted.

| Agent kind | Where the loop runs | Governance | Best for |
| --- | --- | --- | --- |
| designc (gateway) | Inside the app | App policy and approvals | Quick use with any model |
| ACP | The agent's own process | Policy on what crosses ACP; bypasses detected | Off-the-shelf coding agents |
| AG-UI | Your agent service (MAF) | ACS in the host; approvals in designc | Your governed agents, shared with the pipeline |

This built-in loop runs inside the app, not on MAF. It uses the same contract as the MAF harness (role, tools, policy, ledger), so the panel can later be pointed at a MAF host instead, for example over AG-UI, without changing the UI.

For offline demos, `node dev/mock-gateway.js` serves a scripted session: set `llm.baseUrl` to `http://127.0.0.1:8765/v1`, `llm.model` to `mock` and `DESIGNC_LLM_API_KEY` to anything.

## The registry folder

| Path | Holds |
| --- | --- |
| `model/workspace.dsl` | C4 model with `d.*` design properties |
| `behaviour/*.p` | P models, one per protocol |
| `requirements/*.yaml` | Jira keys the design answers |
| `decisions/*.yaml` | Decisions: `minted`, then `bound` by a human, each with `checks` |
| `requirements/*.yaml` from import | Requirement stubs made from exported pages (`.html`, `.md`) with the ⇩ button in the Requirements section: a review shows new, changed, unchanged and not importable pages, and page text is never stored. Word, PDF and Confluence converters are in `scripts/` (`convert-pages.py`, `fetch-confluence.py`); see `docs/requirement-import.md` |
| `work/*.yaml` | Work items: a requirement with elements, or a target of `document`, `jira` or `investigation`, plus `repo`, `writes`, `depends_on` and `done_when`. Human-written (Work view, New item) |
| `acceptance/*.yaml` | UI acceptance criteria per element: states, locators and cases. Gate input; a handover turns them into Playwright spec skeletons |
| `design-tokens/tokens.json` | W3C design tokens, judged by the gate for text size and copied into every handover |
| `scenarios/*.yaml` | Quality attribute scenarios with fitness functions, optional `importance` and `difficulty` |
| `evals/*.yaml` | Agent evals: the command, results file and thresholds that judge an agent. Human-written; no agent role may write here |
| `proposals/*.yaml` | Improve proposals, same lifecycle |
| `handovers/*.yaml` | Frozen handovers, written by Run > Freeze Handover |
| `asbuilt/` | The last code-map extraction: `workspace.dsl` and `facts.json` with evidence |
| `telemetry/` | Sample Langfuse data (sample registry only) |
| `ledger/*.jsonl` | Append-only events, one JSON object per line: `checks.jsonl`, `pipeline.jsonl`, `designc.jsonl`, `agents.jsonl` hold designc envelope v1 events; `sessions.jsonl` holds harness envelope v1 records (grill-me / MAF session and charter events, adopted as-is) |
| `designc.json` | Settings |

Everything is plain files, so git is the review and history layer: binding a decision is an edit you commit and review like any other.

### Ledger events

The pipeline appends lines like these; the app watches the folder and updates live. The pipeline is optional and any coding agent can be one: the kinds it may write, and that `element` is an `elements.json` id, are in `docs/pipeline-contract.md`.

```json
{"schema_version":1,"by":"pipeline","kind":"task","task":"T-01","element":"Quotes DB","status":"passed","reruns":0,"turns":9,"tokens_in":48000,"tokens_out":13000,"cost":0.42,"model":"sonnet"}
{"schema_version":1,"by":"pipeline","kind":"check","decision":"D-0001","check":"p check -tc tcOptimistic","outcome":"pass","source":"pipeline"}
{"schema_version":1,"by":"pipeline","kind":"needs_decision","id":"ND-0003","task":"T-06","element":"Referral Worker","question":"…","status":"open"}
{"schema_version":1,"by":"pipeline","kind":"asbuilt_edge","from":"ReferralWorker","to":"RatingEngine"}
{"schema_version":1,"by":"pipeline","kind":"escape","id":"E-0008","element":"Cat Model Adapter","description":"…","code":"DC004"}
{"schema_version":1,"by":"pipeline","kind":"false_positive","code":"DC003","element":"Pricing Portal"}
{"schema_version":1,"by":"pipeline","kind":"item_budget","item":"W-01","status":"exceeded","limit_tokens":200000,"spent_tokens":260000}
{"schema_version":1,"by":"pipeline","kind":"item_judge","item":"W-01","judge":"ux","score":0.82,"threshold":0.8,"outcome":"pass","commit":"e840be7"}
{"schema_version":1,"by":"pipeline","kind":"handover_closed","handover":"20261003-ab12cd34","outcome":"delivered"}
```

`event_id` and `ts` are optional for external (pipeline) writers — the app's single append path stamps them if missing. Token spend on a `task` splits as `tokens_in`/`tokens_out` (`Ledger.totalTokens` sums them) plus an optional `cost`; the older single `tokens` field is still read. `escape` and `escape_classified` use `code`/`caught_by` as of the v1 envelope; older pipeline output using `rule`/`stage` is still read (upcast on load), just no longer written.

The app itself only appends: check results to `ledger/checks.jsonl`, and handovers, escape classifications and resolved needs-decisions to `ledger/designc.jsonl`. It never rewrites a ledger line.

## Settings (`designc.json`)

Opening a folder with no `designc.json` starts at **Set up this folder** (also Help → Open settings, or click LLM or Langfuse in the status bar while they are not configured). It asks for the model file, the LLM gateway and Langfuse, each skippable, shows whether each named environment variable is set and the `export` line to add to `~/.profile` if not, tests each connection, and saves `designc.json`. Keys stay in your environment: the file holds only variable names. Test connection asks before sending a key to a host that is not already in `designc.json`.

```json
{
  "model": "model/workspace.dsl",
  "chainHops": 4,
  "retryAmplification": 4,
  "currency": "GBP",
  "llm": { "baseUrl": "https://your-gateway/v1", "model": "claude-sonnet", "apiKeyEnv": "DESIGNC_LLM_API_KEY" }
}
```

`llm.provider` is `openai` (default, any OpenAI-compatible gateway), `anthropic` (key in the env var named by `apiKeyEnv`, default `ANTHROPIC_API_KEY`) or `vertex` (Claude on Vertex AI using your own `gcloud auth application-default login`; set `project` and `region`).

### Dispatching a handover to a coding agent

A frozen handover is a folder in git with a `BUILD.md` that any coding agent can read, so the build can simply pull it. To start your own build from the app, name its command in `designc.json`:

```json
"dispatch": { "label": "Build it", "command": "my-build --handover {handover} --repo {repo} --registry {registry} --base {base}" }
```

The Design sidebar then shows **Build it <id>** for the newest handover, and a frozen work item's card shows **Build it** for its own handover. Pressing it types the command into the Terminal panel with `{handover}` (the handover folder), `{repo}` (the work item's `repo`, else `codebase`), `{registry}` and `{base}` (`work.mainBranch`, else `main`) filled in and quoted for your shell. It does not press Enter: read the line, then run it. The shell has your full environment, so the build finds its own keys. Any other `{name}` in the command is refused. Without `dispatch` there is no button.

With the `openai` provider, grill-me and proposal drafting call an OpenAI-compatible `/chat/completions` endpoint, so point `baseUrl` at the LiteLLM gateway. The key is read from the environment variable named in `apiKeyEnv` and never stored in the repo. Without these set, everything else works and those two buttons tell you what is missing.

## Timing and retries

Declare how long calls may take and the app checks the numbers agree. Only synchronous calls count; async rels, parent and child pairs and calls from a person are skipped.

| Property | On | Meaning |
| --- | --- | --- |
| `d.timeout` | relationship | Caller timeout in milliseconds |
| `d.latency.max` | element | Worst-case own processing time in milliseconds, not counting its calls |
| `d.fanout` | element | `sequential` (default) or `parallel`: whether its outgoing calls add up or only the slowest counts |
| `d.retry.budget` | element | Retry amplification this receiver tolerates; overrides the project default |

- **DC007 (error).** A rel's `d.timeout` is less than the callee's worst case: its `d.latency.max` plus, for each of its outgoing sync rels, `d.timeout × (1 + d.retry.max)` (the maximum instead of the sum when `d.fanout` is `parallel`). Judged only on rels that declare `d.timeout`; missing values give a warning that names them.
- **DC008 (warning).** Along a sync chain the product of attempts `(1 + d.retry.max)` is higher than the receiver's `d.retry.budget`, or else `retryAmplification` in `designc.json` (default 4). Retries declared without `d.retry.max` give a warning asking for it.

Both rules come from a concept note and are not yet backed by an incident. On the C4 sheet, choose "Badges: timing": each sync rel shows its timeout against the callee's worst case (red when it fails, amber when something is missing), and selecting a box shows the retry multiplier it puts on everything it reaches.

## Code areas (`d.code`)

`d.code` says where an element's code lives, and `d.risk` (`low`, `medium` or `high`) how risky a change there is. Both go into the handover's `elements.json`. Each file belongs to one element's area, and a coding agent can confine each task to that area, so the design compiler checks the areas before a handover:

```
api = container "Pricing API" {
  properties {
    "d.code" "src/Pricing.Api/**, tests/Pricing.Api.Tests/**"
    "d.risk" "low"
  }
}
```

Patterns are repo-relative and comma-separated: `*` and `?` match within one folder name, `**` matches any number of folders and must be a whole segment. Backslashes become `/`, and a leading `./` and trailing `/` are dropped. `src/Api` is one file, not a folder: write `src/Api/**`.

- **DC000 (error).** A pattern the contract rejects (absolute, `..`, `.`, empty folder names, `[...]`, `{...}`, `a**b`), an empty list or blank entry, or `d.code` without `d.risk`.
- **DC009 (error), reserved path.** A `d.code` that may overlap `tests/acceptance/**`, where the generated acceptance specs live.
- **DC009 (error).** `d.code` declared on an element inside one that also declares it (one level per branch: a container or its components, not both), or two unrelated elements whose areas may overlap. Overlap is judged by the path pattern contract, so two wildcard segments count as overlapping (`src/*.cs` and `src/a*`). One finding per pair, on the element declared later; suppress with `d.suppress` when the overlap is intended.

The meaning of a pattern is written down once, as test cases in `docs/path-patterns.json`, which designc (JS and Python) runs and any coding agent that reads `d.code` should run too. `extract.components` and `extract.coverage` in `designc.json` use the same meaning.

## Cost forecast

Freezing a handover shows what it is likely to cost before you confirm. designc compares the model being frozen with the newest handover's model, finds the containers and components that changed (added, changed, or at either end of a changed relationship), and prices each from what past handovers spent on it, read from `task` events in the ledger that name a `handover` and an `element`. With at least 3 past handovers of history an element is measured: the median is the expected figure and the p90 the high end. With fewer it shows "no basis" and is left out, and the total says how many changed elements it covers. Removed elements are listed, not priced.

The forecast is written into `handover.yaml`. Build has a "Handovers: forecast against actual" table: the actual is every task recorded against the handover, reruns and failures included, and is final once you close the handover ("Close as delivered" or "Abandon"). "Copy summary" puts a plain-text summary on the clipboard for a leadership update; nothing is sent anywhere. Settings: `"currency": "GBP"` and `"forecast": { "minSamples": 3, "window": 10 }`. What the pipeline must record is in `docs/cost-forecast-contract.md`. There is no price table and no spend limit: limits belong to the pipeline.

## Agent evals

An agent in the design declares `d.agent.autonomy` (`suggest`, `approve-writes` or `autonomous`) and `d.agent.eval` (an eval id). An `approve-writes` or `autonomous` agent blocks the ready gate until its eval has a passing result that is current. A `suggest` agent never blocks; it is listed in the Evals section and `designc eval` warns about it.

An agent also declares its workflow shape in `d.agent.pattern` (`single-call`, `prompt-chain`, `routing`, `parallel`, `orchestrator-workers`, `evaluator-optimizer` or `autonomous-loop`) after Anthropic's "Building effective agents". The three complex shapes (`orchestrator-workers`, `evaluator-optimizer`, `autonomous-loop`) need a reason in `d.agent.patternWhy`, or rule AG011 warns. An agent that declares autonomy but no pattern gets an `unknown` AG011 warning. The property completions and hovers in the model editor list both properties.

Quality attribute scenarios (`scenarios/*.yaml`) may carry `importance` and `difficulty` (`high`, `medium` or `low`). Once any scenario is rated, the Scenarios section in the Design sidebar becomes a utility tree: grouped by quality attribute, most important and hardest first, unrated last. Ratings only order the list; a value other than high, medium or low blocks the ready gate.

A decision can list the assumptions it rests on: `assumptions: [{"text": "Volume stays under 1k a day", "review_by": "2027-01-01"}]`. Once a bound decision has an assumption past its review date, the ready gate blocks until you press Mark reviewed on the decision in the sidebar and set the next date. Agents can draft assumptions but cannot mark them reviewed; the Analyst checks decisions against a short rubric that includes overdue assumptions.

The Agent topology view (the node-graph icon in the activity bar) draws only the agents in the design, what they call and who calls them. Each agent shows its `d.agent.pattern`; each call shows its `d.tool.effect` and `d.approval`, and an irreversible call with no human approval is drawn in red. It is read-only: edit the model in the Design view.

```yaml
# evals/EV-triage.yaml
id: EV-triage
agent: Triage agent            # an element name in the model
command: node run-evals.js     # run from the registry folder; writes the results file
results: evals/results/EV-triage.json
thresholds:
  - task_success >= 0.85
  - p95_latency_ms <= 1200
maxAge: 7d                     # optional: 30m, 12h or 7d
```

The results file is `{"metrics": {"task_success": 0.9}, "cases": 40}` (schema in `docs/eval-results.schema.json`). A result goes stale when the eval file changes, the agent's design properties or relationships change (`Core.fingerprint`), or it is older than `maxAge`. In the app, the Evals section in Design has Run eval and Run all; the gate clause has a Run eval button; Improve shows the trend of each metric. In CI, `python3 -m designc eval /path/to/registry [--id EV-triage] [--source pipeline]` runs the evals and records the results (exit 0 all passing, 1 any failing, 2 the registry cannot be read). Freezing a handover copies `evals/*.yaml`, and `verify-ledger` rule V8 flags a pipeline result recorded after the handover under a different eval file. `fixtures/agent-registry/` and `dev/mock-eval.js` give a worked example. To wire your own eval suite, give `docs/eval-wiring.md` to your coding agent.

## Command line (CI)

The same compiler and gate run without the app, for CI. It needs Python 3.9 or later and PyYAML:

```
cd python
python3 -m designc check /path/to/registry          # findings and gate clauses
python3 -m designc check /path/to/registry --json   # the same as JSON
```

`python3 -m designc check <registry> --item <id>` prints the gate scoped to one work item. `python3 -m designc work <registry>` lists work items with their state and clashes, `verify-ledger` checks the ledger trail, and `eval` runs agent evals.

Exit code 0 means ready for handover, 1 means the gate is blocked, 2 means the folder could not be read. It does not do drift, diff, blast radius or code extraction; those stay in the app.

### Recording the gate

A local run of `check` records a `gate` event in `ledger/checks.jsonl`: the model revision, the commit (when the registry is in a git repository), whether the gate inputs are uncommitted, the verdict and a compact list of clauses and findings. It records nothing when the latest event from the same source already says the same. Where CI is detected (`CI`, `TF_BUILD`, `GITLAB_CI` or `GITHUB_ACTIONS`) it records nothing unless you pass `--record`.

| Flag | Effect |
| --- | --- |
| `--record` / `--no-record` | Record even in CI, or never record |
| `--by <name>` | Who ran it. Default: `DESIGNC_BY`, then the OS user. Self-asserted |
| `--source local\|pipeline` | Label of the event. Default: `pipeline` in CI, else `local` |

`python3 -m designc verify-ledger /path/to/registry` checks the trail: every handover follows a ready gate event at its revision and is not dirty, every promotion of a technical decision follows a passing check, every line is valid, and `handovers/` matches the ledger. Exit code 0 is clean, 1 means errors, 2 means the folder could not be read. The app shows the same result under Improve, Ledger integrity.

An eval harness records suite runs with `python3 -m designc record /path/to/registry --by <harness>`, sending `suite_run`, `grader` and `suite_run_finished` events as JSON lines on stdin. Nothing else can be recorded this way, and a batch with one bad line records nothing. The folder needs no model. Improve shows the runs under Suite runs: pass@1, pass^k and every trial passed per run, and each trial's grader verdicts per eval task. Try it with `node dev/mock-suite-run.js | (cd python && python3 -m designc record ../fixtures/factory-registry --by mock-harness)` on a copy of the fixture.

To record on every commit, add a `post-commit` hook (the registry may be a subfolder of a larger repository):

```
#!/bin/sh
cd path/to/registry && python3 -m designc check . --record >/dev/null
```

## Decision checks run on your machine

Run > Run All Decision Checks (Ctrl+Shift+B) runs each decision's `checks` as shell commands in the registry folder, writes pass or fail to the ledger, and streams output to the Output panel. Because those commands come from the repository, the app asks you to trust a folder the first time, like VS Code's workspace trust. Only trust folders whose decisions you'd be willing to run.

To stop being asked, set `"trustAllFolders": true` in `state.json` in the app's user data folder (`~/.config/designc` on Linux, `%APPDATA%\designc` on Windows, `~/Library/Application Support/designc` on macOS; Electron names it after `productName`). It is deliberately not a `designc.json` setting, because that file comes with the repository.

## Keys

| Keys | Does |
| --- | --- |
| Ctrl+O | Open folder |
| Ctrl+S | Save |
| Ctrl+. | Quick fix: record a decision for the problem under the cursor |
| Ctrl+Shift+B | Run all decision checks |
| Ctrl+Shift+G | Ask grill-me |
| Ctrl+Alt+V | Toggle the C4 sheet |
| Ctrl+Alt+I | Agent panel |
| Ctrl+Shift+K | Code map |
| Ctrl+Shift+R | Extract the code map |
| Ctrl+Shift+M / U | Problems / Output panel |

## Tests and mocks

```
npm test                          # node --test "test/**/*.test.js"
npm run e2e                       # @critical journeys; xvfb-run -a npm run e2e without a display
```

The end-to-end journeys (`e2e/journeys.spec.js`) drive the real app on a scratch copy of the registry. `scripts/agent-gate.sh` runs them as a Claude Code Stop hook. They are never skipped or loosened.

Core logic, the extractors, the ledger, the Python CLI parity and the governance checks run in Node. Headless app runs use `DESIGNC_SNAPSHOT` and `DESIGNC_STEPS` (see below). Scripted mocks in `dev/` (gateway, ACP agent, AG-UI service, Anthropic API, eval and suite runners) let you try the agent flows without real keys. Always run flows against a copy of `sample-registry`, because they write files.

## Layout of the code

| File | Role |
| --- | --- |
| `extract/` | Deterministic extraction: `csharp.js`, `js.js`, `js-calls.js` for containers and edges; `components*.js`; `code.js` with `code-cs.js`, `code-js.js`, `code-fs.js` for types and methods; `coverage.js`; `link.js`, `dsl.js` |
| `renderer/quality.js` | Pure, pluggable code quality metric registry (QC001 to QC005) |
| `telemetry.js` | Langfuse reader: Observations v2 and Scores v3, grouped into runs |
| `integrations/DesigncTelemetry.cs` | The tagging convention for the .NET harness |
| `main.js` | Main process: folder-scoped file access, watcher, ledger appends, check runs, gateway calls |
| `preload.js` | The only bridge to the UI (context isolation on, Node off in the renderer) |
| `renderer/core.js` | The design compiler: DSL parser, DC000 to DC009, gate, drift. Same rules and results as the Python CLI in `python/designc` |
| `renderer/agent.js` | Agent panel: roles, fail-closed policy, tools, approvals, streaming loop |
| `acp.js` | ACP client: spawns agents, JSON-RPC over stdio, routes updates, permissions and file requests |
| `designc-mcp.js` | Stdio MCP server that gives ACP agents designc's tools via the running app |
| `dev/mock-gateway.js` | Scripted OpenAI-compatible gateway for demos and tests |
| `dev/mock-acp-agent.js` | Scripted ACP agent for demos and tests |
| `dev/mock-agui-server.js` | Scripted AG-UI service shaped like a MAF host, for demos and tests |
| `integrations/maf-agui-host/` | Sketch of the MAF host exposing designc's agents over AG-UI |
| `renderer/work.js`, `renderer/workview.js` | Work items: validation, states, conflicts, digest, judge score; the Work view |
| `renderer/requirement-import.js` | Requirement import: read pages, plan, YAML stubs |
| `git.js`, `terminal.js` | Main-process git (fixed argument arrays, hooks never run) and the integrated terminal |
| `renderer/app.js` | Workbench: Monaco setup, views, panels, sheet, dashboards |

Headless screenshots for docs or CI: `DESIGNC_SNAPSHOT=out/shot DESIGNC_STEPS='[]' xvfb-run npx electron . --no-sandbox /path/to/registry`.

## Deployment view picker

The Deployment view lists each `deployment` view declared in the model (`key · scope · environment`) and `All of <environment>`. A view scoped to a software system hides unrelated nodes and shows other systems' instances in shared nodes as "+ N from <system>". Clicking a node shows what is lost if it is unavailable, split into this view and other systems. `"deployment"` in `designc.json` sets the default (a view key, else an environment name); your last pick is remembered per registry.
