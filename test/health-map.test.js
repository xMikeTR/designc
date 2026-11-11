// Health overlay: SARIF findings -> C4 elements. A pure function of SARIF, element paths and config; no analyzer runs here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../renderer/health-map.js');

const ELEMENTS = [
  { id: 'pricing-api', kind: 'system', paths: [] },
  { id: 'pricing-api.api', parent: 'pricing-api', paths: ['src/Pricing/**'] },
  { id: 'pricing-api.quote-service', parent: 'pricing-api.api', paths: ['src/Pricing/Quotes/**'] },
  { id: 'pricing-api.worker', parent: 'pricing-api', paths: ['src/Worker/**'] },
];
const CONFIG = {
  exclude: ['**/bin/**', '**/obj/**', '**/node_modules/**', '**/*.g.cs'],
  categories: [{ prefix: 'CPD', category: 'duplication' }, { prefix: 'S1', category: 'smell' }, { prefix: 'CA2', category: 'security' }, { prefix: 'knip/', category: 'dead-code' }],
};
const res = (uri, o = {}) => ({ ruleId: 'S1', level: 'warning', message: { text: 'm' },
  locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 10 } } }], ...o });
const log = (...results) => ({ version: '2.1.0', runs: [{ tool: { driver: { name: 't' } }, results }] });
const run = (results, extra = {}) => M.mapFindings({ sarif: log(...results), elements: ELEMENTS, config: CONFIG, ...extra });

test('longest match wins: a finding in Quotes belongs to the quote-service, not the api', () => {
  const r = run([res('src/Pricing/Quotes/QuoteHandler.cs')]);
  assert.equal(r.mapped[0].id, 'pricing-api.quote-service');
  assert.equal(r.elements['pricing-api.quote-service'].total, 1);
});

test('a finding in the api but outside Quotes lands on the api only', () => {
  const r = run([res('src/Pricing/Other.cs')]);
  assert.equal(r.mapped[0].id, 'pricing-api.api');
  assert.equal(r.elements['pricing-api.quote-service'].total, 0);
});

test('counts roll up to every ancestor, so the system view sums its components', () => {
  const r = run([res('src/Pricing/Quotes/A.cs'), res('src/Pricing/Quotes/B.cs', { level: 'error' }), res('src/Worker/W.cs', { level: 'note' })]);
  assert.equal(r.elements['pricing-api.quote-service'].total, 2);
  assert.equal(r.elements['pricing-api.api'].total, 2);
  assert.equal(r.elements['pricing-api.worker'].total, 1);
  assert.equal(r.elements['pricing-api'].total, 3);
  assert.deepEqual(r.elements['pricing-api'].byLevel, { warning: 1, error: 1, note: 1 });
});

test('a more specific glob beats a broader one regardless of element order', () => {
  const els = [{ id: 'broad', paths: ['src/**'] }, { id: 'narrow', paths: ['src/Pricing/*.cs'] }];
  assert.equal(M.ownerOf('src/Pricing/A.cs', els), 'narrow');
  assert.equal(M.ownerOf('src/Pricing/A.cs', [...els].reverse()), 'narrow');
});

test('equal specificity goes to the smaller element id, so the answer is stable', () => {
  const els = [{ id: 'b', paths: ['src/**'] }, { id: 'a', paths: ['src/**'] }];
  assert.equal(M.ownerOf('src/x.cs', els), 'a');
});

test('excluded globs are dropped before matching and counted separately, never as unmapped', () => {
  const r = run([res('src/Pricing/obj/Debug/x.cs'), res('src/Pricing/Quotes/Gen.g.cs'), res('src/Worker/node_modules/p/i.js'), res('src/Pricing/Quotes/Real.cs')]);
  assert.equal(r.excluded, 3);
  assert.equal(r.unmapped.findings, 0);
  assert.equal(r.elements['pricing-api'].total, 1);
});

test('nothing matches: counted as unmapped, no owner guessed, no element counts touched', () => {
  const r = run([res('tools/script.cs'), res('src/Pricing/Quotes/A.cs')]);
  assert.equal(r.unmapped.findings, 1);
  assert.equal(r.elements['pricing-api'].total, 1);
  assert.equal(r.mapped.length, 1);
});

test('a result with no location is unmapped', () => {
  const r = run([{ ruleId: 'S1', message: { text: 'm' } }, { ruleId: 'S1', locations: [] }]);
  assert.equal(r.unmapped.findings, 2);
});

test('level comes through unchanged, and defaults to warning as SARIF says', () => {
  const noLevel = res('src/Worker/W.cs'); delete noLevel.level;
  const r = run([noLevel, res('src/Worker/W.cs', { level: 'error' }), res('src/Worker/W.cs', { level: 'none' })]);
  assert.deepEqual(r.elements['pricing-api.worker'].byLevel, { warning: 1, error: 1, none: 1 });
});

test('category comes from the rule-prefix table; unlisted rules are smells', () => {
  const r = run([res('src/Worker/W.cs', { ruleId: 'CPD0001' }), res('src/Worker/W.cs', { ruleId: 'CA2100' }), res('src/Worker/W.cs', { ruleId: 'knip/unused-export' }), res('src/Worker/W.cs', { ruleId: 'XYZ9' }), res('src/Worker/W.cs', { ruleId: undefined })]);
  assert.deepEqual(r.elements['pricing-api.worker'].byCategory, { duplication: 1, security: 1, 'dead-code': 1, smell: 2 });
});

test('uris are normalised: file://, backslashes, ./, percent-encoding and the repo root', () => {
  const root = '/home/me/repo';
  assert.equal(M.normaliseUri('file:///home/me/repo/src/A.cs', root), 'src/A.cs');
  assert.equal(M.normaliseUri('src\\Pricing\\A.cs'), 'src/Pricing/A.cs');
  assert.equal(M.normaliseUri('./src/A.cs'), 'src/A.cs');
  assert.equal(M.normaliseUri('src/My%20Dir/A.cs'), 'src/My Dir/A.cs');
  assert.equal(M.normaliseUri('file:///C:/repo/src/A.cs', 'C:\\repo'), 'src/A.cs');
});

test('a uri outside the repo, or with a dot segment, maps to nothing rather than to a guess', () => {
  assert.equal(M.normaliseUri('/etc/passwd', '/home/me/repo'), null);
  assert.equal(M.normaliseUri('src/Pricing/../../tools/x.cs'), null);
  assert.equal(M.normaliseUri('', null), null);
  assert.equal(M.normaliseUri(undefined, null), null);
  const r = run([res('src/Pricing/Quotes/../../../tools/x.cs')]);
  assert.equal(r.unmapped.findings, 1);
});

test('every element appears in the output, with zero counts when nothing landed', () => {
  const r = run([]);
  assert.deepEqual(Object.keys(r.elements).sort(), ELEMENTS.map(e => e.id).sort());
  assert.deepEqual(r.elements['pricing-api.worker'], { total: 0, new: 0, byLevel: {}, byCategory: {} });
});

test('every run in the log is read', () => {
  const sarif = { runs: [{ results: [res('src/Worker/A.cs')] }, { results: [res('src/Worker/B.cs')] }] };
  assert.equal(M.mapFindings({ sarif, elements: ELEMENTS, config: CONFIG }).elements['pricing-api'].total, 2);
});

test('a parent cycle in a bad model terminates and counts each element once', () => {
  const els = [{ id: 'a', parent: 'b', paths: ['x/**'] }, { id: 'b', parent: 'a', paths: [] }];
  const r = M.mapFindings({ sarif: log(res('x/f.cs')), elements: els, config: CONFIG });
  assert.equal(r.elements.a.total, 1);
  assert.equal(r.elements.b.total, 1);
});

test('a parent that is not an element stops the roll-up there', () => {
  const els = [{ id: 'a', parent: 'ghost', paths: ['x/**'] }];
  assert.equal(M.mapFindings({ sarif: log(res('x/f.cs')), elements: els, config: CONFIG }).elements.a.total, 1);
});

test('new: absent from the baseline means new; no baseline means nothing is new', () => {
  const first = run([res('src/Worker/W.cs', { message: { text: 'one' } }), res('src/Worker/W.cs', { message: { text: 'two' } })]);
  assert.equal(first.elements['pricing-api'].new, 0);
  const base = [first.mapped[0].fingerprint];
  const later = run([res('src/Worker/W.cs', { message: { text: 'one' } }), res('src/Worker/W.cs', { message: { text: 'two' } })], { baseline: base });
  assert.equal(later.elements['pricing-api.worker'].new, 1);
  assert.equal(later.elements['pricing-api'].new, 1); // new rolls up too
  assert.deepEqual(later.mapped.map(m => m.new), [false, true]);
});

test('the fingerprint ignores the line number, so moved code is not reported twice', () => {
  const at = line => res('src/Worker/W.cs', { locations: [{ physicalLocation: { artifactLocation: { uri: 'src/Worker/W.cs' }, region: { startLine: line, snippet: { text: 'if (x) { y(); }' } } } }] });
  const a = run([at(10)]).mapped[0].fingerprint, b = run([at(250)]).mapped[0].fingerprint;
  assert.equal(a, b);
  assert.equal(run([at(250)], { baseline: [a] }).elements['pricing-api'].new, 0);
});

test('the fingerprint changes when the surrounding code or the rule or the file changes', () => {
  const f = (uri, ruleId, code) => M.fingerprint(res(uri, { ruleId }), uri, code);
  const base = f('src/A.cs', 'S1', 'foo();');
  assert.notEqual(base, f('src/A.cs', 'S1', 'bar();'));
  assert.notEqual(base, f('src/A.cs', 'S2', 'foo();'));
  assert.notEqual(base, f('src/B.cs', 'S1', 'foo();'));
  assert.equal(base, f('src/A.cs', 'S1', '  foo();\n'), 'whitespace is not a change');
});

test('partialFingerprints from the tool are used when it supplies them', () => {
  const a = res('src/A.cs', { partialFingerprints: { primaryLocationLineHash: 'abc:1' } });
  const b = res('src/A.cs', { partialFingerprints: { primaryLocationLineHash: 'abc:1' }, message: { text: 'different text' } });
  assert.equal(M.fingerprint(a, 'src/A.cs'), M.fingerprint(b, 'src/A.cs'));
});

test('readContext, when given, is what the fingerprint hashes', () => {
  const calls = [];
  const r = run([res('src/Worker/W.cs')], { readContext: (p, l) => { calls.push([p, l]); return 'ctx'; } });
  assert.deepEqual(calls, [['src/Worker/W.cs', 10]]);
  assert.equal(r.mapped[0].fingerprint, M.fingerprint(res('src/Worker/W.cs'), 'src/Worker/W.cs', 'ctx'));
});

test('input is not mutated', () => {
  const sarif = log(res('src/Worker/W.cs'));
  const before = JSON.stringify([sarif, ELEMENTS, CONFIG]);
  M.mapFindings({ sarif, elements: ELEMENTS, config: CONFIG });
  assert.equal(JSON.stringify([sarif, ELEMENTS, CONFIG]), before);
});
