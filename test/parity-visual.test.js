'use strict';
// Parity tier 2: the pure pixel diff (renderer/parity-visual.js). Images are {width, height, data: RGBA bytes}.
const test = require('node:test');
const assert = require('node:assert');
const Visual = require('../renderer/parity-visual.js');

const img = (w, h, rgba = [255, 255, 255, 255]) => ({ width: w, height: h, data: Uint8Array.from({ length: w * h * 4 }, (_, i) => rgba[i % 4]) });
const paint = (im, x, y, rgba) => { const o = (y * im.width + x) * 4; rgba.forEach((v, k) => { im.data[o + k] = v; }); return im; };

test('identical images mismatch nowhere', () => {
  assert.deepStrictEqual(Visual.diff(img(10, 10), img(10, 10)), { ratio: 0, mismatched: 0, total: 100, sizeMismatch: false });
});

test('the ratio is changed pixels over all pixels', () => {
  const b = img(10, 10);
  paint(b, 0, 0, [0, 0, 0, 255]); paint(b, 1, 0, [0, 0, 0, 255]);
  const r = Visual.diff(img(10, 10), b);
  assert.strictEqual(r.mismatched, 2);
  assert.strictEqual(r.ratio, 0.02);
});

test('a difference below the per-channel tolerance is anti-aliasing, not a mismatch', () => {
  const b = paint(img(4, 4), 0, 0, [250, 250, 250, 255]); // 5 off on each channel
  assert.strictEqual(Visual.diff(img(4, 4), b, { channelTolerance: 8 }).mismatched, 0);
  assert.strictEqual(Visual.diff(img(4, 4), b, { channelTolerance: 2 }).mismatched, 1);
});

test('images of different sizes never match: the ratio is 1', () => {
  const r = Visual.diff(img(10, 10), img(10, 12));
  assert.strictEqual(r.sizeMismatch, true);
  assert.strictEqual(r.ratio, 1);
});

test('a masked rectangle is ignored on both sides', () => {
  const b = paint(img(10, 10), 5, 5, [0, 0, 0, 255]);
  assert.strictEqual(Visual.diff(img(10, 10), b).mismatched, 1);
  const masked = Visual.diff(img(10, 10), b, { masks: [{ x: 4, y: 4, width: 3, height: 3 }] });
  assert.strictEqual(masked.mismatched, 0);
  assert.strictEqual(masked.total, 100 - 9); // masked pixels leave the denominator too
});

test('a mask reaching past the edge is clipped, not an error', () => {
  const r = Visual.diff(img(4, 4), img(4, 4), { masks: [{ x: 2, y: 2, width: 100, height: 100 }, { x: -5, y: -5, width: 6, height: 6 }] });
  assert.strictEqual(r.total, 16 - 4 - 1);
});

test('judge: pass at or under the threshold, fail over it, and the default threshold is 0.1%', () => {
  assert.strictEqual(Visual.DEFAULT_THRESHOLD, 0.001);
  assert.strictEqual(Visual.judge({ ratio: 0.001 }).outcome, 'pass');
  const f = Visual.judge({ ratio: 0.002 });
  assert.deepStrictEqual([f.outcome, f.threshold, f.ratio], ['fail', 0.001, 0.002]);
  assert.strictEqual(Visual.judge({ ratio: 0.05 }, { threshold: 0.1 }).outcome, 'pass');
});

test('summarise: the worst step decides; steps with no shot on a side are skipped, never passed', () => {
  const s = Visual.summarise([
    { n: 1, ratio: 0.0005 },
    { n: 2, ratio: 0.02 },
    { n: 3, skipped: 'no baseline shot' },
  ], { threshold: 0.001 });
  assert.deepStrictEqual([s.outcome, s.ratio, s.threshold], ['fail', 0.02, 0.001]);
  assert.deepStrictEqual(s.failedSteps, [2]);
  assert.strictEqual(Visual.summarise([{ n: 1, skipped: 'x' }]).outcome, 'skipped');
  assert.strictEqual(Visual.summarise([]).outcome, 'skipped');
  assert.strictEqual(Visual.summarise([{ n: 1, ratio: 0 }, { n: 2, skipped: 'x' }]).outcome, 'pass');
});

test('bad thresholds are refused', () => {
  for (const t of [-1, 1.5, NaN, 'x']) assert.throws(() => Visual.judge({ ratio: 0 }, { threshold: t }), /threshold/);
});
