// Builds python/designc/ledger_schema.json from renderer/ledger.js, the one source of the ledger schema.
// `node test/helpers/ledger-schema.js --write` regenerates it; test/ledger.schema.test.js fails when it is stale.
const fs = require('fs');
const path = require('path');
const Ledger = require('../../renderer/ledger.js');

const FILE = path.join(__dirname, '..', '..', 'python', 'designc', 'ledger_schema.json');

function build() {
  const kinds = {};
  for (const k of Object.keys(Ledger.KINDS).sort()) {
    const s = Ledger.FINAL_KIND_FIELDS[k] || { required: [], optional: [], enums: {} };
    kinds[k] = { stream: Ledger.KINDS[k].stream, required: s.required, optional: s.optional, enums: s.enums || {}, types: s.types || {}, rules: s.rules || [] };
  }
  const schema = {
    note: 'Generated from renderer/ledger.js by test/helpers/ledger-schema.js --write. Do not edit by hand.',
    schema_version: Ledger.SCHEMA_VERSION,
    envelope_optional: Ledger.ENVELOPE_OPTIONAL,
    caught_by: Ledger.CAUGHT_BY,
    pipeline_stream: Ledger.PIPELINE_STREAM,
    pipeline_kinds: Ledger.PIPELINE_KINDS,
    rules: Ledger.RULE_IDS,
    kinds,
  };
  return JSON.stringify(schema, null, 2) + '\n';
}

if (require.main === module && process.argv.includes('--write')) { fs.writeFileSync(FILE, build()); console.log(`wrote ${FILE}`); }
module.exports = { build, FILE };
