# system3-registry

Fixture for System 3 (D7 part 2). `ledger/pipeline.jsonl` is the Factory's projected rows, copied verbatim from
`factory-s2-workbook/tests/Factory.Integration.Tests/Fixtures/system3/projected.jsonl` (F8; regenerate there, then copy).
`ledger/designc.jsonl` holds hand-written escapes and `escape_classified` rows. `parity/qa/bordereaux.yaml` is a QA report
with one bug in each bucket (the parity-registry data, renamed to the bordereaux screen); acceptance verdicts carry no
screen, so they land in "no screen". Specs map the tasks' elements (`App/Portal`, `App/Summary`) to the screens.
