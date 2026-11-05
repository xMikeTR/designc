/* designc desktop: legacy UI parity, tier 2 (pixels). Pure, no I/O, no dependencies; dual-loaded like parity.js.
   Tier 1 (parity.js) compares the accessibility tree; this compares screenshots. An image is {width, height, data}
   with data holding RGBA bytes (a PNG decoder lives in the caller, scripts/parity-record.js).

   The ratio is mismatched pixels over compared pixels, against the legacy baseline. A pixel counts as changed when any
   channel differs by more than channelTolerance (so font anti-aliasing is not a finding). Masked rectangles leave both
   the numerator and the denominator. Images of different sizes never match. */
const ParityVisual = (() => {
  const DEFAULT_THRESHOLD = 0.001; // 0.1%
  const DEFAULT_CHANNEL_TOLERANCE = 8;

  function checkThreshold(t) {
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 1) throw new Error(`threshold must be a ratio from 0 to 1, got ${t}`);
    return t;
  }

  // Which pixels the masks cover, clipped to the image.
  function maskGrid(width, height, masks) {
    const grid = new Uint8Array(width * height);
    for (const m of masks || []) {
      const x0 = Math.max(0, m.x), y0 = Math.max(0, m.y);
      const x1 = Math.min(width, m.x + m.width), y1 = Math.min(height, m.y + m.height);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) grid[y * width + x] = 1;
    }
    return grid;
  }

  function diff(a, b, { channelTolerance = DEFAULT_CHANNEL_TOLERANCE, masks = [] } = {}) {
    if (a.width !== b.width || a.height !== b.height) return { ratio: 1, mismatched: a.width * a.height, total: a.width * a.height, sizeMismatch: true };
    const grid = maskGrid(a.width, a.height, masks);
    let mismatched = 0, total = 0;
    for (let p = 0; p < a.width * a.height; p++) {
      if (grid[p]) continue;
      total++;
      const o = p * 4;
      if (Math.abs(a.data[o] - b.data[o]) > channelTolerance || Math.abs(a.data[o + 1] - b.data[o + 1]) > channelTolerance
        || Math.abs(a.data[o + 2] - b.data[o + 2]) > channelTolerance || Math.abs(a.data[o + 3] - b.data[o + 3]) > channelTolerance) mismatched++;
    }
    return { ratio: total ? mismatched / total : 0, mismatched, total, sizeMismatch: false };
  }

  function judge({ ratio }, { threshold = DEFAULT_THRESHOLD } = {}) {
    checkThreshold(threshold);
    return { ratio, threshold, outcome: ratio <= threshold ? 'pass' : 'fail' };
  }

  // One scenario: per-step results ({n, ratio} or {n, skipped: why}). The worst step decides. Steps with no image on a
  // side are skipped, and a scenario with nothing compared is skipped: never a pass.
  function summarise(steps, { threshold = DEFAULT_THRESHOLD } = {}) {
    checkThreshold(threshold);
    const compared = steps.filter(s => typeof s.ratio === 'number');
    if (!compared.length) return { outcome: 'skipped', ratio: null, threshold, failedSteps: [] };
    const ratio = Math.max(...compared.map(s => s.ratio));
    const failedSteps = compared.filter(s => s.ratio > threshold).map(s => s.n);
    return { outcome: failedSteps.length ? 'fail' : 'pass', ratio, threshold, failedSteps };
  }

  return { DEFAULT_THRESHOLD, DEFAULT_CHANNEL_TOLERANCE, diff, judge, summarise };
})();
if (typeof module !== 'undefined') module.exports = ParityVisual;
