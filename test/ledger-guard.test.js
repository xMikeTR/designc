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

test('python/designc/ledger.py is the only Python code that writes under ledger/', () => {
  const dir = path.join(ROOT, 'python', 'designc');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.py') && n !== 'ledger.py')) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.equal(/open\([^)]*['"][aw]\+?b?['"]/.test(text), false, `${f} opens a file for writing; ledger lines go through ledger.append_event`);
    assert.equal(/\.write\(|\.write_text\(|os\.replace|shutil\./.test(text), false, `${f} writes files; ledger lines go through ledger.append_event`);
    assert.equal(/checks\.jsonl|designc\.jsonl|agents\.jsonl|pipeline\.jsonl|sessions\.jsonl/.test(text), false, `${f} names a ledger stream file`);
  }
});
