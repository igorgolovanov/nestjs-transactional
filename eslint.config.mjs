import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import-x';

/**
 * Flat config. ESLint 10 dropped `.eslintrc.*` support entirely — it no
 * longer depends on `@eslint/eslintrc`, so there is no fallback and no
 * `ESLINT_USE_FLAT_CONFIG` escape hatch. Everything below is a port of
 * the previous `.eslintrc.js`, rule for rule.
 *
 * ESLint ignores `node_modules` on its own in flat config, so only the
 * generated directories need naming. Non-TypeScript files are ignored
 * outright, which is what `ignorePatterns: ['*.js', '*.cjs']` did before
 * — and it also keeps the type-checked rule sets, which carry no `files`
 * of their own, from ever being applied to a file the parser has no
 * program for.
 */
export default [
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/*.js', '**/*.cjs', '**/*.mjs'],
  },
  js.configs.recommended,
  ...tsPlugin.configs['flat/recommended-type-checked'],
  ...tsPlugin.configs['flat/stylistic-type-checked'],
  prettier,
  {
    // `env: { node, jest, es2022 }` from the eslintrc config is
    // deliberately not ported. It existed to feed `no-undef`, which
    // typescript-eslint's `eslint-recommended` turns off for TypeScript
    // files — the compiler reports undefined identifiers with better
    // precision. The lint scope here is TypeScript only.
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      // `eslint-plugin-import` is capped at ESLint 9 (its peer range ends
      // at `^9`, and upstream has shipped nothing past 2.32.0). Under
      // ESLint 10 its `order` rule throws
      // `sourceCode.getTokenOrCommentAfter is not a function` the moment
      // it has something to report — a dead gate that looks like a
      // passing one. `eslint-plugin-import-x` is the maintained fork and
      // declares `eslint: ^10`.
      'import-x': importPlugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/prefer-readonly': 'warn',
      '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'no-public' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.integration.spec.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
];
