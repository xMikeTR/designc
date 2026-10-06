// Judge calibration: factory/labels/<dimension>.yaml holds rounds of a judge scored against human labels.
// Display only: nothing here gates. A dimension is ok, below (precision or recall under the threshold), stale
// (latest round older than maxAgeDays) or uncalibrated (no valid round).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../renderer/ledger.js');

const NOW = Date.UTC(2026, 9, 6);
const round = (date, over = {}) => ({ date, judge_version: 'j1', precision: 0.9, recall: 0.85, n: 40, ...over });
const st = (labels, opts) => Ledger.calibrationStatus(labels, { now: NOW, ...opts });

test('the latest round by date decides; both precision and recall must reach the threshold', () => {
  const r = st([{ dimension: 'test-gaming', rounds: [round('2026-09-20', { precision: 0.5 }), round('2026-10-01')] }]);
  assert.equal(r.dimensions[0].status, 'ok');
  assert.equal(r.dimensions[0].latest.judge_version, 'j1');
  assert.equal(r.dimensions[0].ageDays, 5);
  assert.equal(st([{ dimension: 'd', rounds: [round('2026-10-01', { recall: 0.79 })] }]).dimensions[0].status, 'below');
  assert.equal(st([{ dimension: 'd', rounds: [round('2026-10-01', { precision: 0.8, recall: 0.8 })] }]).dimensions[0].status, 'ok', 'exactly the threshold passes');
});

test('below names which measure fell short', () => {
  const d = st([{ dimension: 'd', rounds: [round('2026-10-01', { precision: 0.6, recall: 0.7 })] }]).dimensions[0];
  assert.deepEqual(d.short, ['precision', 'recall']);
});

test('a round older than 30 days is stale, and stale outranks ok but not below', () => {
  assert.equal(st([{ dimension: 'd', rounds: [round('2026-09-06')] }]).dimensions[0].status, 'ok', '30 days is not yet stale');
  assert.equal(st([{ dimension: 'd', rounds: [round('2026-09-05')] }]).dimensions[0].status, 'stale');
  assert.equal(st([{ dimension: 'd', rounds: [round('2026-08-01', { precision: 0.1 })] }]).dimensions[0].status, 'below');
  assert.equal(st([{ dimension: 'd', rounds: [round('2026-09-05')] }], { maxAgeDays: 60 }).dimensions[0].status, 'ok');
});

test('invalid rounds are reported and skipped; no valid round means uncalibrated', () => {
  const r = st([{ dimension: 'd', rounds: [{ date: 'soon', judge_version: 'j', precision: 0.9, recall: 0.9, n: 3 }, round('2026-10-01', { precision: 1.2 }), round('2026-10-02', { n: 0 }), round('2026-10-03', { judge_version: '' }), round('2026-09-30')] }, { dimension: 'e', rounds: [] }]);
  assert.deepEqual(r.problems, [
    'd round 1: date must be YYYY-MM-DD',
    'd round 2: precision must be a number from 0 to 1',
    'd round 3: n must be a whole number of at least 1',
    'd round 4: judge_version is required',
  ]);
  assert.equal(r.dimensions[0].latest.date, '2026-09-30');
  assert.equal(r.dimensions[1].status, 'uncalibrated');
  assert.equal(r.dimensions[1].latest, null);
});

test('a file that is not a rounds list is a problem, not a throw; repeated dimensions count once', () => {
  const r = st([{ dimension: 'a', rounds: 'x' }, { dimension: 'b' }, { dimension: 'b', rounds: [round('2026-10-01')] }, null]);
  assert.deepEqual(r.problems, ['a: rounds must be a list', 'b: rounds must be a list', 'b is listed more than once', 'a file in factory/labels is not a mapping']);
  assert.deepEqual(r.dimensions.map(d => d.dimension), ['a', 'b']);
});

test('dimensions are sorted by name, and a custom threshold applies', () => {
  const r = st([{ dimension: 'z', rounds: [round('2026-10-01')] }, { dimension: 'a', rounds: [round('2026-10-01')] }], { threshold: 0.95 });
  assert.deepEqual(r.dimensions.map(d => [d.dimension, d.status]), [['a', 'below'], ['z', 'below']]);
});
