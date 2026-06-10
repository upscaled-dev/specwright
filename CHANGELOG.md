# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]


## [0.1.2] - 2026-06-10
### Added

- Breakpoint support in `.feature` files: the breakpoint gutter is enabled for Gherkin, and when a debug run starts, feature-file breakpoints are mirrored onto the corresponding lines of the bddgen-generated spec (steps, `Scenario:` lines, and Examples rows), then cleaned up when the session ends. Shared lines (e.g. Background steps) are reference-counted across concurrent sessions.
- New setting `playwrightBddRunner.featuresGenDir` (default `.features-gen`) for locating bddgen output when `outputDir` is customized.
- Dev container configuration for reproducible development environments.

### Changed

- Debug runs now execute `bddgen` as a separate step before launching the debugger, so generated specs (and breakpoint mappings) are always fresh; only the `playwright test` half runs under the `node-terminal` session.
- `npm run package:vsix` now bumps the patch version on every run and writes the `.vsix` to `packages/` (which survives `npm run clean`) with the git SHA and a dirty marker in the filename, so successive dev packages are traceable.
