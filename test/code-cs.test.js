const { test } = require('node:test');
const assert = require('node:assert/strict');
const cs = require('../extract/code-cs.js');

const one = (src) => cs.scan('Svc.cs', src).types;
const method = (src, name) => one(src).flatMap(t => t.methods).find(m => m.name === name);

test('finds classes, records, structs, interfaces and enums with their lines', () => {
  const src = [
    'namespace Shop;',
    'public class Orders',
    '{',
    '}',
    'public record Quote(int Id);',
    'public readonly record struct Money(decimal Amount);',
    'internal struct Point { }',
    'public interface IRepo { void Save(); }',
    'public enum Status { Open, Closed }',
  ].join('\n');
  const t = one(src).map(x => [x.name, x.kind, x.line, x.endLine]);
  assert.deepEqual(t, [
    ['Orders', 'class', 2, 4],
    ['Quote', 'record', 5, 5],
    ['Money', 'record', 6, 6],
    ['Point', 'struct', 7, 7],
    ['IRepo', 'interface', 8, 8],
    ['Status', 'enum', 9, 9],
  ]);
});

test('a generic constraint "class" is not a type', () => {
  const src = 'public class Box<T> where T : class\n{\n  public T Get<U>(U u) where U : class, new() { return default; }\n}';
  assert.deepEqual(one(src).map(x => x.name), ['Box']);
});

test('methods and constructors with block or expression bodies, with lines', () => {
  const src = [
    'public class Orders',                                  // 1
    '{',                                                    // 2
    '  private readonly Func<int, int> f = x => x + 1;',    // 3  field initializer, not a method
    '  public Orders(IRepo repo) : base() { _r = repo; }',  // 4  constructor
    '  [HttpGet("{id}")]',                                  // 5  attribute
    '  public async Task<Order?> Get(int id)',              // 6
    '  {',                                                  // 7
    '    return await _r.Find(id);',                        // 8
    '  }',                                                  // 9
    '  public int Twice(int x) => x * 2;',                  // 10
    '  public abstract void Hook();',                       // 11 no body: not measured
    '  public T Pick<T>(T a) where T : class { return a; }', // 12 generic
    '  public string Name { get; set; }',                   // 13 property
    '}',
  ].join('\n');
  const [t] = one(src);
  assert.deepEqual(t.methods.map(m => [m.name, m.line, m.endLine, m.lines]), [
    ['Orders', 4, 4, 1],
    ['Get', 6, 9, 4],
    ['Twice', 10, 10, 1],
    ['Pick', 12, 12, 1],
  ]);
  assert.ok(t.methods.every(m => m.file === 'Svc.cs'));
});

test('nested types own their own methods', () => {
  const src = 'class Outer {\n  void A() { }\n  class Inner {\n    void B() { }\n  }\n}';
  const ts = one(src);
  assert.deepEqual(ts.map(t => [t.name, t.methods.map(m => m.name)]), [['Outer', ['A']], ['Inner', ['B']]]);
});

test('cyclomatic complexity counts each decision point once', () => {
  const body = (b) => `class C {\n  int M(int a, string s) {\n${b}\n  }\n}`;
  const cc = b => method(body(b), 'M').cc;
  assert.equal(cc('return 1;'), 1);
  assert.equal(cc('if (a > 1) return 1; else if (a > 2) return 2; return 3;'), 3);
  assert.equal(cc('for (var i = 0; i < a; i++) {} foreach (var c in s) {} while (a > 0) a--; do { a++; } while (a < 3);'), 5);
  assert.equal(cc('switch (a) { case 1: return 1; case 2: case 3: return 2; default: return 0; }'), 4);
  assert.equal(cc('try { } catch (IOException e) when (e.HResult > 0) { } catch { }'), 4);
  assert.equal(cc('return a > 1 && a < 5 || a == 9 ? 1 : 0;'), 4);
  assert.equal(cc('var x = s ?? "none"; s ??= "x"; return x.Length;'), 3);
});

test('nullable types, null-conditional access and lambdas are not decisions', () => {
  const src = 'class C {\n  int? M(string? s, int?[] xs) {\n    var n = s?.Length; var y = xs?[0];\n    Func<int, int> f = q => q + 1;\n    return n;\n  }\n}';
  assert.equal(method(src, 'M').cc, 1);
});

test('switch expression arms count, the discard arm does not, and when guards count', () => {
  const src = [
    'class C {',
    '  string M(int a) => a switch',
    '  {',
    '    1 => "one",',
    '    2 => Map(x => x),',
    '    > 10 when a < 20 => "teens",',
    '    _ => "other",',
    '  };',
    '}',
  ].join('\n');
  assert.equal(method(src, 'M').cc, 5); // 1 + three arms + one when
});

test('keywords inside strings and comments do not count', () => {
  const src = 'class C {\n  int M() {\n    // if (x) while (y)\n    var s = "if && || ? case";\n    /* for */ return 1;\n  }\n}';
  assert.equal(method(src, 'M').cc, 1);
});

test('references: base list is inherits, new is new, other capitalised names are uses', () => {
  const src = 'public class Orders : Base, IOrders\n{\n  private readonly Repo _r;\n  public Order Make() { return new Order(); }\n}';
  const [t] = one(src);
  const refs = Object.fromEntries(t.refs.map(r => [r.name, r.via]));
  assert.equal(refs.Base, 'inherits');
  assert.equal(refs.IOrders, 'inherits');
  assert.equal(refs.Order, 'new');
  assert.equal(refs.Repo, 'uses');
  assert.equal(refs.Orders, undefined);
  assert.ok(t.refs.every(r => r.line >= 1));
});
