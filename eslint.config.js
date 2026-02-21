// SPDX-License-Identifier: AGPL-3.0-only
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script', // extension files are plain scripts, not ESM
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        // Explicit shims used throughout the extension
        chrome: 'readonly',
        browser: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_?' }],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // chunk-text.js is an ES module (exports chunkText for Node unit tests).
    files: ['extension/chunk-text.js'],
    languageOptions: { sourceType: 'module' },
  },
  {
    ignores: ['dist/', 'node_modules/', '.venv/'],
  },
];
