const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');
const V = require('../renderer/canvas/vocabulary.js');
Core.registerProperties(V.coreSpecs());

const dsl = `workspace "Quotes" {
  model {
    s = softwareSystem "Quotes" {
      bot = container "Quote Bot" "" "Agent" {
        tags "Agent"
        properties {
          "d.agent.autonomy" "approve-writes"
          "d.agent.maxSteps" "12"
          "d.agent.privateData" "yes"
        }
      }
      plain = container "Plain Agent" {
        properties { "d.agent.autonomy" "suggest" }
      }
      db = container "Quotes DB"
      mail = container "Mailer"
    }
    bot -> db "reads quotes" "" {
      properties { "d.tool.effect" "read" }
    }
    bot -> mail "sends the quote" "SMTP" {
      properties {
        "d.tool.effect" "irreversible"
        "d.approval" "human"
        "d.protocol" "mcp"
      }
    }
    db -> mail "unrelated"
  }
}`;

test('handoverAgents: only agents, declared d.agent.* copied as declared, nothing invented', () => {
  const h = Core.handoverAgents(dsl);
  assert.equal(h.schema, 'designc.handover.agents/1');
  assert.deepEqual(h.agents.map(a => a.id), ['Quotes/Quote Bot', 'Quotes/Plain Agent']);
  const bot = h.agents[0];
  assert.equal(bot.autonomy, 'approve-writes');
  assert.equal(bot.maxSteps, 12);
  assert.equal(bot.privateData, 'yes');
  assert.ok(!('memory' in bot) && !('model' in bot), 'absent stays absent');
  assert.deepEqual(h.agents[1].tools, []);
});

test('handoverAgents: tool calls carry effect, approval and protocol only where declared', () => {
  const [bot] = Core.handoverAgents(dsl).agents;
  assert.deepEqual(bot.tools, [
    { direction: 'out', other: 'Quotes/Quotes DB', description: 'reads quotes', effect: 'read' },
    { direction: 'out', other: 'Quotes/Mailer', description: 'sends the quote', effect: 'irreversible', approval: 'human', protocol: 'mcp' },
  ]);
});

test('handoverAgents: a model with no agents gives an empty list; a model that does not parse is refused', () => {
  assert.deepEqual(Core.handoverAgents('workspace "x" { model { a = person "A" } }').agents, []);
  assert.throws(() => Core.handoverAgents('workspace {'), /handover refused/);
});

test('docs/handover-agents.example.json is what handoverAgents writes for this model, and names the schema', () => {
  const read = f => JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', f), 'utf8'));
  assert.deepEqual(read('handover-agents.example.json'), Core.handoverAgents(dsl));
  assert.equal(read('handover-agents.schema.json').properties.schema.const, Core.handoverAgents(dsl).schema);
});

test('handoverPlan: agents.json is frozen, listed and hashed only when the model has agents, and is outside the id', () => {
  const base = { date: '2026-10-19', now: 'n', by: 'm', requirements: [], decisions: [] };
  const withAgents = Core.handoverPlan({ ...base, model: { path: 'model/workspace.dsl', text: dsl } });
  const f = withAgents.files.find(x => x.path.endsWith('/agents.json'));
  assert.ok(f && JSON.parse(f.text).schema === 'designc.handover.agents/1');
  assert.match(withAgents.files[0].text, /^agents: "agents.json"$/m);
  const none = Core.handoverPlan({ ...base, model: { path: 'model/workspace.dsl', text: 'workspace "x" { model { a = person "A" } }' } });
  assert.ok(!none.files.some(x => x.path.endsWith('/agents.json')));
  assert.doesNotMatch(none.files[0].text, /^agents:/m);
});
