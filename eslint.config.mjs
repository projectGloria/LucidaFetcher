// Lint config.
//
// The engine is covered by the test suite; main.js, youtube-dl.js and the whole
// React UI had no automated checking of any kind, and that is where most of the
// review's findings were. Several of them were things a linter says for free:
// exported helpers with no callers, a dead import, and a handler parameter
// shadowing an outer binding.
//
// Deliberately small. A wall of style complaints on a codebase this carefully
// commented would be noise, and noise is how a linter gets turned off - so the
// rules here are the ones that catch defects, not the ones that have opinions
// about spacing.
//
//   npm run lint

import globals from 'globals';
import react from 'eslint-plugin-react';

const correctness = {
  'no-unused-vars': ['warn', {
    args: 'after-used',
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    // `catch (e) { /* deliberately ignored */ }` is an idiom throughout this
    // codebase and is nearly always accompanied by a comment saying why.
    caughtErrors: 'none',
  }],
  'no-shadow': 'warn',
  'no-fallthrough': 'error',
  'no-unsafe-finally': 'error',
  'no-unmodified-loop-condition': 'warn',
  'no-constant-binary-expression': 'error',
  'require-atomic-updates': 'warn',
  // Used on purpose to serialise scrapes, searches and state writes.
  'no-await-in-loop': 'off',
  eqeqeq: ['warn', 'always', { null: 'ignore' }],
};

export default [
  {
    ignores: [
      'dist/**', 'release/**', 'node_modules/**',
      'state/**', 'logs/**', 'lucidafetcherBAK/**',
      // The superseded pre-React UI. Kept for reference, not maintained.
      'legacy/**',
      'build/**',
    ],
  },

  // The engine and the build scripts: plain ESM on Node.
  {
    files: ['src/engine/**/*.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: correctness,
  },

  // The renderer: ESM in a browser, plus Electron's `require` on window.
  {
    files: ['src/ui/**/*.js', 'src/ui/**/*.jsx', 'test/**/*.jsx'],
    plugins: { react },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...correctness,
      // Without these, every component referenced only from JSX reads as unused.
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      'react/jsx-key': 'warn',
      'react/no-danger': 'error',
    },
  },

  // The main process: CommonJS on Node.
  {
    files: ['main.js', 'src/engine/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: correctness,
  },
];
