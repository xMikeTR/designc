// Loads fixtures/ui-project into the shape Ui.clauses takes, with the pack pinned (a ui_pinned row) by default.
const fs = require('fs'), path = require('path');
const Core = require('../../renderer/core.js');
const Ui = require('../../renderer/ui.js');
const ROOT = path.join(__dirname, '..', '..', 'fixtures', 'ui-project');
const hash = Core._shared.hash16;
const ls = (base, d) => (fs.existsSync(path.join(base, d)) ? fs.readdirSync(path.join(base, d)).filter(f => f.endsWith('.json')).sort().map(f => ({ path: `${d}/${f}`, text: fs.readFileSync(path.join(base, d, f), 'utf8') })) : []);
function load(base = ROOT) {
  const pack = { components: ls(base, 'ui/pack/components'), templates: ls(base, 'ui/pack/templates') };
  const tp = path.join(base, 'design-tokens', 'tokens.json');
  const h = Ui.packHash(Ui.packFiles(pack, 'ui/pack/'), hash);
  return { pack, specs: ls(base, 'ui/specs'), holdouts: ls(base, 'ui/holdout'), tokens: fs.existsSync(tp) ? fs.readFileSync(tp, 'utf8') : null, ledger: [{ kind: 'ui_pinned', pack: 'acme-ui', registry: 'acme-ui', hash: h, _ts: 1 }], hash };
}
const BROKEN = fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'ui-broken-spec.json'), 'utf8');
module.exports = { ROOT, hash, ls, load, BROKEN };
