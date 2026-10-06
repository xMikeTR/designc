const { test } = require('node:test');
const assert = require('node:assert/strict');
const Quality = require('../renderer/quality.js');

const m = (name, cc, lines, coverage) => ({ name, file: `${name}.cs`, line: 10, endLine: 10 + lines - 1, cc, lines, ...(coverage === undefined ? {} : { coverage }) });
const code = {
  types: [
    { id: 't1', name: 'Orders', kind: 'class', component: 'c1', container: 'Api', files: [{ file: 'Orders.cs', line: 1, endLine: 90 }], methods: [m('Make', 15, 70), m('Find', 2, 5)] },
    { id: 't2', name: 'Repo', kind: 'class', component: 'c1', container: 'Api', files: [{ file: 'Repo.cs', line: 1, endLine: 9 }], methods: [m('Get', 3, 4)] },
    { id: 't3', name: 'Job', kind: 'class', component: 'c2', container: 'Worker', files: [{ file: 'Job.cs', line: 1, endLine: 9 }], methods: [m('Run', 12, 9)] },
  ],
  typeEdges: [{ from: 't1', to: 't2', via: 'uses', evidence: { file: 'Orders.cs', line: 3 } }, { from: 't1', to: 't3', via: 'new', evidence: { file: 'Orders.cs', line: 4 } }],
};

test('CRAP is cc squared times uncovered cubed plus cc', () => {
  assert.equal(Quality.crap(10, 1), 10);
  assert.equal(Quality.crap(10, 0), 110);
  assert.equal(Quality.crap(4, 0.5), 16 * 0.125 + 4);
  assert.equal(Quality.crap(4, null), null);
});

test('a number is a maximum for lower-is-better metrics; breach means strictly above', () => {
  const r = Quality.judge(code, { cyclomatic: 10 });
  const f = r.findings.filter(x => x.code === 'QC001');
  assert.deepEqual(f.map(x => [x.type, x.method, x.value, x.limit]), [['Orders', 'Make', 15, 10], ['Job', 'Run', 12, 10]]);
  assert.ok(f.every(x => x.sev === 'warning'));
  assert.equal(Quality.judge(code, { cyclomatic: 15 }).findings.length, 0); // 15 is not above 15
});

test('findings carry the file and line to open and a plain message', () => {
  const [f] = Quality.judge(code, { cyclomatic: 10 }).findings;
  assert.equal(f.file, 'Make.cs'); assert.equal(f.line, 10); // the method's own file
  assert.match(f.msg, /Orders\.Make/); assert.match(f.msg, /15/); assert.match(f.msg, /10/);
});

test('no coverage means CRAP is unknown, not zero and not a breach', () => {
  const r = Quality.judge(code, { crap: 5 });
  assert.equal(r.findings.length, 0);
  assert.equal(r.rollup.type.get('t1').metrics.crap.unknown, 2);
  assert.equal(r.rollup.type.get('t1').metrics.crap.worst, null);
});

test('with coverage, CRAP is judged per method', () => {
  const c2 = JSON.parse(JSON.stringify(code)); c2.types[0].methods[0].coverage = 0.2; c2.types[0].methods[1].coverage = 1;
  const r = Quality.judge(c2, { crap: 30 });
  assert.deepEqual(r.findings.map(x => [x.method, Math.round(x.value)]), [['Make', Math.round(15 * 15 * 0.8 ** 3 + 15)]]);
  assert.equal(r.rollup.type.get('t1').metrics.crap.unknown, 0);
});

test('coupling is judged per type, from outgoing type edges', () => {
  const r = Quality.judge(code, { coupling: 1 });
  assert.deepEqual(r.findings.map(x => [x.code, x.type, x.method, x.value]), [['QC004', 'Orders', undefined, 2]]);
});

test('{min} flips the direction and {max} is explicit', () => {
  const reg = Quality.create();
  reg.register({ id: 'tested', code: 'QX1', title: 'Tests', scope: 'type', better: 'higher', value: t => t.name === 'Orders' ? 3 : 9 });
  const r = reg.judge(code, { tested: { min: 5 } });
  assert.deepEqual(r.findings.map(x => [x.type, x.value, x.limit]), [['Orders', 3, 5]]);
  assert.match(r.findings[0].msg, /below/);
  assert.equal(Quality.judge(code, { cyclomatic: { max: 10 } }).findings.length, 2);
});

test('a new metric is added without touching the judge, and the default registry is unaffected', () => {
  const reg = Quality.create();
  reg.register({ id: 'params', code: 'QX2', title: 'Parameters', scope: 'method', better: 'lower', value: x => x.cc * 2 });
  assert.equal(reg.judge(code, { params: 25 }).findings.length, 1);
  assert.ok(!Quality.metrics().some(x => x.id === 'params'));
  assert.throws(() => reg.register({ id: 'params', code: 'QX3', scope: 'method', better: 'lower', value: () => 1 }), /already/);
  assert.throws(() => reg.register({ id: 'bad', code: 'QX4', scope: 'galaxy', better: 'lower', value: () => 1 }), /scope/);
});

test('bad settings are reported as problems and never throw', () => {
  const r = Quality.judge(code, { cyclomatic: 'ten', nothing: 3, crap: { max: 5, min: 1 }, methodLines: -2 });
  assert.equal(r.problems.length, 4);
  assert.ok(r.problems.some(p => /nothing/.test(p) && /not a known metric/.test(p)));
  assert.equal(r.findings.length, 0);
  assert.deepEqual(Quality.judge(code, undefined).findings, []);
  assert.deepEqual(Quality.judge(null, { cyclomatic: 1 }).findings, []);
});

test('rollups give the worst value and breach count per type, component and container', () => {
  const r = Quality.judge(code, { cyclomatic: 10 });
  assert.deepEqual(r.rollup.type.get('t1').metrics.cyclomatic, { worst: 15, breaches: 1, unknown: 0 });
  assert.equal(r.rollup.type.get('t2').breaches, 0);
  assert.equal(r.rollup.component.get('c1').breaches, 1);
  assert.equal(r.rollup.component.get('c1').metrics.cyclomatic.worst, 15);
  assert.equal(r.rollup.container.get('Api').breaches, 1);
  assert.equal(r.rollup.container.get('Worker').breaches, 1);
});

test('findings are ordered worst first within a code, then by name', () => {
  const r = Quality.judge(code, { cyclomatic: 1 });
  const v = r.findings.filter(x => x.code === 'QC001').map(x => x.value);
  assert.deepEqual(v, [...v].sort((a, b) => b - a));
});
