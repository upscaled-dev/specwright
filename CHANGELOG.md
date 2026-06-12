# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
