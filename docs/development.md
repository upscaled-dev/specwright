# Development

## Build, test, run

```bash
npm install
npm run watch              # esbuild + tsc in parallel
npm test                   # vitest (unit tests)
npm run test:integration   # @vscode/test-electron (extension host)
npm run lint
npm run build              # clean + compile + bundle
```

Unit tests use [Vitest](https://vitest.dev/) with a minimal stub of the `vscode` module under [src/test/__mocks__/vscode.ts](../src/test/__mocks__/vscode.ts). Tests that need real VS Code APIs (`TestController`, `TestItem` trees, run-profile registration) run via `npm run test:integration`, which launches a real VS Code instance against a fixture workspace under [src/test/integration/fixtures/workspace/](../src/test/integration/fixtures/workspace/). See [CONTRIBUTING.md](../CONTRIBUTING.md#integration-tests) for details.

## Releasing

Use the release script — it bumps the version, updates `CHANGELOG.md`, runs the full pipeline, packages the `.vsix`, and creates a git commit + tag. It stops before pushing so you can review.

```bash
npm run release            # default: patch bump
npm run release:patch
npm run release:minor      # 0.1.0 → 0.2.0
npm run release:major      # 0.1.0 → 1.0.0
npm run release:dry-run    # preview without changing anything
```

Or with explicit version:

```bash
node scripts/release.mjs --version 0.5.0
```

After the script completes:

```bash
git show v0.1.1             # review the release commit
ls -la dist/                # see the .vsix
git push && git push origin v0.1.1
npx vsce publish --packagePath dist/specwright-0.1.1.vsix
```

The script refuses to run when the git working tree is dirty, when there are no commits yet, or when the tag already exists. Source: [scripts/release.mjs](../scripts/release.mjs).

## DevContainer

[.devcontainer/devcontainer.json](../.devcontainer/devcontainer.json) gives you a reproducible Node 20 environment. To use it: install VS Code's "Dev Containers" extension, then run **Dev Containers: Reopen in Container** from the command palette. The container runs `npm ci` automatically on first start.

Useful when:
- Your host node version diverges from the project's target.
- You want CI-like isolation while iterating.
- You're triaging a "works on my machine" report.

The DevContainer is intentionally tool-agnostic — it ships only what the project needs (Node + git + ESLint extension). Bring your own AI assistant, debugger, or other tooling.

## Project layout

```
src/
  extension.ts                            # activation, wiring
  commands/
    command-manager.ts                    # registers all playwrightBddRunner.* commands
    generate-steps.ts                     # orchestrates "Generate Missing Step Definitions"
    prompt-worker-count.ts                # QuickPick + persistence for parallel-profile workers
  core/
    extension-config.ts                   # reads playwrightBddRunner.* settings
    command-builder.ts                    # composes `bddgen && playwright test …`
    test-executor.ts                      # runs in terminal + spawns for JSON parsing
    breakpoint-mirror.ts                  # mirrors .feature breakpoints onto generated specs for debug
    test-discovery-manager.ts             # globs + caches .feature files
    test-organization.ts                  # 5 tree-grouping strategies
    provider-registry.ts                  # owns lifecycle of reactive providers
  generators/step-stub-generator.ts       # pure: parameter inference, keyword normalization, stub formatting
  parsers/
    feature-parser.ts                     # Gherkin parser
    bdd-file-data-parser.ts               # extracts the bddFileData block from generated specs
    tag-regex.ts                          # shared @tag pattern source
  providers/
    scenario-boundary.ts                  # shared SCENARIO_BOUNDARY_RE constant
    step-keywords.ts                      # single source of truth for Gherkin step-keyword alternation
    step-definition-provider.ts           # .feature step → .ts definition (Go to Definition)
    step-resolver.ts                      # file-walking + matching with mtime cache + file-list watcher
    step-completion-provider.ts           # snippet completions on step lines
    pattern-humanizer.ts                  # regex → {int}/{string} normalization for completions
    tag-completion-provider.ts            # @-prefix completions sourced from tag-index
    tag-line-detector.ts                  # pure tag-line context detection
    tag-index.ts                          # workspace-wide tag pool + file watcher
    step-hover-provider.ts                # hover tooltip with matching def pattern + source link
    step-reference-provider.ts            # Find All References from a step def into .feature files
    step-usage-codelens-provider.ts       # "Used N times" CodeLens above each Given/When/Then
    step-usage-index.ts                   # shared usage index used by references / CodeLens / unused diagnostic
    unused-step-diagnostics-provider.ts   # Information diagnostic on never-matched step defs
    step-diagnostics-provider.ts          # unmatched / ambiguous / outline diagnostics in .feature files
    step-code-action-provider.ts          # quick-fixes for unmatched and ambiguous steps
    step-literal-promotion-provider.ts    # refactor: literal → {string}/{int}/{float}
    step-literal-promotion-helpers.ts     # pure helpers for the literal-promotion refactor
    feature-document-symbol-provider.ts   # outline / breadcrumb support
    feature-table-formatter.ts            # Format Document aligner for Gherkin data tables
    feature-table-formatter-helpers.ts    # pure helpers for the table formatter
    feature-skip-ranges.ts                # doc-string / table / examples skip-range computation
    bddgen-diagnostics-provider.ts        # republishes bddgen errors as .feature diagnostics
    bddgen-error-parser.ts                # pure bddgen-output → diagnostic-location parser
  ui/
    status-bar.ts                         # left-side status item: idle / running / last result
  test-providers/
    playwright-bdd-test-provider.ts       # bridges Test Explorer to playwright-bdd
    group-scenarios.ts                    # pure scenario-grouping function (vitest-covered)
    constants.ts                          # shared OUTLINE_ID_SEPARATOR constant
  utils/
    playwright-json-parser.ts             # parses Playwright JSON reporter
    logger.ts
    shell.ts                              # shell-safe quoting
    workspace-path.ts                     # shared toWorkspaceRelative helper
    cucumber-autocomplete-detector.ts     # checks for alexkrechik.cucumberautocomplete
  test/
    __mocks__/vscode.ts                   # vitest mock of `vscode`
    unit/*.test.ts                        # vitest unit tests
    integration/                          # @vscode/test-electron suites
features/                                 # sample Gherkin + TS steps
playwright.config.ts                      # sample playwright-bdd config
snippets/gherkin.code-snippets            # contributed Gherkin snippets
scripts/
  build/esbuild.cjs                       # bundler config
  release.mjs                             # release / version-bump script
.devcontainer/                            # reproducible Node 20 container
```

## Architectural notes

- **Providers register through `ProviderRegistry`** ([src/core/provider-registry.ts](../src/core/provider-registry.ts)), which is the single owner of provider lifecycle. It reconciles "current state → desired state" on config change and on extension change, so toggling any setting attaches/detaches the right providers without a window reload.
- **Shared `StepResolver` and `StepUsageIndex`** are reference-counted across consumers (Find References + Usage CodeLens + Unused diagnostic share one index). Indexes dispose only when the last consumer's setting flips off, preventing watcher leaks.
- **Pure helpers live in their own modules** (`pattern-humanizer.ts`, `tag-line-detector.ts`, `feature-table-formatter-helpers.ts`, `bddgen-error-parser.ts`, `step-literal-promotion-helpers.ts`) so vitest can exercise the logic without the `vscode` stub.
- **`parseFeatureSteps`** in [step-resolver.ts](../src/providers/step-resolver.ts) is the canonical Gherkin step walker — boundary-aware (`Scenario:` / `Background:` / `Rule:` / `Feature:` / `Example:` / `Scenario Template:`), used by every provider that needs effective-keyword resolution.
- **`shouldRegisterCompletion(mode, isCucumberAutocompletePresent())`** is the single pure helper that gates every `auto`/`on`/`off` provider. New providers with the same coexistence pattern should reuse it.

## Adding a setting or command

The repo has a convention for both (see the relevant `.claude/skills/*` markdown files locally if you use Claude Code; the procedure works without any tooling):

**Adding a setting**:
1. Declare it under `contributes.configuration.properties` in [package.json](../package.json).
2. Add a typed getter on [ExtensionConfig](../src/core/extension-config.ts).
3. Thread it to the consumer ([CommandBuilder](../src/core/command-builder.ts), a provider's `reconcile*` method, etc.).
4. Update [docs/settings.md](settings.md).

**Adding a command**:
1. Declare it under `contributes.commands` in [package.json](../package.json) (with `category: "Specwright"` so it groups properly in the command palette).
2. Register the handler in [CommandManager](../src/commands/command-manager.ts).
3. If it's discoverable from a context menu, add it to the relevant `contributes.menus` block.
4. Update [docs/runs.md](runs.md#commands).
