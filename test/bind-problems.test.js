'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Core = require('../renderer/core.js');

// A four-hop chain across containers gives one DC003 on A.
const m = Core.parse(`workspace {
  model {
    s = softwareSystem "S" {
      a = container "A"
      b = container "B"
      c = container "C"
      d = container "D"
      e = container "E"
      a -> b "calls"
      b -> c "calls"
      c -> d "calls"
      d -> e "calls"
    }
  }
}
`);
const diags = Core.check(m, { chainHops: 4 });
const f = diags.find(d => d.code === 'DC003');
const dec = x => ({ id: 'x', kind: 'technical', effect: 'accept', ...x });

test('an accept decision that answers the finding binds with no problem', () => {
  assert.deepEqual(Core.bindProblems(dec({ resolves: ['DC003'], binds: f.loc.names }), m, diags), []);
});

test('edge strings in binds and an empty resolves are named before binding', () => {
  const probs = Core.bindProblems(dec({ resolves: [], binds: ['A -> B'] }), m, diags);
  assert.deepEqual(probs, ['binds "A -> B", which is not an element name in the model', 'resolves lists no finding code, so it answers no finding']);
});

test('a code with no finding on the bound elements is named', () => {
  const probs = Core.bindProblems(dec({ resolves: ['DC002'], binds: ['A'] }), m, diags);
  assert.deepEqual(probs, ['no current DC002 finding is on A']);
});

test('fix decisions are judged on their names only, business decisions not at all', () => {
  assert.deepEqual(Core.bindProblems(dec({ effect: 'fix', resolves: [], binds: ['Nope'] }), m, diags), ['binds "Nope", which is not an element name in the model']);
  assert.deepEqual(Core.bindProblems(dec({ kind: 'business', resolves: [], binds: ['Nope'] }), m, diags), []);
});
