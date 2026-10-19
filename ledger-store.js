// designc desktop: main-process ledger store. The only code that appends to ledger/ for either
// envelope (R-5) — see renderer/ledger.js for the schema.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Ledger = require('./renderer/ledger.js');

function isoNow(ms) { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00'); }

// Two envelopes, one store (R-1): dispatch by kind into the disjoint designc/harness sets
// (R-3), each with its own validator, stamping and stream. Neither set -> unknown kind.
async function appendEvent(root, event, { now = Date.now, uuid = crypto.randomUUID } = {}) {
  const isDesignc = event && typeof event === 'object' && !!Ledger.KINDS[event.kind];
  const isHarness = event && typeof event === 'object' && Ledger.HARNESS_KINDS.includes(event.kind);
  if (!isDesignc && !isHarness) return { ok: false, errors: [`kind: unknown kind '${event && event.kind}'`] };

  let stamped, stream;
  if (isDesignc) {
    const errors = Ledger.validate(event);
    if (errors.length) return { ok: false, errors };
    stamped = {
      ...event,
      schema_version: Ledger.SCHEMA_VERSION,
      event_id: event.event_id || uuid(),
      ts: event.ts != null ? event.ts : now(),
    };
    stream = Ledger.KINDS[event.kind].stream;
  } else {
    if ('schema_version' in event && event.schema_version !== undefined) return { ok: false, errors: ['schema_version: not allowed on a harness kind'] };
    const errors = Ledger.validateHarness(event);
    if (errors.length) return { ok: false, errors };
    stamped = { envelope_version: Ledger.HARNESS_ENVELOPE_VERSION, event_id: event.event_id || uuid(), ts: event.ts || isoNow(now()) };
    for (const f of Ledger.HARNESS_FIELDS) if (!(f in stamped)) stamped[f] = event[f] !== undefined ? event[f] : (Ledger.HARNESS_NULLABLE.includes(f) ? null : undefined);
    stamped.payload = event.payload || {};
    const sorted = {}; Object.keys(stamped).sort().forEach(k => { sorted[k] = stamped[k]; });
    stamped = sorted;
    stream = Ledger.HARNESS_STREAM;
  }
  const file = path.join(root, 'ledger', stream);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.appendFile(file, JSON.stringify(stamped) + '\n', 'utf8');
  return { ok: true, event: stamped };
}

module.exports = { appendEvent };
