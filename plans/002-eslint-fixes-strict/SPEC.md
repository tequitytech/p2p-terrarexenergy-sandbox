# ESLint Strict Configuration Specification

## Goal

Add strict ESLint + Prettier configuration to the P2P energy trading sandbox. Enforce type safety, ban dangerous patterns, and follow Google TypeScript style guide best practices. Configuration uses ESLint v9 flat config format.

### Codebase Context

| Metric | Value |
|--------|-------|
| Total source files | ~85 TypeScript + 4 legacy JS |
| Module system | CommonJS (`"type": "commonjs"`, `"module": "commonjs"`) |
| TypeScript strict mode | Already enabled |
| Existing linter | None |
| Existing formatter | None |
| Existing `any` usage | ~259 occurrences across 48 files (beckn protocol JSON-LD, MongoDB documents, error catches) |
| Existing `console.*` usage | ~388 occurrences across 40 files (no structured logger exists) |
| Existing `import type` usage | Zero — all types imported via regular `import` |
| Framework | Express 5 with async handlers |

---

## Decision Summary

### Type Safety

| Rule | Setting | Rationale |
|------|---------|-----------|
| `@typescript-eslint/no-explicit-any` | `warn` | ~259 existing occurrences. Beckn protocol uses dynamic JSON-LD with namespaced keys (`beckn:id`, `schema:price`, `@context`) making full static typing impractical. Warn gives visibility without drowning the report. |
| `@typescript-eslint/consistent-type-imports` | `error` | Auto-fixable. Enforces `import type` where possible. Run `lint:fix` to convert all existing type-only imports in one pass. |
| `@typescript-eslint/no-require-imports` | `error` + allowlist | Error by default, allowlist built from actual violations only |
| `@typescript-eslint/explicit-function-return-type` | `off` | Allow TypeScript inference, avoid noise |
| `@typescript-eslint/explicit-module-boundary-types` | `warn` | Exported functions should declare return types for clear API contracts, but many Express handlers return `Promise<void>` which TS infers fine. Warn, not error. |
| Test file `any` | `off` | Relaxed typing in tests for mocking flexibility |
| Test file `no-require-imports` | `off` | `jest.requireActual()` is standard Jest practice (9 test files use it) |

### Base Config

| Component | Choice |
|-----------|--------|
| TypeScript preset | `strict-type-checked` (type-aware, requires `parserOptions.project`) |
| Config format | ESLint v9 flat config (`eslint.config.mjs`) |

> **Note**: `strict-type-checked` is the most aggressive preset. It includes `no-unsafe-argument`, `no-unsafe-assignment`, `no-unsafe-return` (which will flag `any`-typed values beyond just their declaration), `no-unnecessary-condition`, `restrict-template-expressions`, and `no-confusing-void-expression`. This is intentional — the warnings represent real technical debt.

### Enforcement

| Aspect | Approach |
|--------|----------|
| Rollout strategy | **Strict immediately** — all rules start as their final severity, fix violations as they appear |
| CI integration | **No CI yet** — lint scripts are for local use. CI integration is a future task. |
| Enforcement mechanism | Code review discipline — reviewers reject PRs with new violations |
| Pre-commit hooks | None |

### Standards & Foundations

| Component | Choice |
|-----------|--------|
| Base style guide | Google TypeScript Style Guide |
| Formatting | **Prettier owns all formatting** — default Prettier config (no customization). `eslint-config-prettier` disables conflicting ESLint rules. |
| Naming conventions | Variables/functions only — camelCase vars, PascalCase types, UPPER_CASE constants. **No property/parameter rules** due to mixed naming from beckn protocol (`beckn:id`), MongoDB fields (`meter_id`), and DEG Ledger API (`discomIdBuyer`). |

---

## Plugin Suite

### Required Plugins

| Plugin | Purpose | Severity |
|--------|---------|----------|
| `@typescript-eslint/eslint-plugin` | TypeScript-aware rules via `strict-type-checked` preset | error/warn per rule |
| `eslint-plugin-security` | Security anti-patterns — full recommended set, `detect-object-injection` disabled | warn |
| `eslint-plugin-import-x` | Import hygiene, no cycles, ordering (flat config compatible fork of eslint-plugin-import) | auto-fix / error |
| `eslint-plugin-promise` | Promise/async safety — complements TypeScript-ESLint's promise rules with non-type-aware checks | error/warn per rule |
| `eslint-plugin-sonarjs` | Full recommended set — cognitive complexity, code smells, duplication detection | warn |
| `eslint-plugin-no-secrets` | Hardcoded secrets detection — Shannon entropy tolerance at 6 | error |
| `eslint-config-prettier` | Disable all formatting rules that conflict with Prettier | n/a |
| `prettier` | Code formatter — default config, no customization | n/a |

### Removed Plugins

| Plugin | Reason for removal |
|--------|--------------------|
| `eslint-plugin-pii` | PII handling is a code review concern, not a lint concern. The domain inherently handles user data (meter IDs, agent emails); plugin would generate false positives on legitimate business logic. |

---

## Rule Configuration

### Banned Patterns (Errors)

#### Deprecated Patterns
```javascript
'no-var': 'error',
'prefer-const': 'error',
'no-new-object': 'error',
'no-array-constructor': 'error',
```

#### Debug Code
```javascript
'no-console': 'warn',     // ~388 existing calls, no structured logger yet. Warn for visibility.
'no-debugger': 'error',
'no-alert': 'error',
```

> **No logger file override.** Since `no-console` is `warn` (not `error`) and no logger module exists yet, the logger file override is unnecessary. Add `no-console: off` overrides for logger files when the logger is actually built.

#### Security Anti-Patterns
```javascript
'no-eval': 'error',
'no-implied-eval': 'error',
'no-new-func': 'error',
// eslint-plugin-security recommended set is enabled globally.
// Only override:
'security/detect-object-injection': 'off',  // Too noisy — flags array indexing, computed properties
```

### Async/Promise Rules

```javascript
'@typescript-eslint/no-floating-promises': 'error',    // Must await, return, or void
'@typescript-eslint/require-await': 'warn',             // Express 5 async handlers are a safety pattern even without await
'@typescript-eslint/promise-function-async': 'warn',    // Prefer async for promise-returning
'promise/always-return': 'warn',
'promise/catch-or-return': 'warn',
'promise/no-nesting': 'warn',
```

**Escape hatch for fire-and-forget:**
```typescript
void someAsyncOperation();  // Explicit void is allowed by no-floating-promises
```

> **Why keep both promise plugins?** `@typescript-eslint` handles type-aware promise rules (`no-floating-promises`, `require-await`). `eslint-plugin-promise` adds non-type-aware checks (`no-nesting`, `always-return`, `no-new-statics`) that complement rather than duplicate.

### Complexity Thresholds

```javascript
'sonarjs/cognitive-complexity': ['warn', 15],  // Industry standard (Google/SonarQube default)
'max-depth': ['warn', 4],                      // Max nesting levels
'max-nested-callbacks': ['warn', 3],           // Max callback nesting
```

> All three rules are kept. Cognitive complexity catches overall logic sprawl; depth and callbacks catch specific structural anti-patterns independently. Large files like `webhook/controller.ts` (1,190 lines) and `sync-api/controller.ts` (965 lines) will generate warnings — this is intentional technical debt visibility.

### Import Rules (Auto-fix Enabled)

```javascript
'import-x/order': ['error', {
  'groups': ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
  'newlines-between': 'always',
  'alphabetize': { 'order': 'asc' }
}],
'import-x/no-cycle': 'error',  // Circular dependencies are bugs
```

> `import-x/no-unused-modules` is **intentionally omitted** — it's notoriously slow (especially combined with `strict-type-checked` which already runs the TypeScript compiler), has known false positives with re-exports, and IDE tooling handles dead code detection better.

> Type-only imports (`import type`) are grouped separately at the bottom via the `type` group, visually separating runtime from type-only imports.

### Type Import Enforcement

```javascript
'@typescript-eslint/consistent-type-imports': ['error', {
  'prefer': 'type-imports',
  'fixStyle': 'separate-type-imports',
}],
```

> Auto-fixable. The codebase currently has zero `import type` usage. Running `lint:fix` will convert all type-only imports automatically. Separate type imports (not inline) for clearer visual separation.

### Unused Variables

```javascript
'@typescript-eslint/no-unused-vars': ['error', {
  'argsIgnorePattern': '^_',
  'destructuredArrayIgnorePattern': '^_',
  'caughtErrorsIgnorePattern': '^_',
}],
```

### Naming Conventions (Warnings)

```javascript
'@typescript-eslint/naming-convention': [
  'warn',
  { 'selector': 'variable', 'format': ['camelCase', 'UPPER_CASE'] },
  { 'selector': 'function', 'format': ['camelCase'] },
  { 'selector': 'typeLike', 'format': ['PascalCase'] },
  { 'selector': 'enumMember', 'format': ['UPPER_CASE'] },
],
```

> **No property/parameter selectors.** This project interfaces with:
> - Beckn protocol: colon-namespaced keys (`beckn:id`, `schema:price`, `@context`, `@type`)
> - MongoDB: snake_case fields (`meter_id`, `transaction_id`, `source_type`)
> - DEG Ledger API: mixed (`discomIdBuyer`, `tradeQty`, `statusBuyerDiscom`)
>
> Any property naming rule would generate hundreds of false positives on legitimate external data passthrough. Naming enforcement is restricted to variables, functions, types, and enum members which are fully under our control.

### Secrets Detection

```javascript
'no-secrets/no-secrets': ['error', { 'tolerance': 6 }],
```

> Tolerance raised to 6 (above default ~4). The codebase contains beckn protocol key IDs (long base58 strings like `76EU9BAuE6ymc9vPpU8XMfVVVTxr6LheC8RKihrCdNwPdBeiiybyLw`), base64 signing keys, and MongoDB connection URIs. Higher threshold reduces false positives while still catching genuinely high-entropy secrets.

---

## File-Specific Overrides

### Test Files (`**/*.spec.ts`, `**/*.test.ts`, `**/__tests__/**`)

```javascript
rules: {
  '@typescript-eslint/no-explicit-any': 'off',
  '@typescript-eslint/explicit-function-return-type': 'off',
  '@typescript-eslint/explicit-module-boundary-types': 'off',
  '@typescript-eslint/no-non-null-assertion': 'off',
  '@typescript-eslint/no-require-imports': 'off',   // jest.requireActual() is standard practice
  'no-console': 'off',
}
```

### Ignored Paths

```javascript
ignores: [
  'dist/**',
  'node_modules/**',
  'coverage/**',
  'src/tools/**',       // Legacy JS files (publish-catalogue.js, select-builder.js, etc.)
  'src/scripts/**',     // Operational utilities (seed-users.ts, e2e-orderflow.ts)
  'plans/**',           // Task plans and specs (TASKS.json, SPEC.md)
]
```

> Changes from original spec:
> - Removed `src/generated/**` — directory does not exist in this project
> - Removed `scripts/**` (root-level) — replaced with `src/scripts/**` (actual location)
> - Added `coverage/**` — jest coverage output
> - Added `src/tools/**` — 4 legacy JS files that would crash type-aware linting
> - Added `plans/**` — non-code planning documents

---

## require() Handling

### Strategy

1. Enable `@typescript-eslint/no-require-imports: error`
2. Run lint against the codebase
3. Audit each actual violation
4. Build allowlist from real violations only — document the reason for each exception

> **No pre-built allowlist.** The current codebase uses ES module `import` syntax for all production dependencies. Only test files use `require()` via `jest.requireActual()`, which is handled by the test file override (`no-require-imports: off`).

---

## NPM Scripts

Add to `package.json`:

```json
{
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "lint:report": "eslint . --format json --output-file eslint-report.json",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  }
}
```

| Script | Purpose |
|--------|---------|
| `lint` | Check for violations (exit code reflects errors) |
| `lint:fix` | Auto-fix what can be auto-fixed (imports, type imports, formatting conflicts) |
| `lint:report` | Output JSON report to `eslint-report.json` for future CI consumption |
| `format` | Format all files with Prettier |
| `format:check` | Check formatting without modifying files |

---

## Output Artifacts

| Artifact | Path | Purpose |
|----------|------|---------|
| ESLint config | `eslint.config.mjs` | Flat config file with all rules |
| Prettier config | None | Default Prettier config (no `.prettierrc` needed) |
| `.eslintignore` | N/A | Not needed — ignores defined in flat config |

---

## .gitignore Additions

```
eslint-report.json
```

---

## Dependencies to Install

```bash
npm install --save-dev \
  eslint \
  @typescript-eslint/eslint-plugin \
  @typescript-eslint/parser \
  typescript-eslint \
  eslint-plugin-security \
  eslint-plugin-import-x \
  eslint-plugin-promise \
  eslint-plugin-sonarjs \
  eslint-plugin-no-secrets \
  eslint-config-prettier \
  prettier
```

---

## Non-Goals

- Running `lint:fix` on the codebase (config-only task — auto-fix is a separate follow-up)
- Failing CI builds (no CI yet; advisory local use only)
- Pre-commit hooks (not in scope)
- TODO/FIXME linting
- Any formatting rules in ESLint (Prettier owns all formatting)
- Building the structured logger (next task — `no-console` is `warn` until then)
- Refactoring existing code to fix violations (lint config only — code changes are separate tasks)

---

## Success Criteria

1. `eslint.config.mjs` created with all rules per this specification
2. `npm run lint`, `npm run lint:fix`, and `npm run lint:report` scripts work
3. `npm run format` and `npm run format:check` scripts work
4. `strict-type-checked` base config enabled with type-aware linting
5. All plugins installed and configured
6. `consistent-type-imports` enforced (auto-fixable)
7. Naming convention enforces variables/functions/types only (no property rules)
8. Circular dependency detection active via `import-x/no-cycle`
9. No formatting rules in ESLint (Prettier-only via `eslint-config-prettier`)
10. `require()` allowlist built from actual violations, not assumptions
11. `eslint-report.json` added to `.gitignore`
