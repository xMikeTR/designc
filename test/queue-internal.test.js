const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extract } = require('../extract.js');

const { withRepo, JOBS_REPO } = require('./helpers/with-repo');

test('a queue sent and received inside one deployable is recorded in facts.internal, not facts.edges', async () => {
  await withRepo(JOBS_REPO, async dir => {
    const r = await extract(dir);
    assert.equal(r.facts.edges.some(e => e.kind === 'async'), false);
    const links = r.facts.internal.filter(l => l.key === 'jobs');
    assert.ok(links.length >= 1);
    for (const l of links) {
      assert.equal(l.owner, 'Jobs.Functions');
      assert.ok(l.send.file && l.send.line && l.receive.file && l.receive.line);
    }
    assert.ok(links.some(l => /ReportJobOutput\.cs$/.test(l.send.file) && /JobWatcherFunction\.cs$/.test(l.receive.file)));
  });
});
