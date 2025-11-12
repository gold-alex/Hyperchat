// ESLint flat config for ESLint v9+
// Lints JS/TS in a WXT browser extension + Jest tests

const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const jestPlugin = require('eslint-plugin-jest');

module.exports = [
  {
    ignores: ['.output/**', 'dist/**', 'coverage/**', 'node_modules/**', '.wxt/**'],
  },
  {
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      globals: { chrome: 'readonly' },
    },
    plugins: { '@typescript-eslint': tsPlugin, jest: jestPlugin },
    rules: {
      // General
      'no-undef': 'off',
      'no-console': 'off',
      // TS
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['__tests__/**/*', '**/*.test.*'],
    plugins: { jest: jestPlugin },
    rules: {
      ...jestPlugin.configs.recommended.rules,
    },
  },
];

