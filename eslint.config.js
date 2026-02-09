import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["dist/**", "coverage/**"]
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
    plugins: {
      import: importPlugin
    },
    rules: {
      "no-unused-vars": "off",
      "import/no-unresolved": "off",
      "import/no-named-as-default": "off"
    }
  },
  {
    files: ["tools/**/*.mjs", "*.config.js", "*.config.cjs", "*.config.mjs"],
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
