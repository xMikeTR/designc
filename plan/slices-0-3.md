# Plan — slices 0 to 3: agent write holes, git read-only, git daily loop, slug ids

> Planned 2026-10-02 from `SESSION_HANDOFF.md` (decisions 13 to 20, 25/26) and `ARCHITECTURE.md`.
> Status: proposed. Interfaces below are for Mike to accept or change before any code.

## Goal

Make the registry safe to live in under git: close the four ways an agent can write without a policy check (slice 0), show git state, history and compare-with-revision (1), make commit, branch, fetch, pull and push work from the app with a ledger that merges cleanly (2), and stop decision and proposal ids colliding across branches (3).

**Success.** After slice 0 no agent path writes outside the registry, binds a decision, or skips an approval card. After 1 the status bar shows the branch and any registry file can be compared with an earlier revision. After 2 a day's work (edit, commit, pull, push, switch branch) needs no terminal, and two branches that both appended to the ledger merge with no conflict and read back the same. After 3 two branches can each mint a decision and merge without an id clash going unnoticed.

**Constraints.** No new dependency. `core.js` stays dependency-free and Node-requirable. Sample registry still compiles to 2 errors, 4 warnings, 1 suppressed. No agent ever gets a git action. TDD, one failing test at a time. Shared `app.js` regions get new statements, not rewritten lines.

## Module impact

| Slice | Module | Change | High centrality |
| --- | --- | --- | --- |
| 0 | `renderer/policy.js` | **New.** Pure agent policy, dual-loaded like `ledger.js` | |
| 0 | `renderer/agent.js` | Calls `Policy`; mint writers quote every field; ledger changes flagged | |
| 0 | `acp.js` | Confines the write path itself; passes `rel` to the renderer | |
| 0 | `renderer/index.html` | One script tag | |
| 1, 2 | `git.js` | **New.** Main-process module, the only caller of the git binary | |
| 1, 2 | `main.js` | `git:*` handlers; `ensureTrusted()` pulled out of `check:run` | yes |
| 1, 2 | `preload.js` | Twelve `host.git*` methods | yes |
| 1, 2 | `renderer/app.js` | Status bar item, history list, compare tab (1); Source control view (2) | yes |
| 2 | `renderer/ledger.js` | `Ledger.order` | yes |
| 3 | `renderer/core.js` | `Core.slugId`; duplicate-id and unreadable-file clauses in `gate` | yes |
| 3 | `renderer/app.js`, `renderer/agent.js` | Four `nextId('D'|'P', …)` call sites replaced | yes |

Where the new modules sit: `policy.js` depends on nothing and is used by `agent.js` and tests (same position as `ledger.js`). `git.js` depends on `child_process` and `path` only, is required by `main.js`, and knows nothing about Electron. Neither is reachable from `TOOLS` or the MCP bridge.

## Interface changes (flagged)

### Slice 0

```js
// renderer/policy.js  ->  global Policy, module.exports
Policy.WRITE_TOOLS                         // ['propose_model_edit', 'mint_decision', 'mint_proposal']
Policy.verdict(cfg, tool)                  // 'allow' | 'ask' | 'deny'; a WRITE_TOOLS member never returns 'allow'
Policy.WRITE_PATHS                         // moved from agent.js, unchanged
Policy.writeVerdict(role, rel, content, parseYaml)   // { ok: true } | { ok: false, error }
```

- `writeVerdict` parses the YAML (parser passed in) and reads `status` as a value, so `status: "bound"` is caught. Content that does not parse is refused.
- `ui:call` `acp:write` payload gains `rel`: computed in `acp.js` with `path.resolve` + `path.relative`, `null` when outside the registry. The renderer stops deriving it. `acp.js` refuses to write when `rel` is null, whatever the renderer answers.
- `mint_decision` puts `requirement` through `yamlStr`; `mint_proposal` puts `kind` through `yamlStr`.
- `agentSawChange` no longer exempts `ledger/`. A ledger file that changes during an ACP or AG-UI turn, not within 8 s of one of the app's own appends, is flagged and recorded as `unapproved_change`. No schema change.

Not solved by this, and said so in the UI text: designc cannot stop an unsandboxed agent process touching the disk; it can only flag it. A pipeline appending during an agent turn will be flagged too.

### Slice 1

```js
host.gitStatus()        // { repo: false } | { repo: true, trusted: false }
                        // | { repo: true, trusted: true, branch, head, detached, upstream, ahead, behind,
                        //     files: [{ path, index, worktree }] }      path relative to the registry
host.gitRefs()          // { branches: [{ name, hash, current }], tags: [{ name, hash }] }
host.gitLog(rel, max)   // [{ hash, short, author, date, subject }]
host.gitShow(hash, rel) // { text } | { error }
host.gitTrust()         // asks the folder-trust question; true | false
```

Changes from decision 20: `gitShow` takes a **full commit hash only** (`/^[0-9a-f]{40,64}$/`), which is simpler and stricter than remembering which ref names were handed out; and `gitTrust()` is added so opening a folder never raises a dialog by itself.

`git.js` rules: `execFile` with a fixed argument array per function; `--no-pager`, `-c core.fsmonitor=false`, `-c core.hooksPath=/dev/null` on read operations, `--no-ext-diff --no-textconv`; env reduced to `PATH`, `HOME`, `LANG`, `SSH_AUTH_SOCK` plus `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`; cwd is the registry; every path through `inside()` and after `--`; status limited to `-- .` so a registry inside a larger repo sees only itself.

### Slice 2

```js
host.gitStage(paths) / gitUnstage(paths)   // { ok } | { error }
host.gitCommit(message)                    // { ok, hash } | { error }      message on stdin
host.gitBranch(name)                       // create and switch
host.gitSwitch(name)                       // name must be in gitRefs().branches
host.gitFetch() / gitPull() / gitPush()    // pull is --ff-only; push never forces
Ledger.order(events)                       // drops repeated event_id, stable sort by _ts
```

- Push with no upstream: allowed only when the repo has exactly one remote, after an explicit "publish this branch" confirmation.
- Switch and pull are refused in the renderer while any buffer is dirty; after either, the registry is reloaded whole.
- The first commit from the app offers to add `ledger/*.jsonl merge=union` to the registry's `.gitattributes`.
- **Escape ids — needs your yes.** Simplest form that survives a union merge: the app mints `E-<first 8 of the event's uuid>` instead of `E-000n`. `escape_classified.escape` keeps pointing at `id`, no schema change, old ids stay valid. This replaces my earlier "key on `event_id`, show `E-…`" suggestion, which needed a schema change for the same result.

### Slice 3

```js
Core.slugId(statement, taken)   // kebab-case of the statement's first words, at most 48 chars, '-2', '-3' on clash
Core.gate({ …, registryErrors })   // new optional input: [{ path, message }]
```

- New blocking clauses: `duplicate id <id>` (decisions, requirements) and `<path> does not parse`. Today a broken decision file silently stops blocking.
- Proposals are not gate input, so a duplicate proposal id shows in Problems, not as a clause. Say if you want proposals in the gate instead.
- The file is named at mint and not renamed; the `id` field is what counts. "Frozen once bound" cannot be enforced until slice 5 records the id at promotion; slice 3 only stops the app's own edit path.
- `nextId` stays for handovers until slice 7.
- The Python `designc` package needs the two clauses mirrored. It is not in this repo.

## Test strategy

| Slice | Unit under test | Most important behaviours |
| --- | --- | --- |
| 0 | `Policy` (Node); `AcpHub.handle` with a fake `ui` | a write tool listed in `allow` still asks; quoted `bound` refused; `model/../../x` gives `rel: null` and no file is written even if the fake `ui` approves |
| 1 | `git.js` against a temp repo made in the test | status confined to a registry subfolder; `gitShow` refuses a non-hash and a path outside; a repo whose config sets `core.fsmonitor` to a script does not run it |
| 2 | `git.js`; `Ledger.order` | pull refuses a non-fast-forward; commit message starting with `-` is taken as text; two ledgers merged in either order derive the same state |
| 3 | `Core.slugId`, `Core.gate` | clash suffix; duplicate id blocks; sample registry counts unchanged |

Nothing is mocked except the `ui` callback in the ACP test. Renderer wiring is checked with the snapshot harness on a copy of `sample-registry`, and `dev/mock-acp-agent.js` gains one out-of-registry write attempt through `..`.

## Step sequence

**Slice 0**
1. Refactor, no behaviour change: move `verdict` and `WRITE_PATHS` into `renderer/policy.js`. Existing tests stay green; new test pins current `verdict` results.
2. A write tool in `allow` yields `ask`. Failing test first.
3. `Policy.writeVerdict` with parsed status. Tests: quoted bound, superseded, unparseable.
4. `acp.js` computes `rel`, refuses outside the registry. Test through `AcpHub.handle`. *Touches `acp.js` and `agent.js` together.*
5. `yamlStr` on `requirement` and `kind`. Checked in the snapshot harness with the mock gateway.
6. Ledger changes flagged during an agent turn. Checked with `MOCK_BYPASS=1`.

**Slice 1**
1. `git.js` `status` + `git:status` + status bar branch item (untrusted shows "Git: trust this folder").
2. `ensureTrusted()` pulled out of `check:run` (refactor commit), then `gitTrust`.
3. `log` + a History section for the open file.
4. `refs`, `show` + "Compare with revision" opening Monaco's diff editor, read-only on the left.

**Slice 2**
1. `Ledger.order`, applied where `A.ledgerRaw` is built.
2. Escape id minting (after your answer).
3. Source control view: changed files, stage and unstage.
4. Commit, with the `.gitattributes` offer.
5. Branch create and switch, with the dirty-buffer refusal and full reload. *Touches `main.js` and `app.js` together.*
6. Fetch, pull, push.

**Slice 3**
1. `Core.slugId`.
2. The four mint call sites.
3. Duplicate-id clause.
4. `registryErrors` clause.

Each slice ends with `ARCHITECTURE.md` and `AGENTS.md` updated and the scope file deleted.

## Risks

- **Biggest assumption:** that hardened config and a reduced environment make read-only git safe in a repo you did not write. The fsmonitor test is the proof; if it cannot be made to hold on git 2.43, read operations stay behind trust with no fallback.
- **Most likely to go wrong:** branch switch. The watcher reports a burst of file changes, open tabs may point at files that no longer exist, and `onDiskChanged` skips dirty buffers. Hence the refusal while dirty and the whole reload.
- Push and fetch depend on credentials already working outside the app (ssh agent or a credential helper). With prompts disabled, a missing credential is an error message, not a dialog.
- `merge=union` only takes effect once `.gitattributes` is committed on both branches.
- Slice 0 step 6 can flag honest pipeline appends. If that is noisy in daily use, it needs a better signal than timing.
- Trust is still keyed on the registry path, and `inside()` is still lexical. Neither is changed here.
