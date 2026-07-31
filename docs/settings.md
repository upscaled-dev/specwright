# Settings reference

All settings use the `playwrightBddRunner.*` prefix. Open VS Code Settings with `Cmd+,` on macOS or `Ctrl+,` on Windows and Linux, then search for **Specwright**. You can also add settings to `.vscode/settings.json`.

<!-- Screenshot placeholder: ../images/specwright-settings.png
Show VS Code Settings filtered to Specwright. Include execution and authoring settings, but no credentials. -->

Use the defaults first. Most projects only need a change when they use a different package manager, a monorepo, non-standard step directories, or a custom `playwright-bdd` output directory.

## Run and discovery settings

| Setting | Default | Use it when… |
| --- | --- | --- |
| `playwrightCommand` | `npx playwright test` | Your project runs Playwright through another command, such as `pnpm exec playwright test`. |
| `bddgenCommand` | `npx bddgen` | You need a different code-generation command. Set it to an empty string when your Playwright configuration already runs `bddgen`. |
| `preRunCommand` | empty | A command must finish before every test run, for example to build fixtures. A non-zero exit stops the run. |
| `featuresGenDir` | `.features-gen` | Your `playwright-bdd` output directory differs from the default. This is needed for feature-file breakpoint mapping. |
| `workingDirectory` | inferred | Commands must run from a specific folder. By default, Specwright uses the nearest parent `playwright.config.*`, then the workspace folder. |
| `testFilePattern` | `**/*.feature` | Your feature files live outside the usual locations or use a narrower glob. This also controls the tag index. |
| `tags` | empty | You want every run to use a default `bddgen` tag expression, such as `@smoke and not @wip`. |
| `parallelExecution` | `false` | You want Specwright to pass a worker count to Playwright. This does not enable Playwright's `fullyParallel` mode. |
| `maxParallelProcesses` | `4` | You need a different Playwright worker count. Valid range: `1` to `16`. |
| `reporter` | `list` | You want a different terminal reporter, several reporters, or a custom reporter module. Specwright still obtains JSON results for mapping. |
| `useConfigReporters` | `false` | Your Playwright configuration already declares the reporters you want to run. It requires a bare `['json']` entry in that configuration. |
| `dryRun` | `false` | You want Playwright to list the tests that would run without executing them. |
| `enableCodeLens` | `true` | You need to hide Run and Debug links in feature files, for example because another extension supplies conflicting CodeLens items. |

## Step discovery and authoring settings

| Setting | Default | Use it when… |
| --- | --- | --- |
| `stepDefinitionPaths` | `features/steps/**/*.ts`, `features/steps/**/*.js`, `tests/steps/**/*.ts`, `steps/**/*.ts` | Your step definitions use another directory or file type. This setting is resource-scoped, so each monorepo package can use its own paths. |
| `stepDefinitionExcludePaths` | empty | Generated or report files look like step definitions. Built-in exclusions already cover `node_modules`, the generated features directory, `playwright-report`, and `test-results`. |
| `enableStepDefinitionNavigation` | `true` | You need to turn off Go to Definition from a feature step to its matching step definition. |
| `enableStepDiagnostics` | `true` | You need to turn off missing-step, ambiguous-step, and Scenario Outline diagnostics. |
| `enableStepsPanel` | `true` | You need to hide the Steps panel and release its index and file watchers. |
| `collapseMarkdownExportSections` | `false` | You export large step or scenario catalogs and want their collapsible sections closed initially. |

### Compatibility-mode settings

The following settings accept `auto`, `on`, or `off` and default to `auto`:

| Setting | Feature |
| --- | --- |
| `enableStepAutocomplete` | Step suggestions in feature files. |
| `enableTagAutocomplete` | Suggestions after `@`. |
| `enableStepHover` | Matching step-definition details on hover. |
| `enableStepReferences` | Find All References from a step definition. |
| `enableStepUsageCodeLens` | `Used N times` annotations above definitions. |
| `enableUnusedStepDiagnostics` | Information diagnostics for unused definitions. |
| `enableStepLiteralPromotion` | Refactor a literal into a `{string}`, `{int}`, or `{float}` parameter. |
| `enableTableFormatting` | Align Gherkin data tables with Format Document. |

`auto` enables the feature unless [Cucumber (Gherkin) Full Support](https://marketplace.visualstudio.com/items?itemName=alexkrechik.cucumberautocomplete) is installed. That avoids duplicate completions, hover cards, references, diagnostics, and formatting. Choose `on` to keep both extensions active, or `off` to disable the Specwright feature.

## Xray Cloud traceability settings

Xray support is experimental and available only for Xray Cloud. See [Xray traceability](traceability.md) before enabling remote workflows.

| Setting | Default | Use it when… |
| --- | --- | --- |
| `traceability.enablePanel` | `true` | You need to show or hide the Traceability panel. Disabling it also releases its watchers. |
| `traceability.provider` | `xray` | Selects the traceability backend. Xray is currently the only supported value. |
| `traceability.testTagPrefix` | `TEST_` | Your scenario-to-test tags use another prefix. For example, `@TEST_CALC-1043` maps to `CALC-1043`. |
| `traceability.reqTagPrefix` | `REQ_` | Your requirement-coverage tags use another prefix. |
| `xray.siteUrl` | empty | Sets the Jira/Xray Cloud host, such as `acme.atlassian.net`, for connection and issue links. |
| `xray.apiRegion` | `global` | Your Xray Cloud tenant is hosted in `us`, `eu`, or `au` rather than the global API region. It must match the tenant's region. |
| `xray.syncProjectKeys` | empty list | You always want selected project keys included when syncing remote metadata. |
| `xray.cacheTtlMinutes` | `15` | You need a longer or shorter freshness window for synced metadata. Stale data remains visible until you sync again. |
| `xray.defaultProjectKey` | empty | You want a project preselected when creating an Xray Test Execution. |
| `xray.executionIssueType` | `Test Execution` | Your Jira project maps Xray Test Executions to another standard-level work type. |
| `xray.reportGlob` | `playwright-report/**`, `test-results/**/*.zip` | You want different run-level report bundles suggested in the Publish dialog. Selected bundles are attached to the Jira execution issue after a successful import. |
| `xray.attachTo` | `evidence` | You want per-test evidence sent as Xray evidence, Jira issue attachments, or both. Valid values: `evidence`, `issue`, and `both`. |

## Examples

### Use pnpm in a monorepo

Place settings in the package folder that owns the Playwright configuration. Resource-scoped step paths then apply only to that package.

```jsonc
// packages/web/.vscode/settings.json
{
  "playwrightBddRunner.playwrightCommand": "pnpm exec playwright test",
  "playwrightBddRunner.bddgenCommand": "pnpm exec bddgen",
  "playwrightBddRunner.stepDefinitionPaths": ["tests/steps/**/*.ts"],
  "playwrightBddRunner.stepDefinitionExcludePaths": ["**/reports/**"]
}
```

### Match a custom `playwright-bdd` output directory

```jsonc
{
  "playwrightBddRunner.featuresGenDir": "generated/bdd-specs"
}
```

This setting is especially important when debugging a breakpoint set in a `.feature` file.

### Set a default tag expression

```jsonc
{
  "playwrightBddRunner.tags": "@smoke and not @wip"
}
```

The expression is passed to `bddgen`; only matching specs are generated for the run.

## Related guides

- [Getting started](getting-started.md)
- [Run and debug tests](runs.md)
- [Language features and Steps panel](features.md)
- [Xray traceability](traceability.md)
- [Troubleshooting](troubleshooting.md)
