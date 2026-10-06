const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('../extract/code-fs.js');

const one = (src, file = 'Pricing.fs') => fs.scan(file, src).types;
const method = (src, name) => one(src).flatMap(t => t.methods).find(m => m.name === name);

test('modules, records, unions, classes and interfaces with their lines', () => {
  const src = [
    'module Pricing.Rates',                 // 1  file-level module header
    '',
    'type Quote = { Id: int; Premium: decimal }',   // 3 record
    'type Status =',                        // 4 union
    '    | Open',
    '    | Closed',
    'type IRepo =',                         // 7 interface
    '    abstract Find: int -> Quote',
    'type Engine(repo: IRepo) =',           // 9 class
    '    member _.Run() = 1',
    'module Helpers =',                     // 11 nested module
    '    let double x = x * 2',
  ].join('\n');
  assert.deepEqual(one(src).map(t => [t.name, t.kind, t.line, t.endLine]), [
    ['Rates', 'module', 1, 1], ['Quote', 'record', 3, 3], ['Status', 'union', 4, 6], ['IRepo', 'interface', 7, 8],
    ['Engine', 'class', 9, 10], ['Helpers', 'module', 11, 12],
  ]);
});

test('let functions with parameters are methods, plain values are not', () => {
  const src = 'module M\nlet rate = 5\nlet price (q: int) (m: int) =\n    q * m\nlet inline private tax x = x + 1\nlet run () = ()\n';
  const [t] = one(src);
  assert.deepEqual(t.methods.map(m => [m.name, m.line, m.endLine, m.lines]), [['price', 3, 4, 2], ['tax', 5, 5, 1], ['run', 6, 6, 1]]);
});

test('members of a type are its methods, including static ones and constructors', () => {
  const src = 'type Engine(repo: IRepo) =\n    member this.Run(x) =\n        x + 1\n    static member Make() = Engine(null)\n    new () = Engine(null)\n    member _.Name = "e"\n';
  const t = one(src).find(x => x.name === 'Engine');
  assert.deepEqual(t.methods.map(m => m.name), ['Run', 'Make', 'new']);
});

test('a file with no module header and loose lets gets a module named after the file', () => {
  const [t] = one('let add a b = a + b\n', 'src/MathUtil.fs');
  assert.deepEqual([t.name, t.kind, t.methods.map(m => m.name)], ['MathUtil', 'module', ['add']]);
});

test('cyclomatic complexity: ifs, loops, guards, boolean operators and match arms, not the wildcard', () => {
  const f = b => method('module M\nlet f x =\n' + b.split('\n').map(l => '    ' + l).join('\n') + '\n', 'f').cc;
  assert.equal(f('x + 1'), 1);
  assert.equal(f('if x > 1 then 1 elif x > 2 then 2 else 3'), 3);
  assert.equal(f('for i in 1..x do printfn "a"\nwhile x > 0 do ()'), 3);
  assert.equal(f('match x with\n| 1 -> "a"\n| n when n > 5 -> "b"\n| _ -> "c"'), 4);
  assert.equal(f('x > 1 && x < 5 || x = 9'), 3);
  assert.equal(f('x |> List.map id |> ignore'), 1);
  assert.equal(f('[| 1; 2 |] |> ignore'), 1);
});

test('keywords in strings and comments do not count', () => {
  assert.equal(method('module M\nlet f x =\n    // if x then while\n    (* for *) "if && || match" |> ignore\n', 'f').cc, 1);
});

test('references: inherit and interface are inherits, constructors are new, qualified names are uses of type and module', () => {
  const src = 'type Engine(repo: IRepo) =\n    inherit Base()\n    interface IRun with\n        member _.Go() = 1\n    member _.Make() = Order(1)\n    member _.Calc() = Rates.price 1 2\n';
  const [t] = one(src);
  const refs = t.refs.map(r => [r.name, r.via, !!r.module]);
  assert.ok(refs.some(r => r[0] === 'Base' && r[1] === 'inherits'));
  assert.ok(refs.some(r => r[0] === 'IRun' && r[1] === 'inherits'));
  assert.ok(refs.some(r => r[0] === 'Order' && r[1] === 'new' && !r[2]));
  assert.ok(refs.some(r => r[0] === 'Rates' && r[2] === true));
  assert.ok(refs.some(r => r[0] === 'IRepo'));
  assert.ok(!refs.some(r => r[0] === 'Engine'));
});

test('non-F# files give no types', () => {
  assert.deepEqual(fs.scan('a.cs', 'type X = int').types, []);
});
