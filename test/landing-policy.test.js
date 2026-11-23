// S2: an agent cannot write landings/. Every role's direct write is refused, including a path that reaches it through `..`.
const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const Policy = require('../renderer/policy.js');

const ROLES = [...Object.keys(Policy.WRITE_PATHS), 'tutor', 'researcher', 'builtin', 'unknown'];
const BODY = 'requirement: RE-1\nauthor: agent\nstatus: approved\napproved: { by: x }\n';

test('no role may write landings/x.yaml', () => {
  for (const role of ROLES) {
    const v = Policy.writeVerdict(role, 'landings/RE-1.yaml', BODY, yaml.load);
    assert.equal(v.ok, false, role);
  }
});

test('no role may reach landings/ through ..', () => {
  const paths = ['model/../landings/x.yaml', 'decisions/../landings/x.yaml', 'proposals/../landings/RE-1.yaml', 'acceptance/../landings/x.yaml', 'ui/specs/../../landings/x.yaml',
    'factory/tasks/../../landings/x.yaml', 'landings/../landings/x.yaml', './landings/x.yaml', 'landings\\x.yaml', 'model/..\\landings/x.yaml', 'LANDINGS/x.yaml', '../landings/x.yaml'];
  for (const role of ROLES) for (const rel of paths) {
    const v = Policy.writeVerdict(role, rel, BODY, yaml.load);
    assert.equal(v.ok, false, `${role} ${rel}`);
  }
});

test('the write paths still allow what they allowed', () => {
  assert.equal(Policy.writeVerdict('architect', 'model/workspace.dsl', 'x', yaml.load).ok, true);
  assert.equal(Policy.writeVerdict('architect', 'decisions/a.yaml', 'id: a\nstatus: minted\n', yaml.load).ok, true);
});
