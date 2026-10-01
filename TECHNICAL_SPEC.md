# DesignC Technical Specification & Change Ledger
**Branch:** `feat/canvas` (Commits `79b4f32` through `d6a013f`)  
**Base:** `main` (`953425a`)  
**Repository:** `xMikeTR/designc` (migrated from `xMikeTR/cenas`)  
**Date:** September 2026  

---

## 1. Executive Summary

This document specifies the complete technical architecture and change inventory introduced in `feat/canvas` on top of `main`. It covers four major engineering initiatives:

1. **Unified Ledger Schema (LS-01 through LS-05)**: A production-grade dual-envelope event ledger supporting both Structurizr/DesignC operational events (`designc_v1`) and Claude Harness charter events (`harness_v1`) in a single store with strict schema validation, single-writer IPC serialization, and gate counting isolation.
2. **Interactive Drawing Canvas (`designc-canvas`)**: A self-contained, dependency-free interactive visual canvas embedded as a first-class editor tab (`special:canvas`), integrating Structurizr DSL AST two-way editing, C4 + Agentic AI stencil vocabularies, layout persistence, and automated design review generation.
3. **Canvas Setup-Panel Non-Blocking Fix**: Elimination of a critical UX deadlock where the registry setup panel auto-opened over the canvas viewport, blocking pointer events and drag operations.
4. **Multi-Language Extractor & Registry Setup Documentation**: Complete user and architectural documentation for the code map extractor, multi-language bindings, and non-destructive registry setup engine.

---

## 2. System Architecture & Key Design Invariants

```
+-----------------------------------------------------------------------------------+
|                                 Electron Shell                                    |
|                                                                                   |
|  +-----------------------------------+   +-------------------------------------+  |
|  |     Main Process (Node.js)        |   |       Renderer Process (Chromium)   |  |
|  |                                   |   |                                     |  |
|  |  +-----------------------------+  |   |  +-------------------------------+  |  |
|  |  | ledger-store.js (Writer)    |  |   |  | renderer/ledger.js (Schemas)  |  |  |
|  |  | - Atomic JSONL append       |  |   |  | - Validators & Kind Sets      |  |  |
|  |  | - Payload schema check      |<======| - Envelope Builders             |  |  |
|  |  | - Single entrypoint         | IPC  |  | - Token parsing & _ts norm    |  |  |
|  |  +-----------------------------+  |   |  +-------------------------------+  |  |
|  |                 |                 |   |                 ^                   |  |
|  |                 v                 |   |                 |                   |  |
|  |     ledger/*.jsonl files          |   |  +-------------------------------+  |  |
|  |                                   |   |  | renderer/canvas/ (Designc)    |  |  |
|  +-----------------------------------+   |  | - canvas.js (SVG interaction) |  |  |
|                                          |  | - dsl-edit.js (Surgical AST)  |  |  |
|                                          |  | - vocabulary.js (C4 + AI)     |  |  |
|                                          |  | - review.js (STRIDE / OWASP)  |  |  |
|                                          |  +-------------------------------+  |  |
|                                          |                 ^                   |  |
|                                          |                 |                   |  |
|                                          |  +-------------------------------+  |  |
|                                          |  | renderer/app.js (Host)        |  |  |
|                                          |  | - Monaco buffer sync          |  |  |
|                                          |  | - special:canvas mount        |  |  |
|                                          |  | - Setup panel lifecycle       |  |  |
|                                          |  +-------------------------------+  |  |
|                                          +-------------------------------------+  |
+-----------------------------------------------------------------------------------+
```

### The 5 Ledger Invariants (R-1 to R-5)

Reconciled with architectural decision `grill-me D16`:

*   **R-1: Two Envelopes, One Store**  
    Two top-level envelope shapes coexist peacefully in `ledger/*.jsonl`:
    *   `harness_v1`: Harness charter events written exactly as formatted by Claude Harness (`event_id`, `ts`, `kind`, `project`, `payload`).
    *   `designc_v1`: DesignC operational events (`event_id`, `ts`, `kind`, `project`, `payload`, etc.).
*   **R-2: Normalized In-Memory Sorting (`_ts`)**  
    Each envelope retains its native timestamp on disk (`ts` as ISO-8601 string or numeric timestamp). On read, `parseLedgerLine` / `splitLedgerTokens` injects a synthetic numeric `_ts` property in-memory. The UI and sort routines in `core.js` and `app.js` sort strictly on `_ts`, eliminating cross-envelope timestamp sorting bugs.
*   **R-3: Disjoint Closed Kind Sets**  
    The set of allowed kinds for Harness (`HARNESS_KINDS`) and DesignC (`DESIGNC_KINDS`) are strictly disjoint sets defined in `renderer/ledger.js`. Pinned against `~/.claude/harness/event.py` by unit test (`ledger.harness.test.js`).
*   **R-4: Gate Isolation**  
    The Ready-to-Build Gate in `core.js` only inspects DesignC `needs_decision` events. A Harness `NeedsDecision` or `Decision` event in the ledger never gates or blocks the DesignC build gate.
*   **R-5: Single Append Path (The Store is the Sole Writer)**  
    All writes to `ledger/*.jsonl` must route through `ledgerStore.append()` in the Node.js main process via IPC `host.appendLedger(event)`. Direct renderer file appends are prohibited and guarded by static analysis tests (`ledger-guard.test.js`).

---

## 3. Component Deep-Dive

### 3.1. Unified Ledger Subsystem (`LS-01` .. `LS-05`)

#### File Breakdown
*   `designc-desktop/app/ledger-store.js`:
    *   Node-side store singleton.
    *   Validates event payload schema prior to appending.
    *   Assigns legacy event IDs (`legacy:<filename>:<line>`) when parsing pre-existing un-enveloped lines.
    *   Resolves `project` name from `designc.json` (falling back to registry folder basename).
*   `designc-desktop/app/renderer/ledger.js`:
    *   Houses schemas, validators (`validateEnvelope`, `validatePayload`), envelope builders (`buildDesigncEvent`, `buildHarnessEvent`).
    *   Exports `DESIGNC_KINDS`: `['check', 'escape', 'run', 'handover', 'extraction', 'needs_decision', 'needs_decision_resolved', 'design_review']`.
    *   Exports `HARNESS_KINDS`: `['SessionStart', 'Done', 'PhaseChange', 'ToolCall', 'Checkpoint', 'NeedsDecision', 'Decision', 'ArtifactCreated']`.
    *   Implements `splitLedgerTokens` to parse JSONL streams robustly without splitting on embedded linebreaks or corrupted tokens.
*   `designc-desktop/app/main.js` & `preload.js`:
    *   IPC bridge handler `ledger:append` receiving renderer payloads and passing them to `ledger-store.js`.

---

### 3.2. DesignC Canvas Add-On (`designc-canvas`)

A lightweight, zero-dependency visual diagramming and architectural review engine for Structurizr C4 and Agentic AI architectures.

#### Subsystem Architecture (`designc-desktop/app/renderer/canvas/`)
1.  **`vocabulary.js`**:
    *   Stencil definitions: Person, Software System, Container, Component, Database, Queue/Topic, External System, and Agentic AI primitives (Autonomous Agent, Deterministic Tool, Guardrail/Safety Boundary, Vector Store, LLM Gateway).
    *   Properties catalog (`agent.agency`, `agent.model`, `stride.*`, `owasp.*`).
2.  **`dsl-edit.js`**:
    *   Surgical AST editor for Structurizr DSL (`workspace.dsl`).
    *   Inserts, renames, updates, and deletes elements and relationships without corrupting user formatting, indents, or comments.
3.  **`layout.js`**:
    *   Persists canvas coordinates `(x, y, w, h)` to `model/layout.json`.
    *   Ensures visual layouts are decoupled from DSL semantics.
4.  **`agentic-rules.js`**:
    *   Linter rules for agentic systems:
        *   `AG001`: Lethal Trifecta (autonomous execution + sensitive data + external network without guardrail).
        *   `AG002`: Excessive Agency (unconstrained tool capabilities).
        *   `AG003`: Uncapped recursion/loop cycles.
        *   `AG004`–`AG010`: Context poisoning, prompt injection surface, unvalidated memory sinks.
5.  **`review.js`**:
    *   Automated design review generator. Analyzes model graph and outputs a Markdown design review document covering findings, quality assessment, STRIDE threat model, and OWASP Top 10 for LLM risks.
6.  **`templates.js`**:
    *   One-click starter templates (RAG Pattern, Dual-Agent Critic, Microservices Gateway).
7.  **`canvas.js` & `canvas.css`**:
    *   Interactive SVG canvas. Implements pan (middle-click/drag), zoom (wheel), node drag with grid snapping, connection handle dragging, and stencil placement palette.

#### Core & Host Integration
*   `renderer/core.js`: Patched with `Core.registerProperties`, `Core.registerRules`, and `Core.specsFor` to allow add-ons to extend DSL validation rules dynamically without altering core Structurizr engine semantics.
*   `renderer/app.js`:
    *   Mounted as `special:canvas` tab.
    *   Two-way sync: Canvas edits write directly into the Monaco editor buffer using `pushEditOperations`, preserving undo/redo history.
    *   Review export writes to `reviews/*.md` and registers a `design_review` event in the ledger.

---

### 3.3. Canvas Setup-Panel Non-Blocking Fix (`d6a013f`)

#### The Problem
When opening a registry where `designc.json` was missing configurations (e.g. LLM endpoints, Langfuse), `syncSetup()` in `app.js` automatically popped the "Set up this registry" modal (`#setup`). This modal (`position: fixed; z-index: 45; width: 520px;`) rendered directly over the Canvas drawing surface. Because the modal intercepted all pointer events, users could neither drag stencils nor interact with nodes, creating the appearance of an unresponsive, noisy canvas.

#### The Fix
*   `syncSetup()` modified to suppress auto-opening when `A.active === 'special:canvas'`.
*   `activate(id)` modified to automatically hide an open setup panel upon navigating into Canvas (`prevId !== id`), preventing viewport clutter.
*   Preserved on-demand access: A `prevId !== id` guard guarantees that manual triggers (status-bar "Set up this registry" button, Help menu, command palette `setup-registry`) still function and persist while on Canvas.

---

## 4. Complete Inventory of Changed & Added Files

| File | Status | Description |
|---|---|---|
| `designc-desktop/app/ledger-store.js` | **New** | Node-side atomic ledger store; validates event schemas; legacy line compatibility. |
| `designc-desktop/app/renderer/ledger.js` | **New** | Ledger schemas, validation, envelope constructors, `splitLedgerTokens` tokenizer. |
| `designc-desktop/app/renderer/canvas/canvas.js` | **New** | SVG drawing engine, pointer event handling, node selection, pan & zoom. |
| `designc-desktop/app/renderer/canvas/canvas.css` | **New** | Layout and styling for SVG viewport, node cards, connection lines, stencil drawer. |
| `designc-desktop/app/renderer/canvas/dsl-edit.js` | **New** | Surgical Structurizr DSL AST editor preserving whitespace and comments. |
| `designc-desktop/app/renderer/canvas/vocabulary.js` | **New** | C4 + Agentic AI stencil and property definitions. |
| `designc-desktop/app/renderer/canvas/layout.js` | **New** | Persistence adapter for `model/layout.json`. |
| `designc-desktop/app/renderer/canvas/agentic-rules.js` | **New** | Architectural lint rules (`AG001`–`AG010`) for agentic AI patterns. |
| `designc-desktop/app/renderer/canvas/review.js` | **New** | Design review report generator (Markdown output with STRIDE / OWASP analysis). |
| `designc-desktop/app/renderer/canvas/templates.js` | **New** | Architectural starter templates. |
| `designc-desktop/app/renderer/core.js` | Modified | Core hooks: `registerProperties`, `registerRules`, `specsFor`. |
| `designc-desktop/app/renderer/app.js` | Modified | Canvas tab mounting, Monaco AST push operations, setup panel fix. |
| `designc-desktop/app/main.js` | Modified | Added `ledger:append` IPC handler. |
| `designc-desktop/app/preload.js` | Modified | Exposed `appendLedger` to window host bridge. |
| `designc-desktop/app/README.md` | Modified | Comprehensive documentation of code map extractor, registry setup, and ledger. |
| `designc-desktop/app/AGENTS.md` | Modified | Developer guidelines, invariant checklists, headless test instructions. |
| `designc-desktop/app/CLAUDE.md` | Modified | Quick-start reference and testing rules. |
| `designc-desktop/app/GOVERNANCE.md` | Modified | Ledger & canvas architecture invariants. |
| `designc-desktop/app/test/*.test.js` | **New** | 10 test suites covering all ledger schemas, canvas DSL edits, rules, and store invariants. |

---

## 5. Verification & Quality Gates

All changes satisfy the strict project gates:
1. **Module Import Gate**:
   ```powershell
   node -e "require('./extract.js')"
   # Exit Code: 0
   ```
2. **Unit & Integration Test Suites**:
   ```powershell
   node --test "test/**/*.test.js"
   # Output: 100 tests passed, 0 failed, 0 skipped
   ```
3. **Security Audit**:
   ```powershell
   npm audit --audit-level=high
   # Output: Only 2 pre-existing Electron framework advisories (clean of application vulnerabilities)
   ```
4. **Headless Electron UI Verification**:
   * Verified via `DESIGNC_STEPS` automation running against Electron offscreen renderer.
   * Confirmed setup modal remains closed on Canvas entry; stencils mount cleanly to DOM.

---

## 6. Personal Porting & Migration Roadmap

When integrating this into your personal repository (`xMikeTR/designc`):

1. **Direct Patch Application**:
   Export this branch as a git bundle or unified patch:
   ```bash
   git format-patch main..feat/canvas --stdout > feat-canvas.patch
   ```
2. **Key Enhancement Opportunities for Personal Work**:
   * **Canvas Engine Upgrade**: While `canvas.js` is lightweight and zero-dependency, consider porting the rendering layer to `@xyflow/react` (as used in `AugmentedSystemDesign`) for native smooth panning, mini-maps, background grids, and virtualized DOM rendering.
   * **Drag Frame Performance**: Currently, `canvas.js` re-renders SVG elements during drag. A direct DOM node translation optimization (`transform: translate3d(x,y,0)`) will eliminate layout recalculations on large diagrams.
   * **Connect Handles**: Increase the interactive hit-box padding of `.dcv-handle` from 6px to 14px for smoother relationship wiring.
