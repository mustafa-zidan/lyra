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
    // background.js exports chunkText for Node testing — ESM syntax required.
    // browser/chrome globals are already declared above; no-undef is turned off
    // here to prevent any ESLint auto-fix from injecting spurious imports.
    files: ['extension/background.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        browser: 'readonly',
        chrome: 'readonly',
      },
    },
    rules: {
      'no-undef': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', '.venv/'],
  },
];
