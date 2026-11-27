// S10: mint_decision takes optional options. agent.js needs the DOM, so the handler's source is cut out and
// evaluated here with stubs for the app's globals (the same way checker-draft.test.js does for its block).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Records = require('../renderer/records.js');
const Core = require('../renderer/core.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'agent.js'), 'utf8');
const LINES = SRC.split('\n');
const obj = (props, req = []) => ({ type: 'object', properties: props, required: req, additionalProperties: false });

function handler() {
  const a = LINES.findIndex(l => l.startsWith('  mint_decision: a => {'));
  const b = LINES.findIndex((l, i) => i > a && l === '  },');
  assert.ok(a >= 0 && b > a, 'agent.js has the mint_decision handler');
  const body = LINES.slice(a, b + 1).join('\n');
  const writes = {};
  const stubs = {
    Policy: { checkProblem: () => null }, Knowledge: { overlaps: () => [] }, Core, A: { decisions: [], tree: [] },
    elResolver: () => null, esc: s => String(s), AG: { approved: new Map() },
    host: { write: async (p, t) => { writes[p] = t; }, tree: async () => [] },
    loadRegistry: async () => {}, recompile: () => {}, renderAll: () => {},
    yamlList: a => `[${(a || []).map(x => /[:,\[\]{}#&*!|>'"%@`]/.test(x) ? JSON.stringify(x) : x).join(', ')}]`,
    yamlStr: s => JSON.stringify(String(s || '')),
  };
  const fn = new Function(...Object.keys(stubs), `return {${body}}.mint_decision;`)(...Object.values(stubs));
  return { fn, writes };
}
const ARGS = { statement: 'Use a queue', effect: 'fix', binds: ['A'], checks: ['npm test'], rationale: 'because' };

test('mint_decision: options are written after statement and the file validates', async () => {
  const { fn, writes } = handler();
  const opts = ['keep the queue', 'move to a stream: costly'];
  const r = fn({ ...ARGS, options: opts });
  await r.apply();
  const text = Object.values(writes)[0];
  const d = yaml.load(text);
  assert.deepEqual(d.options, opts);
  const lines = text.split('\n'), i = lines.findIndex(l => l.startsWith('statement:'));
  assert.equal(lines[i + 1], 'options:');
  assert.deepEqual(Records.validate('decision', d), []);
});

test('mint_decision: without options (or an empty list) the file is unchanged', async () => {
  const a = handler(), b = handler();
  await a.fn(ARGS).apply(); await b.fn({ ...ARGS, options: [] }).apply();
  const ta = Object.values(a.writes)[0];
  assert.equal(ta, Object.values(b.writes)[0]);
  assert.equal(/options/.test(ta), false);
});

test('mint_decision tool definition: an optional options array of strings', () => {
  const line = LINES.find(l => l.startsWith('  mint_decision: { d:'));
  const t = new Function('obj', `return {${line}}`)(obj).mint_decision;
  assert.deepEqual(t.p.properties.options, { type: 'array', items: { type: 'string' }, description: 'the options considered before deciding, each a short phrase' });
  assert.equal(t.p.required.includes('options'), false);
});
