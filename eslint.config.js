import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "data/**",
      "dist/**",
      "logs/**",
      "native/**/bin/**",
      "native/**/obj/**",
      "node_modules/**",
      "release/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["*.{js,mjs,cjs}", "src/host/**/*.{ts,tsx}", "tests/**/*.ts"],
    languageOptions: {
      globals: globals.node
    }
  },
  {
    files: ["src/client/**/*.{ts,tsx}", "src/shared/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser
    }
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }
      ]
    }
  }
);
