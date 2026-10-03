# Session Handoff — 2026-10-02 Goal "items 1-4, create the designc CLI, fix the docs" finished

## What we were doing
Slices 0 to 12 were already committed (`efaf86b`). This session closed the follow-up goal: real ACP adapter check, a Python `designc` CLI (it did not exist; docs wrongly said it did), trust-skip setting, an `agents.jsonl` reader, and deployment relationships and views. Everything below is **uncommitted**. `npm test` is 220/220.

## Decisions made this session
1. **Python CLI lives in `python/designc`**, `python3 -m designc check <registry> [--json]`; exit 0 ready, 1 not ready, 2 unreadable. Parity with `core.js` is enforced by `test/designc-cli.test.js`. Not covered: drift, diff, blast radius, handover planning, change impact, extractor, canvas `registerRules`.
2. **Trust skip is user-level only.** `"trustAllFolders": true` in `state.json` (user data folder). Never read from `designc.json`; only boolean `true` counts (`isTrusted(trusted, root, all)` in `paths.js`, used in `main.js`).
3. **Claude ACP preset** carries `inherit: [ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN]`. `SSH_AUTH_SOCK` stays stripped on purpose. Real `claude-agent-acp` 0.85.1 verified through the filtered env on 2026-10-02; other adapters untested.
4. **`agents.jsonl` reader**: pure `Ledger.agentActivity(events)` and `Ledger.unapprovedChanges(events)` in `renderer/ledger.js`; Improve view shows "Agent activity" and "Unapproved changes" (all via `esc()`).
5. **Deployment relationships and views**: `env.rels` = `{src, dst, description, technology, line}` with `Node/Child` paths; unknown identifier is an error (`unknown deployment element "x"`). `views { deployment <scope> <env> "key" }` goes to `model.deployment.views`; an undeclared environment is an error. Deployment elements still never enter `elements`. Mirrored in `python/designc/dsl.py`. Deployment tab shows a Links table and declared view keys. No drawing of a deployment view beyond that tab.
6. Item 3 (re-bind in the real registry) is a no-op in this repo: `fixtures/fullstack` has no decisions; `sample-registry` D-0001 is `minted`.

## Decisions NOT yet made
- Whether to commit now (not asked; last "commit them all" authorization was used). If committing, end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Real Electron userData folder name (README says "the app's user data folder"; `package.json` has `name: designc-ide`, `productName: designc`, unconfirmed).
- Whether deployment views should ever be drawn per declared view (today only the chosen environment is drawn).

## Where we got to
Changed or new: `renderer/core.js`, `renderer/ledger.js`, `renderer/app.js`, `main.js`, `paths.js`, `.gitignore`, `python/` (new), tests `designc-cli`, `agent-activity`, `deployment-links` (new) and `paths` (extended), docs `AGENTS.md`, `README.md`, `ARCHITECTURE.md` (Last updated line current), `DESIGNC_SYSTEM_SPECIFICATION.md`, the factory plan, `plan/slices-0-3.md`. `.claude/current-plan-scope.json` is deleted. Headless runs confirmed the Improve section and the Deployment links.

## Next: the System 1 workflow (discussed, not started)
Source: "System 1: design compiler" in `Design-to-code factory implementation plan (MAF).md`.

**Conclusion: it can be built now; it does not need System 2.** System 1 goes from requirements to a frozen handover; System 2 only reads the handover. The one link back is the dotted `needs-decision` arrow, and the ledger already has `needs_decision` and the gate already blocks on open ones, so that edge can stay unwired. The workflow is the grill-me loop: grill-me is the only agent, everything around it is deterministic. It is the headless, long-running form of the app's Grill-me role (checkpointing, pause on answers, Jira comment for business-only questions).

Where the plan's steps stand:

| Plan step | Today |
| --- | --- |
| Load model | Done in the app, custom parser (DSL subset), not `structurizr-cli export` |
| `designc check` | Done: DC000 to DC006 in app and Python CLI |
| Mint decisions | Done as a human-approved agent tool, slug ids |
| Definition of ready | Done in `core.js` and CLI (goes further: fingerprints, business evidence, scenarios). JS and Python, not the F# `ReadyGate` the plan names |
| Freeze handover | Done in the app only (`Core.handoverPlan`) |
| Grill-me | Partly: chat role, draft button, uncompiled MAF host sketch |
| `p check` | Partly: decision checks run as shell commands; P is not run in the app and counterexamples never reach grill-me |
| Jira/Confluence intake | Not started; requirements are hand-written YAML |
| Input drift on pinned requirement versions | Not started (only the version-bump check on business decisions) |
| MAF workflow, checkpointing, `RequestPort`, `finding`/`gate` ledger events | Not started |

Missing before the workflow is useful:
1. `designc freeze` in the CLI (handover freezing is app-only).
2. `check` writing `finding` and `gate` events to the ledger (the plan expects both; these kinds are not in the ledger schema yet, so that is a schema change to agree).
3. The MAF host (`integrations/maf-agui-host/`) is an uncompiled C# sketch; whether `dotnet` is installed here is unchecked.
4. Intake and P counterexamples; without them the workflow is the app's loop plus persistence.

Suggested order: (a) run `designc check` on the real pricing engine model, (b) `designc freeze` plus ledger events from `check`, (c) P counterexamples into grill-me, (d) Atlassian intake and drift check, (e) the MAF workflow as a thin wrapper, tested with a scripted model. Porting the gate to F# is a separate open decision.

## What to load on restart
`@AGENTS.md`, `@ARCHITECTURE.md`. For the workflow work also `@Design-to-code factory implementation plan (MAF).md` (System 1 section). Nothing else unless touching the CLI (`python/designc/`) or the Deployment view (`renderer/app.js` `deployLinksHtml`).

## Watch out for
- The post-compaction instruction reminder showed an older AGENTS.md; the file on disk is current (contains `agentActivity` and `env.rels`). Trust the disk.
- Any `core.js` change the CLI covers must change `python/designc` in the same commit and extend `test/designc-cli.test.js`.
- `app.js` is not requirable; verify UI changes with the headless recipe in AGENTS.md (pre-trust the registry copy in `state.json`).
- Sample registry must still give 2 errors (DC002, DC004), 4 warnings, 1 suppressed.
