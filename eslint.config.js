import js from "@eslint/js";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["**/dist/**", "dist-e2e/**", "coverage/**"]
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx,ts,tsx,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module"
      },
      globals: {
        ...globals.browser
      }
    },
    rules: {
      "no-unused-vars": "off"
    }
  },
  {
    files: [
      "tools/**/*.{mjs,ts}",
      "playwright.config.ts",
      "*.config.js",
      "*.config.cjs",
      "*.config.mjs"
    ],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },
  {
    files: ["backend/**/*.{js,ts,mjs,cjs}"],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  }
];
