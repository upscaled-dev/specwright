# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Fixed

- Windows: shell arguments were quoted POSIX-style, but `cmd.exe` does not treat backslash as an escape character — the extra backslashes leaked through to Playwright verbatim. This corrupted any `--grep` pattern containing regex escapes (a title with a `.` matched nothing) and doubled the backslashes in precise `spec.js:line` targets, silently degrading a single Scenario Outline example-row run into a whole-outline `--grep` that fanned out across all Playwright workers (one browser per worker). Quoting is now platform-aware: `CommandLineToArgvW` rules on Windows, POSIX escaping elsewhere.
- When a single example-row run cannot be targeted by its generated spec line, the fallback to the outline-title `--grep` (which runs **all** example rows) is no longer silent: a warning in the Specwright output channel names the exact reason (no generated spec at the expected path, unmapped line, feature outside the working directory).
- Test Explorer: running a feature file or a Scenario Outline node now marks all its descendant scenarios as running while the command executes, instead of showing only the clicked node spinning and then surfacing N results at once.
- CI: the windows-latest unit-test job (red since v0.2.1) — `canonicalCwd` used the host's `path.normalize`, which rewrote the POSIX test paths with backslashes on Windows runners. It now pins `path.win32`/`path.posix` to its `isWindows` flag (identical behavior at runtime, deterministic under test).

### Changed

- Marketplace display name is now "Specwright BDD - Playwright-BDD Test Explorer".

## [0.2.2] - 2026-06-15
### Fixed

- Running or debugging a single Scenario Outline example row now targets exactly that row. playwright-bdd substitutes the example values into each generated test title, so no `--grep` on the source title (which still holds the raw `<placeholders>`) can isolate one row: it either matched every expanded row of the outline (and every row of any same-named outline) or, when the row's full label was used, matched nothing ("no results attributed to … add its path to defineBddConfig"). Runs and debugs now resolve the precise generated test via `<generatedSpec>:<pwTestLine>` from the spec's `bddFileData` line map, falling back to the previous name `--grep` only when no line can be resolved.
- The Test Explorer run path now runs `bddgen` as its own step before Playwright (mirroring the debug path), so the generated spec — and the line map used for the targeting above — is fresh even immediately after editing a feature. As a side effect, bddgen generation errors are surfaced to the Problems panel independently of test pass/fail.

## [0.2.1] - 2026-06-15
### Added

- New setting `playwrightBddRunner.useConfigReporters` (default `false`): run the reporters declared in your Playwright config instead of the extension injecting its own `--reporter` flags, so a custom reporter (e.g. one with a runtime-computed output path) runs alongside the extension's Test Results panel. Add a bare `['json']` entry (no `outputFile`) to your config's `reporter` array — the extension steers it to its temp file via `PLAYWRIGHT_JSON_OUTPUT_NAME` and parses that for result mapping.

### Fixed

- Scenario Outlines whose title contains placeholders (e.g. `Scenario Outline: Login as <role>`) failed to run on Windows ("cannot find the tests"). playwright-bdd substitutes the placeholders in the generated test titles, and `<`/`>` are redirection operators in `cmd.exe`/PowerShell, so the `--grep` was mangled and matched nothing. The grep now wildcards `<…>` placeholders to `.*`, which matches the expanded example titles and removes the shell-hostile characters.
- Windows: scenario results were not attributed back to their feature, so scenarios showed as skipped behind a false "outside the playwright-bdd `features` scope" warning. VS Code's `uri.fsPath` lowercases the drive letter (`c:\`) while Playwright's JSON report uses uppercase (`C:\`); the extension compared those paths verbatim. Path keys and comparisons now canonicalize the drive letter, and the spawned working directory is normalized the same way.


## [0.2.0] - 2026-06-12
### Fixed

- Test Explorer runs no longer hang after the tests finish. The run resolved only when every stdio pipe closed; a process that inherited them and outlived `playwright test` (a `webServer`, a browser/driver process — common on Windows) kept the run spinning forever. The run now settles shortly after the command exits (results are read from the JSON report file, so trailing pipe output isn't needed).
- Debug runs no longer hang after the tests finish in pnpm monorepos. Completion relied on the last child debug session terminating, which stops the lingering `node-terminal` parent; pnpm's extra node layers can leave a debug-attached child alive (or never attach one), wedging that chain forever. A watchdog now watches for the Playwright JSON report — written only after the tests complete, so sitting at a breakpoint can never trip it — and force-stops the session if it hasn't settled shortly after the report appears.


## [0.1.12] - 2026-06-12
### Fixed

- Step-definition discovery is now hard-restricted to TypeScript/JavaScript sources (`.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`). Whatever the configured globs match, report logs and `.html`/`.txt`/`.json` attachments that echo `Given("...")` calls are never parsed as step-definition files.


## [0.1.11] - 2026-06-12
### Fixed

- Step *invocations* are no longer mistaken for step *definitions*, regardless of what directory they live in (generated specs, reports, test-results). The extractor now only accepts calls that actually *register a handler*: it skips files stamped with bddgen's `// Generated from:` header, calls prefixed with `await`/`return`/`yield`, handler-less calls like `Given("text")` (e.g. code echoed into report logs), and bddgen's fixture-passing shape `Given("text", null, { page })`. This removes spurious "Step matches multiple definitions" warnings at the source, with zero configuration, even when such files match the discovery globs or are open in the editor.
- Feature-file scanning (Test Explorer discovery, the step-usage index behind "Used N times"/unused-step diagnostics, and tag autocompletion) now applies the same built-in excludes as step discovery — `node_modules`, the generated `featuresGenDir`, `playwright-report`, `test-results`. Copies of executed feature content inside generated/report directories no longer surface as duplicate tests, inflate usage counts, or pollute tag suggestions.
- Windows: the step-usage-index and tag-index file watchers filtered `node_modules` events with a platform-dependent separator check that never matched on Windows; they now normalize paths before filtering.
- Report tools that attach the test sources (e.g. Playwright's HTML report with a custom output folder) mirror the source tree, producing literal copies of step-definition files like `reports/e2e/steps/login.steps.ts`. Such copies are now detected structurally — identical definitions at identical lines plus a path that ends with the original's workspace-relative path — and dropped from step-definition loading, so they no longer trigger "Step matches multiple definitions". Files that merely share patterns without the nested-path relationship are kept (that's a genuine runtime ambiguity worth flagging).
- Monorepo + pnpm: runs no longer fail with "bddgen not found". When `workingDirectory` is unset, the cwd for `bddgen`/`playwright` is now inferred per run — the directory of the nearest `playwright.config.*` above the feature file (falling back to the file's workspace folder) — instead of always the first workspace folder root. pnpm links binaries only into the declaring package's `node_modules/.bin` (no hoisting), so `npx bddgen` from the repo root found nothing and fell back to the npm registry. An explicit `workingDirectory` setting still wins.


## [0.1.10] - 2026-06-12
### Added

- New setting `playwrightBddRunner.stepDefinitionExcludePaths` (resource-scoped, default `[]`): extra glob patterns excluded from step-definition discovery, merged with the built-in excludes (`node_modules`, the generated `featuresGenDir`, `playwright-report`, `test-results`). Use it to exclude generated or report directories whose files contain `Given/When/Then` invocations that would otherwise be mistaken for step definitions and produce spurious "Step matches multiple definitions" warnings.


## [0.1.9] - 2026-06-12
### Fixed

- Monorepo: step-definition discovery is now scoped per workspace folder. `playwrightBddRunner.stepDefinitionPaths` is `resource`-scoped, so each package can declare its own step directories in its `.vscode/settings.json`, and each folder's globs are resolved against that folder (no more bleeding across packages or being forced into a broad `**/` glob).
- Monorepo: discovery now excludes the generated `featuresGenDir` (default `.features-gen`) plus `playwright-report` and `test-results`. bddgen's generated `*.spec.js` files contain `Given/When/Then` invocations that are indistinguishable from step definitions, so scanning them produced phantom duplicates and spurious "Step matches multiple definitions" warnings. They are now never scanned for step defs.


## [0.1.8] - 2026-06-12
## [0.1.7] - 2026-06-11
## [0.1.6] - 2026-06-10
### Fixed

- Windows: Test Explorer statuses now map correctly after runs — Playwright JSON report keys and their lookups are canonically forward-slash on all platforms (previously Windows users could get blank or wrong pass/fail icons).
- Windows: node_modules watcher events no longer invalidate the step-file cache (separator-dependent filter).
- Windows: step-definition generation keeps absolute glob prefixes instead of falling back to the default steps directory.


## [0.1.5] - 2026-06-10
### Fixed

- Debugging from the Test Explorer now hits feature-file breakpoints: the debug run profile creates a real test run and stays alive until the debug session ends.
- The debugger now disconnects automatically when the test process exits (the `node-terminal` parent session is stopped once its last child session terminates) and mirrored breakpoints are reliably cleaned up afterwards.
- Test Explorer and feature-file gutter icons now show the real pass/fail/skipped outcome after a debug run, via a file-based Playwright JSON report captured from the debugged command.
- `npm ci` works on fresh checkouts again: package-lock.json was stale (old package name, wrong `@types/node` major, missing `@playwright/test`).

### Added

- Dev container is now tested and functional: Electron/VS Code system libraries and xvfb for integration tests, `ELECTRON_DISABLE_SANDBOX` for Chromium-in-Docker, and a named-volume overlay on `node_modules` so container installs don't break the host checkout.


## [0.1.2] - 2026-06-10
### Added

- Breakpoint support in `.feature` files: the breakpoint gutter is enabled for Gherkin, and when a debug run starts, feature-file breakpoints are mirrored onto the corresponding lines of the bddgen-generated spec (steps, `Scenario:` lines, and Examples rows), then cleaned up when the session ends. Shared lines (e.g. Background steps) are reference-counted across concurrent sessions.
- New setting `playwrightBddRunner.featuresGenDir` (default `.features-gen`) for locating bddgen output when `outputDir` is customized.
- Dev container configuration for reproducible development environments.

### Changed

- Debug runs now execute `bddgen` as a separate step before launching the debugger, so generated specs (and breakpoint mappings) are always fresh; only the `playwright test` half runs under the `node-terminal` session.
- `npm run package:vsix` now bumps the patch version on every run and writes the `.vsix` to `packages/` (which survives `npm run clean`) with the git SHA and a dirty marker in the filename, so successive dev packages are traceable.
