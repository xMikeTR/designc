const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The two "absent" checks for extract/*.js from the extract-* governance rules, so the quality gate runs them.
const DIR = path.join(__dirname, '..', 'extract');
const FORBIDDEN = /Pricing-MaPS|PricingMaPS|Hiscox|AmunRa|maps_pricingjob/i;
const ALLOWED_REQUIRE = /^(\.{1,2}\/.*|node:.+|fs|path|os)$/;

test('extract/ has no app-specific names and requires only built-ins', () => {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.js'));
  assert.ok(files.length >= 8);
  for (const f of files) {
    const text = fs.readFileSync(path.join(DIR, f), 'utf8');
    assert.ok(!FORBIDDEN.test(text), `${f} names an app`);
    for (const m of text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) assert.match(m[1], ALLOWED_REQUIRE, `${f} requires ${m[1]}`);
  }
});
