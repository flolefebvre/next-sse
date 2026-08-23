import { defineConfig, globalIgnores } from "eslint/config";
import noComments from "eslint-plugin-no-comments";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    "**/dist",
    "**/node_modules",
    "**/coverage",
    "**/.next",
    "**/.next-*",
    "**/next-env.d.ts",
  ]),
  {
    files: [
      "packages/*/src/**/*.ts",
      "packages/*/src/**/*.tsx",
      "examples/*/**/*.ts",
      "examples/*/**/*.tsx",
      "e2e/**/*.ts",
      "scripts/**/*.ts",
      "tests/**/*.ts",
      "*.config.ts",
      "*.config.mjs",
    ],
    extends: [tseslint.configs.recommended],
    plugins: { "no-comments": noComments },
    rules: {
      "no-comments/disallowComments": [
        "error",
        { allow: ["\\*", "eslint", "global", "@ts-", "prettier-ignore"] },
      ],
    },
  },
]);
