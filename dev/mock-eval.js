// A scripted eval runner. Writes the results file designc reads: {"metrics": {...}, "cases": N}.
// Usage: node dev/mock-eval.js <results path>
// MOCK_EVAL_SCORE sets task_success (default 0.9); MOCK_EVAL_BROKEN=1 writes a file that is not JSON.
const fs = require('fs');
const path = require('path');

const out = process.argv[2];
if (!out) { console.error('usage: node dev/mock-eval.js <results path>'); process.exit(2); }
fs.mkdirSync(path.dirname(out), { recursive: true });
if (process.env.MOCK_EVAL_BROKEN === '1') { fs.writeFileSync(out, 'not json'); process.exit(0); }
const score = Number(process.env.MOCK_EVAL_SCORE || 0.9);
fs.writeFileSync(out, JSON.stringify({ metrics: { task_success: score, p95_latency_ms: 800 }, cases: 40 }, null, 2) + '\n');
console.log(`wrote ${out} (task_success ${score})`);
