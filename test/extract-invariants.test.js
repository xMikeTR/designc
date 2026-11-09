const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The two "absent" checks for extract/*.js from the extract-* governance rules, so the quality gate runs them.
const DIR = path.join(__dirname, '..', 'extract');
// App-specific names are kept out of extract/, but not written here: the list is SHA-256 hashes of the lowercased names.
const crypto = require('crypto');
const FORBIDDEN_HASHES = new Set([
  '6c972997152ae9fb337aa95c363284cef07cfb5be056de4f54dae451ef2d84ef',
  '4e82db167ab28405226153cfc1e328029e965a97813b7eedf3bfcbe38e6da083',
  '3e78af35ee06352372cc7c53427eedb2700a1278c597eb5db06e119552bbf9ca',
  '5d3fae7ecf6ab762710b28f751184d1799da3dcc2ca1c918711bd0e46943d4de',
  '949526be21805d9cca5cba7fde3aa8a9d93d248e798489179674c4c87657f4fc',
]);
const LENGTHS = [11, 12, 6, 15];
const sha = s => crypto.createHash('sha256').update(s.toLowerCase()).digest('hex');
const FORBIDDEN = { test(text) {
  for (const [w] of text.matchAll(/[\w-]+/g))
    for (const n of LENGTHS) for (let i = 0; i + n <= w.length; i++) if (FORBIDDEN_HASHES.has(sha(w.slice(i, i + n)))) return true;
  return false;
} };
const ALLOWED_REQUIRE = /^(\.{1,2}\/.*|node:.+|fs|path|os)$/;
// Phase 7 (approved): the UI graph parses with the TypeScript compiler, required lazily and only in extract/ui*.js.
const allowed = (file, mod) => ALLOWED_REQUIRE.test(mod) || (mod === 'typescript' && /^ui(-[a-z]+)?\.js$/.test(file));

test('extract/ has no app-specific names and requires only built-ins', () => {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.js'));
  assert.ok(files.length >= 8);
  for (const f of files) {
    const text = fs.readFileSync(path.join(DIR, f), 'utf8');
    assert.ok(!FORBIDDEN.test(text), `${f} names an app`);
    for (const m of text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) assert.ok(allowed(f, m[1]), `${f} requires ${m[1]}`);
  }
});
