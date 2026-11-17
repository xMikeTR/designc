Scripted legacy and new apps for the fixture adapter (`recorder/adapters/fixture.js`). The new app writes inception
dates as `2026-01-15` where legacy writes `15/01/2026`, so `bordereaux-list` fails on shape; `bordereaux-apply` masks that column and passes.
