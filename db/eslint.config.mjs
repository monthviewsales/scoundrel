// ESLint flat config
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    // Project-wide ignores
    ignores: [
      "node_modules/**",
      "logs/**",
      "coverage/**",
      "dist/**",
      "LLMs/**",
      "*.code-workspace",
      ".DS_Store"
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Add commonly useful defaults; tweak as needed
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-constant-condition": ["warn", { checkLoops: false }],
      "no-console": "off",
    },
  },
  // Tests override (explicit in case we add different rules later)
  {
    files: ["test/**/*.test.js", "__tests__/**/*.test.js"],
    languageOptions: {
      globals: {
        ...globals.jest,
        ...globals.node,
      },
    },
  },
];
