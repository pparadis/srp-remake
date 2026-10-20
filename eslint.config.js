import js from '@eslint/js';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tseslint from 'typescript-eslint';

const noPrivateIdentifier = {
  selector: 'PrivateIdentifier',
  message: 'Use `private`, not `#name`.'
};
const noConstEnum = { selector: 'TSEnumDeclaration[const=true]', message: 'No const enum.' };
const noDefaultExport = { selector: 'ExportDefaultDeclaration', message: 'No default exports.' };
// Nested functions may be arrows, and an arrow with a type annotation may implement an interface.
const topLevelFunctionDeclaration = {
  selector:
    ':matches(Program, ExportNamedDeclaration) > VariableDeclaration > VariableDeclarator[id.typeAnnotation=undefined]' +
    ":matches([init.type='ArrowFunctionExpression'], [init.type='FunctionExpression'])",
  message: 'A top-level named function is a function declaration.'
};

export default [
  {
    ignores: ['**/dist/**', 'dist-e2e/**', 'coverage/**']
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module'
      },
      globals: {
        ...globals.browser,
        // vite `define`s (vite.config.ts)
        __GIT_SHA__: 'readonly',
        __BUILD_DATE__: 'readonly',
        __PREVIEW_PR__: 'readonly'
      }
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'no-unused-vars': 'off',

      // Google TypeScript style guide (#73): a curated set, not a preset.
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'no-public' }],
      '@typescript-eslint/no-namespace': 'error',
      '@typescript-eslint/triple-slash-reference': 'error',
      '@typescript-eslint/no-wrapper-object-types': 'error',
      '@typescript-eslint/no-empty-object-type': 'error',
      '@typescript-eslint/no-extraneous-class': 'error',
      '@typescript-eslint/no-this-alias': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description' }
      ],
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'typeLike', format: ['PascalCase'] },
        {
          selector: 'variable',
          modifiers: ['global', 'const'],
          format: ['camelCase', 'UPPER_CASE']
        },
        // An ignored name in a rest destructure: `const { a: _a, ...rest } = x`.
        {
          selector: 'variable',
          modifiers: ['unused'],
          format: ['camelCase'],
          leadingUnderscore: 'allow'
        },
        { selector: 'variable', format: ['camelCase'] },
        { selector: 'function', format: ['camelCase'] },
        // `_name` stays: tsconfig `noUnusedParameters` needs that spelling for an unused parameter.
        { selector: 'parameter', format: ['camelCase'], leadingUnderscore: 'allow' },
        {
          selector: 'memberLike',
          modifiers: ['private'],
          format: null,
          leadingUnderscore: 'forbid',
          trailingUnderscore: 'forbid'
        },
        {
          selector: 'classProperty',
          format: null,
          leadingUnderscore: 'forbid',
          trailingUnderscore: 'forbid'
        },
        {
          selector: 'classMethod',
          format: null,
          leadingUnderscore: 'forbid',
          trailingUnderscore: 'forbid'
        }
      ],
      'id-denylist': ['error', '_'],
      'no-restricted-properties': [
        'error',
        { object: 'Number', property: 'parseInt', message: 'Use Number() and check the result.' },
        { object: 'Number', property: 'parseFloat', message: 'Use Number() and check the result.' }
      ],
      'no-restricted-globals': [
        'error',
        { name: 'parseInt', message: 'Use Number() and check the result.' },
        { name: 'parseFloat', message: 'Use Number() and check the result.' }
      ],
      'no-restricted-syntax': [
        'error',
        noPrivateIdentifier,
        noConstEnum,
        noDefaultExport,
        topLevelFunctionDeclaration
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      curly: ['error', 'multi-line'],
      'default-case': 'error',
      'default-case-last': 'error',
      'no-fallthrough': 'error',
      'guard-for-in': 'error',
      'no-new-wrappers': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-with': 'error',
      'no-debugger': 'error',
      'prefer-rest-params': 'error',
      'prefer-spread': 'error',
      'no-array-constructor': 'error'
    }
  },
  {
    // The tools require a default export here.
    files: ['*.config.{js,ts,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        noPrivateIdentifier,
        noConstEnum,
        topLevelFunctionDeclaration
      ]
    }
  },
  {
    // Type-aware rules, only where a tsconfig covers the file (the typed pass is the slow part of lint).
    files: ['src/**/*.ts', 'backend/src/**/*.ts'],
    ignores: ['**/*.d.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/consistent-type-exports': 'error'
    }
  },
  {
    // No `!` and no object-literal `as` in the app and the server (#77): a lookup that cannot miss goes through
    // `must` (src/game/must.ts), which throws a clear error. Not tests (they assert what they know about a
    // fixture), not tools/ (dev scripts), not v1 (a frozen copy of the old rules, kept as it was written).
    files: ['src/**/*.ts', 'backend/src/**/*.ts'],
    ignores: ['**/*.test.ts', 'src/game/rules/v1/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' }
      ]
    }
  },
  {
    // Ambient names come from vite `define` (vite.config.ts).
    files: ['**/*.d.ts'],
    rules: { '@typescript-eslint/naming-convention': 'off' }
  },
  {
    // Tests: small arrow helpers at the top of the file, and module mocks that are empty classes.
    files: ['**/*.test.ts', '**/test/**', 'e2e/**'],
    rules: {
      'no-restricted-syntax': ['error', noPrivateIdentifier, noConstEnum, noDefaultExport],
      '@typescript-eslint/no-extraneous-class': 'off'
    }
  },
  {
    files: [
      'tools/**/*.{mjs,ts}',
      'playwright.config.ts',
      '*.config.js',
      '*.config.cjs',
      '*.config.mjs'
    ],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },
  {
    files: ['backend/**/*.{js,ts,mjs,cjs}'],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  }
];
