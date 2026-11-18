// A handover fixture for UI (D5): a model with a UI container, the ui-project spec, pack and holdout sample, one criterion with a
// visible case per state and one holdout case, and an approval over a few preview files. Distinctive holdout text, so a leak shows.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const Core = require('../../renderer/core.js');
const Ui = require('../../renderer/ui.js');
const { ROOT, load } = require('./ui.js');

const DSL = `workspace "Q" {
  model {
    s = softwareSystem "Bordereaux app" {
      list = container "BordereauxList" {
        tags "UI"
      }
      api = container "Bordereaux API"
    }
    list -> api "calls" {
      properties {
        d.interaction "sync"
      }
    }
  }
}
`;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const HOLDOUT_GIVEN = 'zebra-holdout-given: a cedant named Quillfeather Mutual';
const HOLDOUT_THEN = 'zebra-holdout-then: the table shows Quillfeather Mutual first';
const CRITERION = {
  id: 'AC-UI-1', requirement: 'R-1', element: 'BordereauxList', states: ['ready', 'loading', 'empty', 'error'],
  locators: { table: { role: 'table', name: 'Bordereaux' } },
  cases: [
    { state: 'ready', given: 'received bordereaux', then: 'the table lists them', uses: ['table'] },
    { state: 'loading', given: 'a slow API', then: 'a loading status shows' },
    { state: 'empty', given: 'no bordereaux', then: 'an empty message shows' },
    { state: 'error', given: 'the API fails', then: 'an alert shows' },
    { state: 'ready', given: HOLDOUT_GIVEN, then: HOLDOUT_THEN, holdout: true },
  ],
};
const PLAIN = { id: 'AC-PLAIN', requirement: 'R-1', element: 'Bordereaux API', states: ['ready'], cases: [{ state: 'ready', given: 'x', then: 'y' }] };
const textOf = c => yaml.dump(c);

function criteria() {
  return [CRITERION, PLAIN].map(c => JSON.parse(JSON.stringify(c))).map(c => ({ ...c, _path: `acceptance/${c.id}.yaml`, _text: textOf(c) }));
}
function fixture({ holdout = true } = {}) {
  const base = load();
  const model = Core.parse(DSL);
  const spec = base.specs[0];
  const specObj = { ...JSON.parse(spec.text), status: 'bound' };
  const specFile = { path: spec.path, text: JSON.stringify(specObj, null, 2) + '\n' };
  const files = { 'ready-chromium-linux.png': sha('ready'), 'loading-chromium-linux.png': sha('loading'), 'placements/ready__hdr-chromium-linux.png': sha('hdr') };
  const hold = fs.readFileSync(path.join(ROOT, 'ui/holdout/bordereaux.json'), 'utf8');
  const crit = criteria().map(c => (holdout ? c : { ...c, cases: c.cases.filter(x => !x.holdout) }));
  return {
    model, modelText: DSL, specFile, specObj, hold, criteria: crit,
    ui: {
      specs: [specFile], pack: base.pack, pin: { name: 'acme-ui', hash: 'pinhash0123456789' },
      previews: [{ screen: 'bordereaux', approved_ts: 1700, files }],
      holdouts: holdout ? { bordereaux: Ui.sha256(hold) } : {},
    },
    files,
  };
}
const inputs = (f, o = {}) => ({
  date: '2026-11-15', now: '2026-11-15T10:00:00.000Z', by: 'mike',
  model: { path: 'model/workspace.dsl', text: f.modelText },
  requirements: [{ path: 'requirements/R-1.yaml', text: 'id: R-1\nversion: 1\nelements: [BordereauxList]\n' }],
  acceptance: f.criteria.map(c => ({ path: c._path, text: c._text })),
  criteria: f.criteria, yamlDump: yaml.dump,
  specs: Core.acceptanceSpecs({ model: f.model, criteria: f.criteria }),
  ui: f.ui,
  ...o,
});
module.exports = { DSL, sha, HOLDOUT_GIVEN, HOLDOUT_THEN, CRITERION, fixture, inputs, criteria };
