# core-registry fixture

Synthetic and replaceable: a small registry for the headless core (`headless/`, `scripts/designc-core.js`), the
verdict query and the context bundle. `handovers/20261102-abcd1234` is a hand-made item handover (its `files:` list
is empty and its revision invented), so it is not a real freeze; the bundle tests read its decision and requirement
copies. `docs/context-bundle.example.json` is generated from it (`test/headless.test.js` pins it).
