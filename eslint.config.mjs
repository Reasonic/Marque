import js from '@eslint/js';
import globals from 'globals';

// Lint is correctness-first, not style policing: the recommended set catches
// real defects (undeclared names, unreachable code, unused bindings) and leaves
// formatting alone. Empty catch blocks are allowed — pdf.mjs deliberately
// swallows unresolvable-destination errors with a comment.
export default [
  { ignores: ['node_modules/**', 'types/**', 'bench/fixtures/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      // A leading underscore marks an intentionally-unused binding.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
