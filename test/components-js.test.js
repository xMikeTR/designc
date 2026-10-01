const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { extract } = require('../extract.js');
const { withRepo } = require('./helpers/with-repo');

const FULLSTACK = path.join(__dirname, '..', 'fixtures', 'fullstack');
const spa = (name, extra = {}) => JSON.stringify({ name, private: true, dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0', ...extra }, devDependencies: { vite: '^5.0.0' } });
const namesOf = (facts, owner) => facts.components.filter(c => c.owner === owner).map(c => c.name).sort();
const uses = facts => facts.componentEdges.filter(e => e.via === 'import').map(e => `${e.from} > ${e.to}`).sort();

test('require calls become Uses edges in a Node API', async () => {
  const { facts } = await extract(FULLSTACK);
  const e = facts.componentEdges.filter(x => x.from === 'c_nodeapi_appshell' && x.to === 'c_nodeapi_routes');
  assert.equal(e.length, 1);
  assert.deepEqual([e[0].kind, e[0].label, e[0].tech, e[0].via], ['sync', 'Uses', 'in-process', 'import']);
  assert.match(e[0].evidence[0].file, /node-api\/src\/server\.js$/);
});

test('grouping folders step down and alias imports become Uses edges', async () => {
  await withRepo({
    'web/package.json': spa('web'),
    'web/tsconfig.json': '{ // paths\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }',
    'web/src/services/api.ts': 'export const api = 1;',
    'web/src/features/customers/List.tsx': "import { api } from '@/services/api';\nexport const List = () => api;",
    'web/src/features/orders/Page.tsx': "import { api } from '../../services/api';\n// import { x } from '../auth/login'\nexport const Page = () => api;",
    'web/src/features/auth/login.ts': 'export const login = 1;',
  }, async dir => {
    const { facts } = await extract(dir);
    assert.deepEqual(namesOf(facts, 'web'), ['auth', 'customers', 'orders', 'services']);
    assert.deepEqual(uses(facts), ['c_web_customers > c_web_services', 'c_web_orders > c_web_services']);
  });
});

test('support folders fold into Shared and only grouping folders step down', async () => {
  const files = { 'web/package.json': spa('web'), 'web/src/main.tsx': 'export {};' };
  for (const d of ['types', 'constants', 'styles', 'assets', '__mocks__', 'test']) files[`web/src/${d}/x.ts`] = 'export {};';
  files['web/src/features/index.ts'] = 'export {};';
  files['web/src/features/billing/b.ts'] = 'export {};';
  files['web/src/pages/a/b.tsx'] = 'export {};';
  files['web/src/pages/a/b.test.tsx'] = 'export {};';
  files['plain/package.json'] = spa('plain');
  files['plain/lib/x.ts'] = 'export {};';
  await withRepo(files, async dir => {
    const { facts } = await extract(dir);
    assert.deepEqual(namesOf(facts, 'web'), ['App shell', 'Shared', 'billing', 'features', 'pages']);
    const pages = facts.components.find(c => c.owner === 'web' && c.name === 'pages');
    assert.deepEqual(pages.files, ['web/src/pages/a/b.tsx']);
    assert.deepEqual(namesOf(facts, 'plain'), ['lib']);
  });
});

test('workspace library packages become components of their dependants', async () => {
  await withRepo({
    'web/package.json': spa('web', { 'ui-kit': 'workspace:*' }),
    'web/src/pages/Home.tsx': "import { Button } from 'ui-kit';\nimport _ from 'lodash';\nexport const Home = () => Button;",
    'ui-kit/package.json': JSON.stringify({ name: 'ui-kit', private: true, dependencies: {} }),
    'ui-kit/src/index.ts': 'export const Button = 1;',
  }, async dir => {
    const { facts } = await extract(dir);
    assert.deepEqual(namesOf(facts, 'web'), ['pages', 'ui-kit']);
    assert.deepEqual(uses(facts), ['c_web_pages > c_web_uikit']);
  });
});
