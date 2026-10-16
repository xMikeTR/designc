// Error analysis reads telemetry at the level of one task attempt: a span that carries the task field, and the model
// turns and tool calls under it. Content (messages, tool arguments and results) is there only when the pipeline
// captures it; the OpenTelemetry GenAI attribute names are standard, Langfuse prefixes them with `attributes.`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { taskSpans, traceSteps, DEFAULTS } = require('../telemetry.js');

const cfg = { ...DEFAULTS, baseUrl: 'http://lf', fields: { ...DEFAULTS.fields, task: 'attributes.factory.task', run: 'attributes.factory.run_id', attempt: 'attributes.factory.attempt', passed: 'attributes.factory.score.task_passed', element: 'attributes.factory.element' } };
const T0 = Date.parse('2026-10-16T10:00:00Z');
const iso = s => new Date(T0 + s * 1000).toISOString();
const ob = (id, parent, type, name, s, e, extra = {}) => ({ id, traceId: 'tr1', projectId: 'p', parentObservationId: parent, type, name, startTime: iso(s), endTime: iso(e), level: 'DEFAULT', metadata: {}, ...extra });

const rows = [
  ob('run', null, 'SPAN', 'run r1', 0, 100, { isRootObservation: true }),
  ob('t1', 'run', 'SPAN', 'task T-001', 1, 50, { metadata: { 'attributes.factory.task': 'T-001', 'attributes.factory.run_id': 'r1', 'attributes.factory.attempt': 2, 'attributes.factory.score.task_passed': 0, 'attributes.factory.element': ['Sys/Api'] } }),
  ob('g1', 't1', 'GENERATION', 'chat m', 2, 5, { model: 'm', inputUsage: 100, outputUsage: 20, metadata: {
    'attributes.gen_ai.system_instructions': JSON.stringify([{ type: 'text', content: 'You are the implementer.' }]),
    'attributes.gen_ai.input.messages': JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'Add QuoteStatus' }] }]),
    'attributes.gen_ai.output.messages': JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'Plan: write it' }, { type: 'tool_call', id: 'c1', name: 'write_file', arguments: { path: 'a.cs' } }] }]),
  } }),
  ob('x1', 't1', 'SPAN', 'orchestrate_tools', 5, 7),
  ob('k1', 'x1', 'TOOL', 'write_file', 5, 6, { level: 'ERROR', statusMessage: 'missing content', metadata: { 'attributes.gen_ai.tool.call.arguments': '{"path":"a.cs"}' } }),
  ob('g2', 't1', 'GENERATION', 'chat m', 8, 9, { model: 'm', inputUsage: 150, outputUsage: 10, metadata: {
    'attributes.gen_ai.input.messages': JSON.stringify([
      { role: 'user', parts: [{ type: 'text', content: 'Add QuoteStatus' }] },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'write_file', arguments: { path: 'a.cs' } }] },
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 'c1', response: 'missing content' }] },
      { role: 'user', parts: [{ type: 'text', content: 'Checks failed: build' }] }]),
  } }),
  ob('k2', 'x1', 'TOOL', 'read_file', 9, 10, { input: { path: 'b.cs' }, output: 'class B {}' }),
  ob('t2', 'run', 'SPAN', 'task T-002', 60, 61, { metadata: { 'attributes.factory.task': 'T-002', 'attributes.factory.score.task_passed': 1 } }),
  ob('other', null, 'SPAN', 'task T-009', 0, 1, { traceId: 'tr2', metadata: { 'attributes.factory.task': 'T-009' } }),
];

test('taskSpans: one attempt per span carrying the task field, with its outcome, steps and errors', () => {
  const r = taskSpans(rows, cfg);
  assert.deepEqual(r.spans.map(s => s.id), ['t1']);
  const s = r.spans[0];
  assert.equal(s.task, 'T-001');
  assert.equal(s.run, 'r1');
  assert.equal(s.attempt, 2);
  assert.equal(s.element, 'Sys/Api');
  assert.equal(s.outcome, 'failed');
  assert.equal(s.steps, 5);
  assert.equal(s.errors, 1);
  assert.equal(s.tokens, 280);
  assert.equal(s.start, T0 + 1000);
  assert.equal(s.durationMs, 49000);
  assert.equal(s.url, 'http://lf/project/p/traces/tr1?observation=t1');
  assert.equal(r.empty, 2, 'attempts with no steps are counted, not queued');
});

test('taskSpans: passed from the score field, unknown with neither; no task field means none', () => {
  const r = taskSpans([...rows, ob('g9', 't2', 'GENERATION', 'chat', 60, 61)], cfg);
  assert.equal(r.spans.find(s => s.id === 't2').outcome, 'passed');
  assert.equal(taskSpans([ob('a', null, 'SPAN', 'task', 0, 1), ob('b', 'a', 'TOOL', 'x', 0, 1)], cfg).spans.length, 0);
  const noScore = [ob('a', null, 'SPAN', 'task', 0, 1, { metadata: { 'attributes.factory.task': 'T' } }), ob('b', 'a', 'TOOL', 'x', 0, 1)];
  assert.equal(taskSpans(noScore, cfg).spans[0].outcome, 'unknown');
});

test('traceSteps: model turns and tool calls in order, new instructions only, content when captured', () => {
  const r = traceSteps(rows, 't1');
  assert.deepEqual(r.steps.map(s => [s.kind, s.name, s.depth]), [['model', 'chat m', 0], ['span', 'orchestrate_tools', 0], ['tool', 'write_file', 1], ['model', 'chat m', 0], ['tool', 'read_file', 1]]);
  const [g1, , k1, g2, k2] = r.steps;
  assert.equal(r.system, 'You are the implementer.');
  assert.deepEqual(g1.fresh, [{ role: 'user', parts: [{ type: 'text', text: 'Add QuoteStatus' }] }], 'the brief');
  assert.deepEqual(g1.output, [{ role: 'assistant', parts: [{ type: 'text', text: 'Plan: write it' }, { type: 'tool_call', name: 'write_file', arguments: '{"path":"a.cs"}' }] }]);
  assert.equal(g1.tokensIn, 100);
  assert.equal(g1.ms, 3000);
  assert.deepEqual(g2.fresh, [{ role: 'user', parts: [{ type: 'text', text: 'Checks failed: build' }] }], 'what was said since the last turn, not the whole history');
  assert.equal(k1.error, 'missing content');
  assert.equal(k1.arguments, '{"path":"a.cs"}');
  assert.equal(k1.result, null);
  assert.equal(k2.arguments, '{"path":"b.cs"}', 'observation input when there is no attribute');
  assert.equal(k2.result, 'class B {}');
  assert.equal(r.captured, true);
});

test('traceSteps: without captured content it says so; an unknown span is an error', () => {
  const bare = rows.map(o => ({ ...o, metadata: {}, input: null, output: null }));
  assert.equal(traceSteps(bare, 't1').captured, false);
  assert.ok(traceSteps(rows, 'nope').error);
});

test('traceSteps: OpenAI-shaped messages and plain strings are read too', () => {
  const r = traceSteps([ob('t', null, 'SPAN', 'task', 0, 9), ob('g', 't', 'GENERATION', 'chat', 1, 2, { input: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }], output: 'done' })], 't');
  assert.deepEqual(r.steps[0].fresh, [{ role: 'system', parts: [{ type: 'text', text: 'sys' }] }, { role: 'user', parts: [{ type: 'text', text: 'go' }] }]);
  assert.deepEqual(r.steps[0].output, [{ role: 'assistant', parts: [{ type: 'text', text: 'done' }] }]);
});

test('taskSpans: the outermost observation with the task field is the attempt, whatever its type, never a model or tool call', () => {
  const m = { metadata: { 'attributes.factory.task': 'T-7' } };
  const r = taskSpans([ob('a', null, 'AGENT', 'task T-7', 0, 9, m), ob('g', 'a', 'GENERATION', 'chat', 1, 2, m), ob('k', 'g', 'TOOL', 'x', 2, 3, m), ob('lone', null, 'TOOL', 'y', 0, 1, m)], cfg);
  assert.deepEqual(r.spans.map(s => [s.id, s.steps]), [['a', 2]]);
});
