# Settings reference

All settings live under `playwrightBddRunner.*` in your VS Code Settings (`Cmd/Ctrl+,`) or `.vscode/settings.json`.

## Settings table

| Setting | Type | Default | Notes |
|---|---|---|---|
| `playwrightCommand` | string | `npx playwright test` | Use `pnpm exec playwright test`, `yarn playwright test`, etc. as appropriate. |
| `bddgenCommand` | string | `npx bddgen` | Set empty to skip codegen if your `playwright.config.ts` already runs `bddgen` via `defineBddProject`. |
| `preRunCommand` | string | `` | Command to run before each test execution (e.g. `npm run build:fixtures`). Empty disables. A non-zero exit aborts the run and writes the error to the output channel. |
| `workingDirectory` | string | `` (workspace root) | Override if your playwright config isn't at the workspace root. |
| `testFilePattern` | string | `**/*.feature` | Glob for feature-file discovery. Also used by tag autocompletion. |
| `tags` | string | `` | Default tag expression, e.g. `@smoke and not @wip`. |
| `parallelExecution` | boolean | `false` | Adds `--workers=<maxParallelProcesses>` to Playwright. |
| `maxParallelProcesses` | number (1–16) | `4` | Worker count when parallel is enabled. |
| `reporter` | enum | `list` | One of `list`/`line`/`dot`/`html`/`json`/`junit`. The JSON reporter is appended in addition, for result mapping. |
| `dryRun` | boolean | `false` | Passes `--list` to Playwright. |
| `enableCodeLens` | boolean | `true` | Run/debug CodeLens on feature files. Disable if conflicting with another extension. |
| `enableStepDefinitionNavigation` | boolean | `true` | Go to Definition from a Gherkin step to its TypeScript step definition. |
| `enableStepDiagnostics` | boolean | `true` | Master switch for the unmatched-step, ambiguous-step, and Scenario Outline diagnostics in `.feature` files. |
| `enableStepAutocomplete` | `auto` / `on` / `off` | `auto` | Suggest existing playwright-bdd step definitions when typing a step. |
| `enableTagAutocomplete` | `auto` / `on` / `off` | `auto` | Suggest existing tags when typing `@`. |
| `enableStepHover` | `auto` / `on` / `off` | `auto` | Show the matching step-definition pattern and source location when hovering a step. |
| `enableStepReferences` | `auto` / `on` / `off` | `auto` | Find All References on a step definition lists every matching Gherkin step. |
| `enableStepUsageCodeLens` | `auto` / `on` / `off` | `auto` | `Used N times` CodeLens above each `Given/When/Then` definition. |
| `enableUnusedStepDiagnostics` | `auto` / `on` / `off` | `auto` | Information diagnostic on step definitions that no `.feature` step matches. |
| `enableStepLiteralPromotion` | `auto` / `on` / `off` | `auto` | Refactor: promote a hard-coded literal in a step to a `{string}`/`{int}`/`{float}` parameter, updating both files. |
| `enableTableFormatting` | `auto` / `on` / `off` | `auto` | Auto-align Gherkin data tables on Format Document. |
| `stepDefinitionPaths` | string[] | `["features/steps/**/*.ts", "features/steps/**/*.js", "tests/steps/**/*.ts", "steps/**/*.ts"]` | Globs for step-definition lookup. Used by navigation, autocompletion, references, the CodeLens, the unused-step diagnostic, the literal-promotion refactor, and the generator. |

Per-feature deep dives: [features.md](features.md).

## `auto` / `on` / `off` semantics

Eight providers in this extension share a tri-state setting because they overlap with the [Cucumber (Gherkin) Full Support](https://marketplace.visualstudio.com/items?itemName=alexkrechik.cucumberautocomplete) extension:

| Setting | Provider |
|---|---|
| `enableStepAutocomplete` | Step completions on Gherkin step lines |
| `enableTagAutocomplete` | Tag completions on `@`-prefix |
| `enableStepHover` | Hover tooltip on Gherkin steps |
| `enableStepReferences` | Find All References on step definitions |
| `enableStepUsageCodeLens` | "Used N times" CodeLens |
| `enableUnusedStepDiagnostics` | Unused-step Information diagnostic |
| `enableStepLiteralPromotion` | Promote literal to parameter refactor |
| `enableTableFormatting` | Format Document for data tables |

Each setting accepts three values:

- **`auto`** (default) — registers the provider only when `alexkrechik.cucumberautocomplete` is **not** installed. Auto-defers when it is, so the IntelliSense list, Problems panel, References panel, and formatter never produce duplicates.
- **`on`** — always register. Keeps both providers active. Use this when you want both extensions to contribute (each entry from this extension has `detail` prefixed with `Playwright-BDD` so you can tell them apart).
- **`off`** — never register. Use this to defer to cucumberautocomplete unconditionally, or to disable the feature entirely.

## Cucumberautocomplete coexistence

The auto-defer detection uses VS Code's `vscode.extensions.getExtension("alexkrechik.cucumberautocomplete")` and re-evaluates on `vscode.extensions.onDidChange`, so installing or uninstalling cucumberautocomplete mid-session re-reconciles every `auto`-mode provider without a window reload.

The `enableCodeLens`, `enableStepDefinitionNavigation`, and `enableStepDiagnostics` settings are plain booleans because they don't overlap with cucumberautocomplete's surface (run/debug CodeLens, navigation that targets playwright-bdd specifically, and our distinct diagnostic codes).
