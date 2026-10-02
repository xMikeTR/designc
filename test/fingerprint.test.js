const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const dsl = (extra = '', desc = 'the db', tech = 'SQL') => `workspace {
 model {
  api = softwareSystem "Pricing API" {
   db = container "Quotes DB" "${desc}" "${tech}" {
    properties {
     "d.owner" "pricing"${extra}
    }
   }
   svc = container "Quotes Svc"
  }
  svc -> db "writes" "TDS"
 }
}`;
const fp = (text, name = 'Quotes DB') => {
  const m = Core.parse(text);
  const e = [...m.elements.values()].find(x => x.name === name);
  return Core.fingerprint(m, e.id);
};

test('fingerprint: a stable 16-hex hash plus the content it covers', () => {
  const f = fp(dsl());
  assert.match(f.hash, /^[0-9a-f]{16}$/);
  assert.equal(typeof f.content, 'string');
  assert.equal(fp(dsl()).hash, f.hash);
});

test('fingerprint: description, tags, whitespace and rel description do not count', () => {
  const base = fp(dsl()).hash;
  assert.equal(fp(dsl('', 'something else entirely')).hash, base);
  assert.equal(fp(dsl().replace('"writes"', '"stores quotes"')).hash, base);
  assert.equal(fp(dsl().replace(/\n/g, '\n\n')).hash, base);
  assert.equal(fp(dsl().replace('"Quotes Svc"', '"Quotes Svc" "x" "y" "tag1"')).hash, base);
});

test('fingerprint: technology, d.* props (including d.suppress), name and parent count', () => {
  const base = fp(dsl()).hash;
  assert.notEqual(fp(dsl('', 'the db', 'Postgres')).hash, base);
  assert.notEqual(fp(dsl('\n"d.tier" "gold"')).hash, base);
  assert.notEqual(fp(dsl('\n"d.suppress" "DC002"')).hash, base);
  assert.notEqual(fp(dsl().replace('"Quotes DB"', '"Quotes Store"'), 'Quotes Store').hash, base);
  assert.notEqual(fp(dsl().replace('api = softwareSystem "Pricing API"', 'api = softwareSystem "Billing API"')).hash, base);
});

test('fingerprint: every incident rel counts: technology, direction, other end, and its d.* props', () => {
  const base = fp(dsl()).hash;
  assert.notEqual(fp(dsl().replace('"TDS"', '"JDBC"')).hash, base);
  assert.notEqual(fp(dsl().replace('svc -> db', 'db -> svc')).hash, base);
  assert.notEqual(fp(dsl().replace('svc -> db "writes" "TDS"', 'svc -> db "writes" "TDS" {\n properties {\n "d.interaction" "sync"\n }\n }')).hash, base);
  assert.notEqual(fp(dsl().replace('svc -> db "writes" "TDS"', 'svc -> db "writes" "TDS"\n  svc -> db "reads" "TDS"')).hash, base);
});

test('fingerprint: an unrelated element or rel changing does not move it', () => {
  const base = fp(dsl()).hash;
  assert.equal(fp(dsl().replace('svc = container "Quotes Svc"', 'svc = container "Quotes Svc" "d" "Go"')).hash, base);
});

test('gate: bound decision needs promoted_against, and each entry must resolve and still match', () => {
  const text = dsl();
  const model = Core.parse(text);
  const h = fp(text).hash;
  const dec = o => ({ id: 'd1', status: 'bound', effect: 'accept', checks: ['x'], binds: ['Quotes DB'], resolves: [], ...o });
  const ledger = [{ kind: 'check', decision: 'd1', outcome: 'pass', _ts: 1 }];
  const g = d => Core.gate({ model, diags: [], decisions: [d], requirements: [], ledger }).clauses.filter(c => /fingerprint|resolve|changed since/.test(c.text));
  assert.equal(g(dec({ promoted_against: [{ element: 'db', name: 'Quotes DB', hash: h }] })).length, 0);
  assert.match(g(dec())[0].text, /d1 is bound without a fingerprint/);
  assert.match(g(dec({ promoted_against: [{ element: 'db', name: 'Quotes DB', hash: 'deadbeefdeadbeef' }] }))[0].text, /d1: Quotes DB changed since promotion/);
  assert.match(g(dec({ promoted_against: [{ element: 'gone', name: 'Nope', hash: h }] }))[0].text, /d1: binding Nope does not resolve/);
  // resolves by identifier first, then by name (identifier renamed away)
  assert.equal(g(dec({ promoted_against: [{ element: 'old', name: 'Quotes DB', hash: h }] })).length, 0);
});

const Ledger = require('../renderer/ledger.js');
test('ledger: decision_promoted is a designc kind with decision required', () => {
  assert.equal(Ledger.KINDS.decision_promoted.stream, 'designc.jsonl');
  const ok = { schema_version: 1, event_id: 'e1', ts: 1, kind: 'decision_promoted', by: 'mike', decision: 'd1', fingerprints: [{ element: 'db', name: 'Quotes DB', hash: 'abc' }] };
  assert.deepEqual(Ledger.validate(ok), []);
  assert.ok(Ledger.validate({ ...ok, decision: undefined }).length > 0);
});

const yaml = require('js-yaml');
const Policy = require('../renderer/policy.js');
test('policy: agents may not write promoted_against, promoted_by or promoted_at', () => {
  for (const f of ['promoted_against: []', 'promoted_by: mike', 'promoted_at: 2026-10-02'])
    assert.match(Policy.writeVerdict('architect', 'decisions/a.yaml', `id: a\nstatus: minted\n${f}\n`, yaml.load).error || '', /human/, f);
  assert.deepEqual(Policy.writeVerdict('architect', 'decisions/a.yaml', 'id: a\nstatus: minted\n', yaml.load), { ok: true });
});
