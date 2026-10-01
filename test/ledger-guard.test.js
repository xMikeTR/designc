const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RENDERER_FILES = fs.readdirSync(path.join(ROOT, 'renderer')).filter(f => f.endsWith('.js')).map(f => path.join('renderer', f));
const SOURCE_FILES = ['main.js', 'preload.js', 'ledger-store.js', ...RENDERER_FILES];
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('the store is the only ledger append path', () => {
  for (const f of ['main.js', 'preload.js', ...RENDERER_FILES]) {
    const text = read(f);
    assert.equal(/appendLedger\(/.test(text), false, `${f} still calls appendLedger(`);
    assert.equal(/ledger:append/.test(text), false, `${f} still references ledger:append`);
  }
  for (const f of ['main.js', ...RENDERER_FILES]) {
    assert.equal(/appendFile/.test(read(f)), false, `${f} should not append to files directly; the store owns it`);
  }
  const appendLedgerEventCalls = RENDERER_FILES.map(f => [f, (read(f).match(/host\.appendLedgerEvent\(/g) || []).length])
    .filter(([, n]) => n > 0);
  assert.deepEqual(appendLedgerEventCalls, [['renderer/app.js', 1]]);

  for (const f of SOURCE_FILES) {
    if (f === 'renderer/ledger.js') continue;
    assert.equal(read(f).includes('sessions.jsonl'), false, `${f} should not reference sessions.jsonl directly`);
  }
});
