const { test } = require('node:test');
const assert = require('node:assert/strict');
const js = require('../extract/code-js.js');

const one = (src, file = 'src/orders.ts') => js.scan(file, src).types;
const find = (src, name, file) => one(src, file).flatMap(t => t.methods).find(m => m.name === name);

test('classes, interfaces and enums with their lines; type aliases and generic constraints are not types', () => {
  const src = [
    'export class Orders<T extends Base> {',   // 1
    '}',                                       // 2
    'export interface IRepo { get(id: string): Order; }', // 3
    'export enum Status { Open, Closed }',     // 4
    'export type Id = string;',                // 5
    'export default class Cart {}',            // 6
    'export abstract class Shape {}',          // 7
  ].join('\n');
  assert.deepEqual(one(src).map(t => [t.name, t.kind, t.line, t.endLine]), [
    ['Orders', 'class', 1, 2], ['IRepo', 'interface', 3, 3], ['Status', 'enum', 4, 4], ['Cart', 'class', 6, 6], ['Shape', 'class', 7, 7],
  ]);
});

test('class methods: constructor, async, static, arrow properties, decorators; accessors and abstract signatures are skipped', () => {
  const src = [
    'class Orders {',                                            // 1
    '  private cache = new Map<string, number>();',             // 2 field
    '  constructor(private repo: Repo) { this.repo = repo; }',   // 3
    '  @HostListener("click", ["$event"]) onClick(e: Event) {',  // 4
    '    return e;',                                             // 5
    '  }',                                                       // 6
    '  static async make(id: string): Promise<Order> {',         // 7
    '    return await Repo.find(id);',                           // 8
    '  }',                                                       // 9
    '  handle = (x: number) => {',                               // 10
    '    return x + 1;',                                         // 11
    '  };',                                                      // 12
    '  twice = (x: number) => x * 2;',                           // 13
    '  get size() { return 1; }',                                // 14 accessor
    '  abstract hook(): void;',                                  // 15
    '}',
  ].join('\n');
  const [t] = one(src);
  assert.deepEqual(t.methods.map(m => [m.name, m.line, m.endLine, m.lines]), [
    ['constructor', 3, 3, 1], ['onClick', 4, 6, 3], ['make', 7, 9, 3], ['handle', 10, 12, 3], ['twice', 13, 13, 1],
  ]);
});

test('top-level functions form one module type named after the file; no functions, no module', () => {
  const src = [
    'import { Order } from "./order";',                  // 1
    'export function total(o: Order) {',                 // 2
    '  return o.lines.length;',                          // 3
    '}',                                                 // 4
    'export const price = async (q: number) => {',       // 5
    '  return q * 2;',                                   // 6
    '};',                                                // 7
    'const half = (x) => x / 2;',                        // 8
    'const config = { a: 1 };',                          // 9 not a function
    'if (process.env.X) { run(); }',                     // 10 not a function
    'module.exports = { total };',                       // 11
  ].join('\n');
  const ts = one(src, 'src/pricing/orders.ts');
  const mod = ts.find(t => t.kind === 'module');
  assert.equal(mod.name, 'orders');
  assert.deepEqual(mod.methods.map(m => [m.name, m.line, m.endLine]), [['total', 2, 4], ['price', 5, 7], ['half', 8, 8]]);
  assert.deepEqual(one('export const x = 1;\nexport interface A {}').map(t => t.kind), ['interface']);
});

test('an index file takes its folder name; test files and declaration files give nothing', () => {
  assert.equal(one('export function a() { return 1; }', 'src/cart/index.ts')[0].name, 'cart');
  assert.deepEqual(one('export function a() { return 1; }', 'src/cart.test.ts'), []);
  assert.deepEqual(one('export function a() { return 1; }', 'src/cart.spec.tsx'), []);
  assert.deepEqual(one('export declare function a(): number;', 'src/cart.d.ts'), []);
});

test('cyclomatic complexity: each decision once; optional chaining, optional params and generics are not decisions', () => {
  const body = b => `function m(a: number, s?: string): number {\n${b}\n}`;
  const cc = b => find(body(b), 'm').cc;
  assert.equal(cc('return 1;'), 1);
  assert.equal(cc('if (a > 1) return 1; else if (a > 2) return 2; return 3;'), 3);
  assert.equal(cc('for (let i = 0; i < a; i++) {} for (const c of s) {} for (const k in s) {} while (a > 0) a--;'), 5);
  assert.equal(cc('switch (a) { case 1: return 1; case 2: case 3: return 2; default: return 0; }'), 4);
  assert.equal(cc('try { run(); } catch (e) { fail(e); }'), 2);
  assert.equal(cc('return a > 1 && a < 5 || a == 9 ? 1 : 0;'), 4);
  assert.equal(cc('const x = s ?? "none"; const n = s?.length; const m: Array<number> = []; return n ?? 0;'), 3);
});

test('keywords inside strings, template literals and comments do not count', () => {
  const src = 'function m() {\n  // if (x) while (y)\n  const s = "if && || ? case";\n  const t = `for ${"while"} case`;\n  /* switch */ return 1;\n}';
  assert.equal(find(src, 'm').cc, 1);
});

test('references: extends and implements are inherits, new is new, other capitalised names are uses, relative imports use the module', () => {
  const src = 'import { Repo } from "./repo";\nimport { price } from "../pricing/index";\nexport class Orders extends Base implements IOrders, IAudit {\n  make() { return new Order(); }\n  repo: Repo;\n}';
  const [t] = one(src);
  const refs = Object.fromEntries(t.refs.map(r => [r.name, r.via]));
  assert.equal(refs.Base, 'inherits'); assert.equal(refs.IOrders, 'inherits'); assert.equal(refs.IAudit, 'inherits');
  assert.equal(refs.Order, 'new'); assert.equal(refs.Repo, 'uses');
  assert.equal(refs.Orders, undefined);
  const mod = one('import { price } from "../pricing/index";\nimport x from "./repo";\nimport y from "lodash";\nexport function f() { return price(); }').find(t => t.kind === 'module');
  assert.deepEqual(mod.refs.map(r => r.name).sort(), ['pricing', 'repo']);
  assert.ok(mod.refs.every(r => r.via === 'uses' && r.line >= 1));
});

test('JSX files: a component arrow function is measured, && in markup counts', () => {
  const src = 'export const Cart = ({ items }) => {\n  return <ul>{items.length > 0 && items.map(i => <li>{i}</li>)}</ul>;\n};';
  const m = find(src, 'Cart', 'src/Cart.tsx');
  assert.equal(m.cc, 2);
});

test('a regex literal containing a quote does not swallow the rest of the file', () => {
  const src = "const esc = s => String(s).replace(/[&<>\"']/g, c => c);\nfunction a(x) { if (x) return 1; return 2; }\nfunction b(x) { return x && 1; }\n";
  const ms = js.scan('u.js', src).types.flatMap(t => t.methods);
  assert.deepEqual(ms.map(m => [m.name, m.cc]), [['esc', 1], ['a', 2], ['b', 2]]);
});

test('functions inside an immediately invoked module wrapper are measured', () => {
  const src = "const Core = (() => {\n  function parse(x) { if (x) { return 1; } return 2; }\n  const gate = (y) => y ? 1 : 0;\n  return { parse, gate };\n})();\n";
  const ms = js.scan('core.js', src).types.flatMap(t => t.methods);
  assert.deepEqual(ms.map(m => [m.name, m.cc]), [['parse', 2], ['gate', 2]]);
});
