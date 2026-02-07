import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";
import sonarjs from "eslint-plugin-sonarjs";
import importX from "eslint-plugin-import-x";
import promise from "eslint-plugin-promise";
import noSecrets from "eslint-plugin-no-secrets";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // 1. Global ignores
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "src/tools/**",
      "src/scripts/**",
      "plans/**",
      "*.js",
      "*.mjs",
    ],
  },

  // 2. TypeScript strict type-checked preset
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
  },

  // 3. Security plugin recommended
  security.configs.recommended,

  // 4. SonarJS plugin recommended
  sonarjs.configs.recommended,

  // 5. Main rules block for all TS files
  {
    files: ["**/*.ts"],
    plugins: {
      "import-x": importX,
      promise,
      "no-secrets": noSecrets,
    },
    rules: {
      // --- Deprecated patterns ---
      "no-var": "error",
      "prefer-const": "error",
      "no-new-object": "error",
      "no-array-constructor": "error",

      // --- Debug code ---
      "no-console": "warn",
      "no-debugger": "error",
      "no-alert": "error",

      // --- Security anti-patterns ---
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "security/detect-object-injection": "off",

      // --- Type safety ---
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "separate-type-imports",
        },
      ],
      "@typescript-eslint/no-require-imports": "error",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],

      // --- Async/Promise rules ---
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/require-await": "warn",
      "@typescript-eslint/promise-function-async": "warn",
      "promise/always-return": "warn",
      "promise/catch-or-return": "warn",
      "promise/no-nesting": "warn",

      // --- Complexity ---
      "sonarjs/cognitive-complexity": ["warn", 15],
      "max-depth": ["warn", 4],
      "max-nested-callbacks": ["warn", 3],

      // --- Import rules ---
      "import-x/order": [
        "error",
        {
          groups: [
            "builtin",
            "external",
            "internal",
            "parent",
            "sibling",
            "index",
            "type",
          ],
          "newlines-between": "always",
          alphabetize: { order: "asc" },
        },
      ],
      "import-x/no-cycle": "error",

      // --- Naming conventions ---
      "@typescript-eslint/naming-convention": [
        "warn",
        { selector: "variable", format: ["camelCase", "UPPER_CASE"] },
        { selector: "function", format: ["camelCase"] },
        { selector: "typeLike", format: ["PascalCase"] },
        { selector: "enumMember", format: ["UPPER_CASE"] },
      ],

      // --- Secrets detection ---
      "no-secrets/no-secrets": ["error", { tolerance: 6 }],
    },
  },

  // 6. Test file overrides (relaxed rules)
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "**/__tests__/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-require-imports": "off",
      "no-console": "off",
    },
  },

  // 7. Prettier compat (must be last — disables formatting conflicts)
  prettier,
);
