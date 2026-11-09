const { test } = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const Domain = require('../renderer/domain.js');

const FARES = `id: fares
version: 3
aggregates:
  Booking:
    id: BookingId
    fields:
      partner: { ref: Partner }
      limit: money
      attachment: money
      rate_on_line: { type: percent, min: 0, max: 100 }
      status: { oneOf: [draft, quoted, bound] }
      fee: Money
    invariants:
      - "attachment < limit"
    publishes: [BookingBound]
  Partner:
    id: PartnerId
    fields: { name: { type: string, maxLength: 200 } }
values:
  Money: { amount: decimal, currency: { type: string, pattern: "^[A-Z]{3}$" } }
events:
  BookingBound: { booking: { ref: Booking }, fee: Money }
refs:
  Claim: claims/Claim
`;
const read = (text, key = 'fares') => Domain.read(text, yaml.load, key);
const problems = text => read(text).problems;
const edit = (from, to) => FARES.replace(from, to);

test('read: a pack gives its aggregates, values, events and refs with no problems', () => {
  const r = read(FARES);
  assert.deepEqual(r.problems, []);
  assert.equal(r.pack.id, 'fares');
  assert.deepEqual(r.pack.aggregates.map(a => [a.name, a.id, a.fields.length, a.invariants, a.publishes]),
    [['Booking', 'BookingId', 6, ['attachment < limit'], ['BookingBound']], ['Partner', 'PartnerId', 1, [], []]]);
  assert.deepEqual(r.pack.values.map(v => v.name), ['Money']);
  assert.deepEqual(r.pack.events.map(e => [e.name, e.fields.map(f => f.name)]), [['BookingBound', ['booking', 'fee']]]);
  assert.deepEqual(r.pack.refs, { Claim: 'claims/Claim' });
});

test('read: a file that is not YAML or not a mapping is an error, not problems', () => {
  assert.match(read('id: [unclosed').error, /does not parse/);
  assert.match(read('- a\n- b\n').error, /mapping/);
});

test('read: the id must be given and match the file name', () => {
  assert.match(problems(FARES.replace('id: fares\n', '')).join('\n'), /needs an id/);
  assert.match(read(FARES, 'claims').problems.join('\n'), /id fares does not match the file name claims/);
});

test('DDD: an aggregate needs identity', () => {
  assert.match(problems(edit('    id: PartnerId\n', '')).join('\n'), /aggregate Partner needs an id/);
});

test('DDD: another aggregate is held by id only, never embedded', () => {
  assert.match(problems(edit('partner: { ref: Partner }', 'partner: Partner')).join('\n'), /Booking\.partner holds the aggregate Partner: reference it by id with \{ ref: Partner \}/);
  assert.match(problems(edit('partner: { ref: Partner }', 'partner: Claim')).join('\n'), /Booking\.partner holds the aggregate Claim/);
  assert.match(problems(edit('booking: { ref: Booking }', 'booking: Booking')).join('\n'), /BookingBound\.booking holds the aggregate Booking/);
});

test('DDD: a value object is embedded, never referenced', () => {
  assert.match(problems(edit('fee: Money\n    invariants', 'fee: { ref: Money }\n    invariants')).join('\n'), /Booking\.fee references the value object Money: value objects are embedded, so use fee: Money/);
});

test('read: unknown types, refs, events and malformed refs are named', () => {
  assert.match(problems(edit('limit: money', 'limit: monee')).join('\n'), /Booking\.limit has unknown type monee/);
  assert.match(problems(edit('partner: { ref: Partner }', 'partner: { ref: Reseller }')).join('\n'), /Booking\.partner refers to Reseller, which is not an aggregate here or in refs/);
  assert.match(problems(edit('publishes: [BookingBound]', 'publishes: [BookingSent]')).join('\n'), /Booking publishes BookingSent, which is not in events/);
  assert.match(problems(edit('Claim: claims/Claim', 'Claim: Claim')).join('\n'), /refs\.Claim must be <pack>\/<Aggregate>/);
  assert.match(problems(edit('values:\n  Money:', 'values:\n  Booking:')).join('\n'), /Booking is declared twice/);
  assert.match(problems(edit('      - "attachment < limit"', '      - 3')).join('\n'), /invariants of Booking must be text/);
});

test('qualify: an owns entry names an aggregate as pack/Name, or a bare name defined by exactly one pack', () => {
  const packs = [read(FARES).pack, read(FARES.replace('id: fares', 'id: other'), 'other').pack];
  assert.deepEqual(Domain.qualify('fares/Booking', packs), { id: 'fares/Booking' });
  assert.deepEqual(Domain.qualify('Booking', [packs[0]]), { id: 'fares/Booking' });
  assert.match(Domain.qualify('Booking', packs).error, /defined by fares and other: write fares\/Booking/);
  assert.match(Domain.qualify('Bookign', [packs[0]]).error, /no pinned pack defines Bookign.*did you mean fares\/Booking/);
  assert.match(Domain.qualify('fares/Money', [packs[0]]).error, /fares defines no aggregate Money/);
});

test('pEvents: P event payloads as field names, through a named tuple type or inline; other payloads have none', () => {
  const p = `type tBound = (booking: int, fee: float);
event eBookingBound: tBound;
event eInline : (booking: int, fee: float);
event eCommitted: int;
event eRead: machine;
event ePing;
`;
  const ev = Domain.pEvents([{ path: 'behaviour/a.p', text: p }]);
  assert.deepEqual(ev.get('eBookingBound').fields, ['booking', 'fee']);
  assert.deepEqual(ev.get('eInline').fields, ['booking', 'fee']);
  assert.equal(ev.get('eCommitted').fields, null);
  assert.equal(ev.get('ePing').fields, null);
  assert.equal(ev.get('eBookingBound').path, 'behaviour/a.p');
  assert.equal(ev.get('eBookingBound').line, 2);
  assert.equal(Domain.announced([{ path: 'b.p', text: 'announce eBookingBound, x;' }]).has('eBookingBound'), true);
});

const pack = { key: 'fares', path: 'domain/fares.yaml', text: FARES };
const hash = t => 'h:' + t.length;
const pin = (h, ts = 1) => ({ kind: 'domain_pinned', pack: 'fares', registry: 'fares', hash: h, _ts: ts });
const owner = (id, owns, name = id) => ({ id, name, owns });
const clauses = (o = {}) => Domain.clauses({ packs: [pack], listed: ['fares'], ledger: [pin(hash(FARES))], sources: {}, owners: [], behaviour: [], isAncestor: () => false, hash, ...o });
const texts = r => r.clauses.map(c => c.text);

test('clauses: a pinned, unedited pack with owners that resolve says nothing', () => {
  const r = clauses({ owners: [owner('api', ['fares/Booking']), owner('crm', ['Partner'])], sources: { fares: FARES } });
  assert.deepEqual(texts(r), []);
  assert.deepEqual(r.notes, []);
});

test('clauses: no packs listed and none copied: domain rules do not run, so d.owns stays free text', () => {
  assert.deepEqual(clauses({ packs: [], listed: [], ledger: [], owners: [owner('api', ['Bookings table'])] }), { clauses: [], notes: [] });
});

test('clauses: listed but not copied, copied but never pinned, and edited after the pin all block', () => {
  assert.deepEqual(texts(clauses({ packs: [], ledger: [] })), ['fares is listed in designc.json domains but not pinned: pin it from the fares registry']);
  assert.deepEqual(texts(clauses({ ledger: [] })), ['domain/fares.yaml is not pinned: pin it from the fares registry']);
  assert.deepEqual(texts(clauses({ ledger: [pin('old', 1), pin('other', 2)] })), ['domain/fares.yaml was edited after it was pinned: restore it, or re-pin from the fares registry']);
  assert.deepEqual(texts(clauses({ ledger: [pin('old', 1), pin(hash(FARES), 2)] })), []);
  assert.equal(clauses({ ledger: [] }).clauses[0].kind, 'domain');
  assert.equal(clauses({ ledger: [] }).clauses[0].pack, 'fares');
});

test('clauses: a newer pack in its registry blocks until re-pinned; an unreadable registry is an unknown note, never a clause', () => {
  assert.deepEqual(texts(clauses({ sources: { fares: FARES + '# v4\n' } })), ['fares changed in its registry since it was pinned: re-pin to take it']);
  const r = clauses({ sources: { fares: null } });
  assert.deepEqual(texts(r), []);
  assert.deepEqual(r.notes, ['fares: its registry could not be read, so whether a newer pack exists is unknown']);
});

test('clauses: a pack with problems blocks, one clause per problem', () => {
  const bad = FARES.replace('    id: PartnerId\n', '');
  const r = clauses({ packs: [{ ...pack, text: bad }], ledger: [pin(hash(bad))] });
  assert.deepEqual(texts(r), ['domain/fares.yaml: aggregate Partner needs an id: aggregates have identity']);
});

test('clauses: d.owns must name a pinned aggregate, with a did-you-mean; the clause is about the element', () => {
  const r = clauses({ owners: [owner('api', ['Bookign'], 'Bookings API')] });
  assert.deepEqual(texts(r), ['Bookings API owns "Bookign", but no pinned pack defines Bookign (did you mean fares/Booking?)']);
  assert.deepEqual(r.clauses[0].about, ['Bookings API']);
});

test('clauses: two elements own one aggregate, unless one is inside the other', () => {
  const owners = [owner('a', ['Booking'], 'Bookings API'), owner('b', ['fares/Booking'], 'Escalation Worker')];
  const r = clauses({ owners });
  assert.deepEqual(texts(r), ['fares/Booking is owned by Bookings API and Escalation Worker: an aggregate has one owner']);
  assert.deepEqual(r.clauses[0].about, ['Bookings API', 'Escalation Worker']);
  assert.deepEqual(texts(clauses({ owners, isAncestor: (x, y) => x === 'a' && y === 'b' })), []);
});

test('clauses: a P event named after a pack event must carry its payload fields', () => {
  const ok = { path: 'behaviour/q.p', text: 'event eBookingBound: (booking: int, fee: float);' };
  assert.deepEqual(texts(clauses({ behaviour: [ok] })), []);
  const bad = { path: 'behaviour/q.p', text: 'event eBookingBound: (booking: int);\nevent eOther: int;' };
  assert.deepEqual(texts(clauses({ behaviour: [bad] })), ['behaviour/q.p: eBookingBound carries booking, but fares event BookingBound carries booking, fee']);
  const plain = { path: 'behaviour/q.p', text: 'event eBookingBound: int;' };
  assert.deepEqual(texts(clauses({ behaviour: [plain] })), ['behaviour/q.p: eBookingBound carries int, but fares event BookingBound carries booking, fee']);
});

test('owned and guides: what each owner owns, touched first, with the events no P model announces and the invariants no decision checks', () => {
  const owners = [owner('crm', ['Partner'], 'CRM'), owner('api', ['Booking'], 'Bookings API')];
  const g = Domain.guides({ packs: [pack], owners, behaviour: [], decisions: [], focus: ['Bookings API'] });
  assert.deepEqual(g.owned.map(o => [o.aggregate, o.owner, o.touched]), [['fares/Booking', 'Bookings API', true], ['fares/Partner', 'CRM', false]]);
  assert.deepEqual(g.guides.map(x => [x.kind, x.aggregate, x.event || x.invariant]), [['event', 'fares/Booking', 'BookingBound'], ['invariant', 'fares/Booking', 'attachment < limit']]);
  const done = Domain.guides({ packs: [pack], owners, behaviour: [{ path: 'b.p', text: 'announce eBookingBound, q;' }],
    decisions: [{ id: 'x', status: 'minted', statement: Domain.invariantStatement('fares/Booking', 'attachment < limit') }], focus: [] });
  assert.deepEqual(done.guides, []);
  assert.equal(Domain.invariantStatement('fares/Booking', 'attachment < limit'), 'fares/Booking holds: attachment < limit');
  const superseded = Domain.guides({ packs: [pack], owners, behaviour: [], decisions: [{ id: 'x', status: 'superseded', statement: 'fares/Booking holds: attachment < limit' }], focus: [] });
  assert.equal(superseded.guides.filter(x => x.kind === 'invariant').length, 1);
});

test('pins: the latest domain_pinned per pack wins', () => {
  const p = Domain.pins([pin('a', 1), { ...pin('b', 3), registry: 'fares-2' }, pin('c', 2)]);
  assert.deepEqual(p.get('fares'), { hash: 'b', registry: 'fares-2' });
});
