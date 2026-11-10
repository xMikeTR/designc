// The audit's own ESLint config: the analysed repo's config is never read or changed. No type information is needed,
// so this runs on a plain copy. typescript-eslint's parser reads both JS and TS. SARIF levels are kept as the tool
// gives them, so the sonarjs rules are set to "warn": an unreviewed smell is not an error.
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

const FILES = ['**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}'];
const warn = rules => Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, Array.isArray(v) ? ['warn', ...v.slice(1)] : 'warn']));

// Not smells: a licence header policy, and CommonJS/browser globals that a parser without type information cannot see.
const NOISE = { 'sonarjs/file-header': 'off', 'sonarjs/declarations-in-global-scope': 'off', 'sonarjs/no-reference-error': 'off' };

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/bin/**', '**/obj/**', '**/coverage/**', '**/*.min.js'] },
  { files: FILES, languageOptions: { parser: tseslint.parser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } } },
  { files: FILES, plugins: { sonarjs }, rules: { ...warn(sonarjs.configs.recommended.rules), ...NOISE } },
];
