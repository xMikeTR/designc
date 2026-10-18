const { test } = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const Domain = require('../renderer/domain.js');

const PRICING = `id: pricing
version: 3
aggregates:
  Quote:
    id: QuoteId
    fields:
      cedant: { ref: Cedant }
      limit: money
      attachment: money
      rate_on_line: { type: percent, min: 0, max: 100 }
      status: { oneOf: [draft, quoted, bound] }
      premium: Money
    invariants:
      - "attachment < limit"
    publishes: [QuoteBound]
  Cedant:
    id: CedantId
    fields: { name: { type: string, maxLength: 200 } }
values:
  Money: { amount: decimal, currency: { type: string, pattern: "^[A-Z]{3}$" } }
events:
  QuoteBound: { quote: { ref: Quote }, premium: Money }
refs:
  Claim: claims/Claim
`;
const read = (text, key = 'pricing') => Domain.read(text, yaml.load, key);
const problems = text => read(text).problems;
const edit = (from, to) => PRICING.replace(from, to);

test('read: a pack gives its aggregates, values, events and refs with no problems', () => {
  const r = read(PRICING);
  assert.deepEqual(r.problems, []);
  assert.equal(r.pack.id, 'pricing');
  assert.deepEqual(r.pack.aggregates.map(a => [a.name, a.id, a.fields.length, a.invariants, a.publishes]),
    [['Quote', 'QuoteId', 6, ['attachment < limit'], ['QuoteBound']], ['Cedant', 'CedantId', 1, [], []]]);
  assert.deepEqual(r.pack.values.map(v => v.name), ['Money']);
  assert.deepEqual(r.pack.events.map(e => [e.name, e.fields.map(f => f.name)]), [['QuoteBound', ['quote', 'premium']]]);
  assert.deepEqual(r.pack.refs, { Claim: 'claims/Claim' });
});

test('read: a file that is not YAML or not a mapping is an error, not problems', () => {
  assert.match(read('id: [unclosed').error, /does not parse/);
  assert.match(read('- a\n- b\n').error, /mapping/);
});

test('read: the id must be given and match the file name', () => {
  assert.match(problems(PRICING.replace('id: pricing\n', '')).join('\n'), /needs an id/);
  assert.match(read(PRICING, 'claims').problems.join('\n'), /id pricing does not match the file name claims/);
});

test('DDD: an aggregate needs identity', () => {
  assert.match(problems(edit('    id: CedantId\n', '')).join('\n'), /aggregate Cedant needs an id/);
});

test('DDD: another aggregate is held by id only, never embedded', () => {
  assert.match(problems(edit('cedant: { ref: Cedant }', 'cedant: Cedant')).join('\n'), /Quote\.cedant holds the aggregate Cedant: reference it by id with \{ ref: Cedant \}/);
  assert.match(problems(edit('cedant: { ref: Cedant }', 'cedant: Claim')).join('\n'), /Quote\.cedant holds the aggregate Claim/);
  assert.match(problems(edit('quote: { ref: Quote }', 'quote: Quote')).join('\n'), /QuoteBound\.quote holds the aggregate Quote/);
});

test('DDD: a value object is embedded, never referenced', () => {
  assert.match(problems(edit('premium: Money\n    invariants', 'premium: { ref: Money }\n    invariants')).join('\n'), /Quote\.premium references the value object Money: value objects are embedded, so use premium: Money/);
});

test('read: unknown types, refs, events and malformed refs are named', () => {
  assert.match(problems(edit('limit: money', 'limit: monee')).join('\n'), /Quote\.limit has unknown type monee/);
  assert.match(problems(edit('cedant: { ref: Cedant }', 'cedant: { ref: Broker }')).join('\n'), /Quote\.cedant refers to Broker, which is not an aggregate here or in refs/);
  assert.match(problems(edit('publishes: [QuoteBound]', 'publishes: [QuoteSent]')).join('\n'), /Quote publishes QuoteSent, which is not in events/);
  assert.match(problems(edit('Claim: claims/Claim', 'Claim: Claim')).join('\n'), /refs\.Claim must be <pack>\/<Aggregate>/);
  assert.match(problems(edit('values:\n  Money:', 'values:\n  Quote:')).join('\n'), /Quote is declared twice/);
  assert.match(problems(edit('      - "attachment < limit"', '      - 3')).join('\n'), /invariants of Quote must be text/);
});

test('qualify: an owns entry names an aggregate as pack/Name, or a bare name defined by exactly one pack', () => {
  const packs = [read(PRICING).pack, read(PRICING.replace('id: pricing', 'id: other'), 'other').pack];
  assert.deepEqual(Domain.qualify('pricing/Quote', packs), { id: 'pricing/Quote' });
  assert.deepEqual(Domain.qualify('Quote', [packs[0]]), { id: 'pricing/Quote' });
  assert.match(Domain.qualify('Quote', packs).error, /defined by pricing and other: write pricing\/Quote/);
  assert.match(Domain.qualify('Qoute', [packs[0]]).error, /no pinned pack defines Qoute.*did you mean pricing\/Quote/);
  assert.match(Domain.qualify('pricing/Money', [packs[0]]).error, /pricing defines no aggregate Money/);
});

test('pEvents: P event payloads as field names, through a named tuple type or inline; other payloads have none', () => {
  const p = `type tBound = (quote: int, premium: float);
event eQuoteBound: tBound;
event eInline : (quote: int, premium: float);
event eCommitted: int;
event eRead: machine;
event ePing;
`;
  const ev = Domain.pEvents([{ path: 'behaviour/a.p', text: p }]);
  assert.deepEqual(ev.get('eQuoteBound').fields, ['quote', 'premium']);
  assert.deepEqual(ev.get('eInline').fields, ['quote', 'premium']);
  assert.equal(ev.get('eCommitted').fields, null);
  assert.equal(ev.get('ePing').fields, null);
  assert.equal(ev.get('eQuoteBound').path, 'behaviour/a.p');
  assert.equal(ev.get('eQuoteBound').line, 2);
  assert.equal(Domain.announced([{ path: 'b.p', text: 'announce eQuoteBound, x;' }]).has('eQuoteBound'), true);
});

const pack = { key: 'pricing', path: 'domain/pricing.yaml', text: PRICING };
const hash = t => 'h:' + t.length;
const pin = (h, ts = 1) => ({ kind: 'domain_pinned', pack: 'pricing', registry: 'pricing', hash: h, _ts: ts });
const owner = (id, owns, name = id) => ({ id, name, owns });
const clauses = (o = {}) => Domain.clauses({ packs: [pack], listed: ['pricing'], ledger: [pin(hash(PRICING))], sources: {}, owners: [], behaviour: [], isAncestor: () => false, hash, ...o });
const texts = r => r.clauses.map(c => c.text);

test('clauses: a pinned, unedited pack with owners that resolve says nothing', () => {
  const r = clauses({ owners: [owner('api', ['pricing/Quote']), owner('crm', ['Cedant'])], sources: { pricing: PRICING } });
  assert.deepEqual(texts(r), []);
  assert.deepEqual(r.notes, []);
});

test('clauses: no packs listed and none copied: domain rules do not run, so d.owns stays free text', () => {
  assert.deepEqual(clauses({ packs: [], listed: [], ledger: [], owners: [owner('api', ['Quotes table'])] }), { clauses: [], notes: [] });
});

test('clauses: listed but not copied, copied but never pinned, and edited after the pin all block', () => {
  assert.deepEqual(texts(clauses({ packs: [], ledger: [] })), ['pricing is listed in designc.json domains but not pinned: pin it from the pricing registry']);
  assert.deepEqual(texts(clauses({ ledger: [] })), ['domain/pricing.yaml is not pinned: pin it from the pricing registry']);
  assert.deepEqual(texts(clauses({ ledger: [pin('old', 1), pin('other', 2)] })), ['domain/pricing.yaml was edited after it was pinned: restore it, or re-pin from the pricing registry']);
  assert.deepEqual(texts(clauses({ ledger: [pin('old', 1), pin(hash(PRICING), 2)] })), []);
  assert.equal(clauses({ ledger: [] }).clauses[0].kind, 'domain');
  assert.equal(clauses({ ledger: [] }).clauses[0].pack, 'pricing');
});

test('clauses: a newer pack in its registry blocks until re-pinned; an unreadable registry is an unknown note, never a clause', () => {
  assert.deepEqual(texts(clauses({ sources: { pricing: PRICING + '# v4\n' } })), ['pricing changed in its registry since it was pinned: re-pin to take it']);
  const r = clauses({ sources: { pricing: null } });
  assert.deepEqual(texts(r), []);
  assert.deepEqual(r.notes, ['pricing: its registry could not be read, so whether a newer pack exists is unknown']);
});

test('clauses: a pack with problems blocks, one clause per problem', () => {
  const bad = PRICING.replace('    id: CedantId\n', '');
  const r = clauses({ packs: [{ ...pack, text: bad }], ledger: [pin(hash(bad))] });
  assert.deepEqual(texts(r), ['domain/pricing.yaml: aggregate Cedant needs an id: aggregates have identity']);
});

test('clauses: d.owns must name a pinned aggregate, with a did-you-mean; the clause is about the element', () => {
  const r = clauses({ owners: [owner('api', ['Qoute'], 'Quotes API')] });
  assert.deepEqual(texts(r), ['Quotes API owns "Qoute", but no pinned pack defines Qoute (did you mean pricing/Quote?)']);
  assert.deepEqual(r.clauses[0].about, ['Quotes API']);
});

test('clauses: two elements own one aggregate, unless one is inside the other', () => {
  const owners = [owner('a', ['Quote'], 'Quotes API'), owner('b', ['pricing/Quote'], 'Referral Worker')];
  const r = clauses({ owners });
  assert.deepEqual(texts(r), ['pricing/Quote is owned by Quotes API and Referral Worker: an aggregate has one owner']);
  assert.deepEqual(r.clauses[0].about, ['Quotes API', 'Referral Worker']);
  assert.deepEqual(texts(clauses({ owners, isAncestor: (x, y) => x === 'a' && y === 'b' })), []);
});

test('clauses: a P event named after a pack event must carry its payload fields', () => {
  const ok = { path: 'behaviour/q.p', text: 'event eQuoteBound: (quote: int, premium: float);' };
  assert.deepEqual(texts(clauses({ behaviour: [ok] })), []);
  const bad = { path: 'behaviour/q.p', text: 'event eQuoteBound: (quote: int);\nevent eOther: int;' };
  assert.deepEqual(texts(clauses({ behaviour: [bad] })), ['behaviour/q.p: eQuoteBound carries quote, but pricing event QuoteBound carries quote, premium']);
  const plain = { path: 'behaviour/q.p', text: 'event eQuoteBound: int;' };
  assert.deepEqual(texts(clauses({ behaviour: [plain] })), ['behaviour/q.p: eQuoteBound carries int, but pricing event QuoteBound carries quote, premium']);
});

test('owned and guides: what each owner owns, touched first, with the events no P model announces and the invariants no decision checks', () => {
  const owners = [owner('crm', ['Cedant'], 'CRM'), owner('api', ['Quote'], 'Quotes API')];
  const g = Domain.guides({ packs: [pack], owners, behaviour: [], decisions: [], focus: ['Quotes API'] });
  assert.deepEqual(g.owned.map(o => [o.aggregate, o.owner, o.touched]), [['pricing/Quote', 'Quotes API', true], ['pricing/Cedant', 'CRM', false]]);
  assert.deepEqual(g.guides.map(x => [x.kind, x.aggregate, x.event || x.invariant]), [['event', 'pricing/Quote', 'QuoteBound'], ['invariant', 'pricing/Quote', 'attachment < limit']]);
  const done = Domain.guides({ packs: [pack], owners, behaviour: [{ path: 'b.p', text: 'announce eQuoteBound, q;' }],
    decisions: [{ id: 'x', status: 'minted', statement: Domain.invariantStatement('pricing/Quote', 'attachment < limit') }], focus: [] });
  assert.deepEqual(done.guides, []);
  assert.equal(Domain.invariantStatement('pricing/Quote', 'attachment < limit'), 'pricing/Quote holds: attachment < limit');
  const superseded = Domain.guides({ packs: [pack], owners, behaviour: [], decisions: [{ id: 'x', status: 'superseded', statement: 'pricing/Quote holds: attachment < limit' }], focus: [] });
  assert.equal(superseded.guides.filter(x => x.kind === 'invariant').length, 1);
});

test('pins: the latest domain_pinned per pack wins', () => {
  const p = Domain.pins([pin('a', 1), { ...pin('b', 3), registry: 'pricing-2' }, pin('c', 2)]);
  assert.deepEqual(p.get('pricing'), { hash: 'b', registry: 'pricing-2' });
});
