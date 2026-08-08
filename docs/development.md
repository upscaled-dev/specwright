# Development

## Build, test, run

```bash
npm install
npm run watch              # esbuild + tsc in parallel
npm test                   # vitest (unit tests)
npm run test:coverage      # unit tests plus enforced coverage floors
npm run test:contracts     # release artifact contract tests
npm run test:integration   # @vscode/test-electron (extension host)
npm run lint
npm run build              # clean + compile + bundle
```

Unit tests use [Vitest](https://vitest.dev/) with a minimal stub of the `vscode` module under [src/test/__mocks__/vscode.ts](../src/test/__mocks__/vscode.ts). Tests that need real VS Code APIs (`TestController`, `TestItem` trees, run-profile registration) run via `npm run test:integration`, which launches a real VS Code instance against a fixture workspace under [src/test/integration/fixtures/workspace/](../src/test/integration/fixtures/workspace/). See [CONTRIBUTING.md](../CONTRIBUTING.md#integration-tests) for details.

## Releasing

Release only from protected `main` and protect tags matching `v*` in the repository settings. The workflow cannot administer or prove those rules with its token, so verify both rules before the first release and after repository-policy changes. The workflow uses read-only repository permissions; only the tag-only promotion job receives `actions: read`, `id-token: write`, and `attestations: write`.

The release script bumps `package.json` and `package-lock.json` together, updates `CHANGELOG.md`, and runs the source gates. It then creates the release commit before building so the artifact manifest can name the exact commit. After that it builds production once, validates the package inventory, packages one VSIX, runs integration tests against that bundle, installs the VSIX into a clean extension profile, discovers a fixture scenario, and verifies that the VSIX SHA-256 did not change. The tag is created only after every gate passes.

The release artifact set contains the VSIX, its checksum, a CycloneDX SBOM, and a manifest with a `components` array. The manifest binds the source commit, component version, VSIX digest, and SBOM digest. The current component is the VS Code extension; future Core Service and execution-provider packages can add components without changing the manifest shape. Candidate and promoted artifact sets are retained for 90 days. Production source maps are excluded from the VSIX and retained as a separate CI artifact for 30 days. Restrict workflow-artifact access as part of the repository's release permissions.

## Core execution dependency

`legacy-direct` remains the execution default. An Extension Development Host may set `SPECWRIGHT_EXECUTION_ENGINE=core-client` to exercise the fail-closed preview selection. Workspace settings and workspace launch files cannot select an engine or replace its executable.

The repository does not contain a Core Service executable or Client Protocol schema. Enabling a real Core client requires Polywright to supply all of the following as one versioned release contract:

- a self-contained executable for each supported runtime identifier;
- a signed manifest binding runtime identifier, executable SHA-256, Core version, Client Protocol version, and schema profile;
- the canonical framing specification and generated TypeScript request, response, event, diagnostic, and error DTOs for that profile;
- protocol lifecycle rules for negotiation, session identity, ordering, size limits, cancellation, shutdown, and outcome-unknown starts.

Until those artifacts verify as one set, Core discovery, preparation, run, and debug fail with `execution.core-client.unavailable`. The extension does not fall back to `legacy-direct`. A TypeScript fake can later test client error containment against the supplied framing contract, but cannot satisfy Core lifecycle, provider supervision, or parity acceptance.

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
git show v0.1.1                         # review the release commit
cat dist/specwright-0.1.1.vsix.sha256  # digest of the local build only
git push origin main
# Wait for the successful main CI artifact named specwright-<release-commit>.
git push origin v0.1.1
```

The main workflow creates `specwright-<commit>` only after the quality, exact-version integration, package-content, installed-VSIX smoke, and digest gates pass. Push the release tag only after that hosted candidate exists. The tag workflow fails closed unless the tag matches the package version, its commit is on `main`, and a successful main CI run retained the matching candidate. It downloads that candidate without rebuilding, verifies the manifest commit and version plus the VSIX and SBOM digests, attests the same VSIX, and retains the unchanged set as `specwright-<tag>`.

Download `specwright-<tag>` and verify the VSIX against the checksum, SBOM, and manifest in that same download, then publish that VSIX. The local digest printed above identifies the local build and will not match the hosted build: `vsce` embeds timestamps, so each package run produces a distinct digest. Do not rebuild between hosted testing, tag promotion, download, and publication.

```bash
node scripts/release-artifact.mjs --verify \
  --out specwright-0.1.1.vsix \
  --commit "$(git rev-parse v0.1.1^{})" \
  --version 0.1.1
npx vsce publish --packagePath specwright-0.1.1.vsix
```

The verification command checks the checksum filename and digest, manifest schema, source commit, component version and digest, and SBOM filename and digest before publication.

The script refuses a dirty tree, missing commit, or existing tag. If an artifact gate fails after the release commit, no tag is created and the script removes the release commit again, so a rerun starts from the same version. Before push, delete an unwanted tag with `git tag -d v0.1.1` and remove its commit with `git reset --hard HEAD~1`. After publication, keep the previous promoted artifact set, revert the faulty change, cut a new patch, and provide the previous VSIX and checksum for explicit downgrade while the correction is validated. `npm run release:dry-run` exercises the release and rollback command plan without changing Git or package files. A real promotion, Marketplace rollback, artifact download, and protected-ref audit require authenticated repository administration and remain manual acceptance steps.

The 22-file package allowlist lives in [scripts/package-contents.json](../scripts/package-contents.json). Update it deliberately when shipping a new file. Source: [scripts/release.mjs](../scripts/release.mjs) and [scripts/release-artifact.mjs](../scripts/release-artifact.mjs).

## DevContainer

[.devcontainer/devcontainer.json](../.devcontainer/devcontainer.json) gives you a reproducible Node 20 environment. To use it: install VS Code's "Dev Containers" extension, then run **Dev Containers: Reopen in Container** from the command palette. The container runs `npm ci` automatically on first start.

Useful when:
- Your host node version diverges from the project's target.
- You want CI-like isolation while iterating.
- You're triaging a "works on my machine" report.

The DevContainer is intentionally tool-agnostic: it ships only what the project needs (Node + git + ESLint extension). Bring your own AI assistant, debugger, or other tooling.

## Project layout

```
src/
  extension.ts                            # activation, wiring
  commands/
    command-manager.ts                    # registers all playwrightBddRunner.* commands; run/debug handlers
    traceability-commands.ts              # traceability hub: board, sync, project scope; owns the two below
    traceability-link-commands.ts         # link/unlink/create-from-scenario, tag writes, board mutations
    traceability-publish-commands.ts      # run+publish, publish last run, attachments, run history
    traceability-authoring-commands.ts    # bulk create, container create, push flows
    captured-run-progress.ts              # cancellable editor-run notification + live counts
    generate-steps.ts                     # orchestrates "Generate Missing Step Definitions"
    insert-step.ts                        # "Insert Step…" snippet builder + QuickPick
    export-catalogs.ts                    # orchestrates Export Steps / Export All Scenarios
    prompt-worker-count.ts                # QuickPick + persistence for parallel-profile workers
  core/
    extension-config.ts                   # reads playwrightBddRunner.* settings
    command-builder.ts                    # composes `bddgen && playwright test …`
    test-executor.ts                      # runs in terminal + spawns for JSON parsing
    live-run-session.ts                   # owns one reporter side-channel lifecycle
    live-run-stream.ts                    # tails reporter JSONL and maps generated source lines
    run-progress.ts                       # scoped live-result observer contract
    breakpoint-mirror.ts                  # mirrors .feature breakpoints onto generated specs for debug
    test-discovery-manager.ts             # globs + caches .feature files
    test-organization.ts                  # 5 tree-grouping strategies
    provider-registry.ts                  # owns lifecycle of reactive providers
  generators/step-stub-generator.ts       # pure: parameter inference, keyword normalization, stub formatting
  exporters/
    steps-markdown.ts                     # pure: renders the Export Steps catalog
    scenarios-markdown.ts                 # pure: renders the Export All Scenarios catalog
    markdown-slugger.ts                   # pure: GitHub-style anchor slugs for the exports' TOC
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
    step-usage-index.ts                   # shared usage index used by references / CodeLens / unused diagnostic / Steps panel
    steps-tree-data-provider.ts           # the Activity Bar "Steps" tree view (definitions + unmatched steps)
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
    live-test-run-progress.ts             # applies terminal results to an open TestRun
    specwright-live-reporter.ts           # bundled Playwright reporter for live result events
    group-scenarios.ts                    # pure scenario-grouping function (vitest-covered)
    constants.ts                          # shared OUTLINE_ID_SEPARATOR constant
  utils/
    playwright-json-parser.ts             # parses Playwright JSON reporter
    logger.ts
    shell.ts                              # shell-safe quoting
    workspace-path.ts                     # shared toWorkspaceRelative helper
    working-dir.ts                        # per-run cwd inference + drive-letter canonicalization
    discovery-excludes.ts                 # shared built-in discovery excludes
    cucumber-autocomplete-detector.ts     # checks for alexkrechik.cucumberautocomplete
  test/
    __mocks__/vscode.ts                   # vitest mock of `vscode`
    unit/*.test.ts                        # vitest unit tests
    unit/fixtures/                        # .feature.txt snapshots for parser tests, off the discovery glob
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
- **`parseFeatureSteps`** in [step-resolver.ts](../src/providers/step-resolver.ts) is the canonical Gherkin step walker, boundary-aware (`Scenario:` / `Background:` / `Rule:` / `Feature:` / `Example:` / `Scenario Template:`), used by every provider that needs effective-keyword resolution.
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
2. Register it in [CommandManager](../src/commands/command-manager.ts): every command id stays in its registration table. Run/debug handler bodies live there too; traceability handler bodies belong in the module that owns the flow ([traceability-commands.ts](../src/commands/traceability-commands.ts) for board/sync, its link module for tag and link flows, its publish module for run+publish), with CommandManager delegating.
3. If it's discoverable from a context menu, add it to the relevant `contributes.menus` block.
4. Update [docs/runs.md](runs.md#commands).
