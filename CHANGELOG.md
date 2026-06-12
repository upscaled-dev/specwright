# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]




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
