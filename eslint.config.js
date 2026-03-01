// SPDX-License-Identifier: AGPL-3.0-only
import js from '@eslint/js';
import globals from 'globals';
import tsEslint from 'typescript-eslint';

export default tsEslint.config(
  js.configs.recommended,
  {
    // TypeScript source files
    files: ['src/**/*.ts'],
    extends: [...tsEslint.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: 'readonly',
        browser: 'readonly',
      },
      parserOptions: { project: './tsconfig.json' },
    },
    rules: {
      'no-console': 'off',
      'no-undef': 'off',
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_?' },
      ],
    },
  },
  {
    // chunk-text.ts is an ES module (sourceType inferred from export)
    files: ['src/chunk-text.ts'],
    languageOptions: { sourceType: 'module' },
  },
  {
    // Test and script files (Node.js context)
    files: ['tests/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', '.venv/', 'extension/**/*.js'],
  },
);
