# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Long runs now report each scenario as soon as it finishes.** Test Explorer items, the Test Results output, the status bar, and editor-run progress update while Playwright is still active. The final JSON report still reconciles the completed run. Feature and scenario runs started from CodeLens or editor menus now show a cancellable progress notification too.

## [0.4.44] - 2026-07-31
### Added

- **Run Locally and Publish can run a selected set of mapped scenarios.** Cmd/Ctrl-select scenario rows in the Traceability tree, then right-click one selected row and run the existing command to execute that selection as one batch before the Publish workflow opens. The single-row and all-mapped shortcuts still work as before.

## [0.4.43] - 2026-07-31
### Added

- **The connection test confirms which Jira account you are using.** Test Connection now asks Jira who the stored email and API token authenticate as before it lists projects, and reports "Jira authenticated as \<name\>" in its result. A token that Jira refuses is named at that point, with the site's own reason, instead of surfacing later as an empty project list.

### Changed

- **A failed connection test says what actually happened.** Every failure past the login used to read "Xray GraphQL probe failed (non-OK status or GraphQL errors)". The result now distinguishes a data host that rejects an authenticated call (pointing at `playwrightBddRunner.xray.apiRegion` and the site's Xray license), a rate limit that asks you to wait a minute, a permission refusal quoting Xray's own error, and any other status quoting the server's reply.
- **The Xray setup panel's connection dot no longer shows green when data calls fail.** A connection that authenticated but could not run a single query used to keep the green dot. It now shows red with "Authenticated, but Xray data calls failed", so the dot and the message agree.
- **A rejected request writes the server's own reply to the output channel.** Xray and Jira refusals were logged as the shape of the response body, which meant diagnosing a failure outside the editor. The body is now logged as sent, after credentials, tokens, and the basic-auth header are masked out and any token-like text is scrubbed, clipped to one readable line.
- The "nothing to publish" message now reads "No local runs to publish yet. Run mapped scenarios first.", matching the vocabulary the rest of the publish surface uses.

### Fixed

- **Closing the coverage board cancels a publish in flight.** A publish used to keep importing results and uploading attachments after the board was gone. Cancellation now reaches the result import and every attachment upload: the work stops at the next file, the report names each attachment still pending, and a cancel that lands after the import completed still names the execution it created.
- **The publish dialog reports a failed issue search instead of showing no matches.** A search that failed (missing Jira credentials, a network or permission problem) emptied the result list, which reads exactly like "no such issue". The list now carries the reason, and the project field still offers the keys already known locally.
- A gateway error page no longer becomes the text of a publish failure toast. An HTML response falls back to the plain status, and the page itself is in the output channel.
- Connection failures name their underlying cause (a refused connection, a certificate rejection, a proxy fault) rather than only "fetch failed".
- **A project key that collides with a JQL reserved word no longer breaks sync, search, or the connection test.** A key such as IS went out as a bare word, and Jira refuses a reserved word that is not surrounded by quotation marks, so that project's tests could not be synced or searched, and its connection probe reported no counts. Project keys and issue keys now go out quoted, so any key a project uses is accepted.

## [0.4.42] - 2026-07-30
### Added

- **The Coverage Board's Mapping tab filters and pages each list on its own.** Untraced scenarios, available tests, and mapped tests each get a filter box and a paginator, so a workspace with hundreds of cards no longer paints all of them into one long scroll. A column filter narrows only its own list and combines with the board's header search: the scenario list matches on scenario name, both test lists match on key or summary. A **Rows** dropdown above the columns sets how many cards every list shows (25, 50, or 100, starting at 50) and is remembered per workspace. Each section header counts what it holds, its paginator reads "1-50 of 130" over what the filter left, and a list emptied by a query says "No matches." instead of its nothing-to-map line. The three sections are built from one layout, so headers, buttons, filter boxes, and paginators line up across both columns.

### Changed

- **The Executions tab groups its history under the execution it belongs to.** Every publish used to be a top-level row, so an execution published to more than once appeared several times over with nothing tying those rows together. Each execution is now one row carrying its summary, its most recent date, and how many entries it holds; expanding it lists each create or append beneath it, newest first. A group you collapse stays collapsed as the board repaints, a search opens the groups it matched and shows each one's whole history, and an entry whose import named no execution stays a row of its own.

### Fixed

- **Appending results to an existing execution no longer rewrites its dates.** An appended run carried an information block describing that run, which Xray turns into an update of the execution issue's start and finish date fields: adding a run overwrote the dates already recorded on the execution, and the whole import was rejected when the execution's work type has no such fields on its edit screen (a Sub-Test Execution, for instance, failed with "Field 'customfield_…' cannot be set"). An append now sends only the execution key and the results.
- **Appended example rows carry their label and a correct duration.** Each row of a Scenario Outline is added as an iteration of its test, but the durations went out in milliseconds into a field Xray reads as nanoseconds, so every row showed a time close to zero, and the iterations went out with no parameters at all. Each row now sends a nanosecond duration and an `example` parameter holding the row title Playwright reported, so the iteration table in Xray names its rows and shows their real times.
- A publish the server rejects reports its reason from Jira's error envelopes as well as Xray's own, with token-like text scrubbed out and a long message clipped to one readable line.

## [0.4.36] - 2026-07-29
### Fixed

- **The Test Explorer stop button now cancels a debug run.** Stop did nothing while a scenario was being debugged: the run kept spinning until the debug session was ended from the debug toolbar, and every later run was refused with "A test run is already in progress". Stop now ends the debug session, marks the tests that did not run as skipped, and closes the run, so the next run starts normally.
- Stopping a debug run while it is still generating specs ends the run quietly, instead of reporting the interrupted generation step as a failure.

## [0.4.35] - 2026-07-29
### Fixed

- **Traceability sync now judges each project on its own fetch.** A single project whose catalogue failed to load used to blank the verdicts for every project in scope, hiding healthy projects' unmapped tests and orphan rows; a failure now costs only its own project. A sync that fetched nothing and only reported errors keeps the previous data instead of presenting itself as freshly synced. Cached remote metadata is refetched once on the first launch after this release.
- A publish whose import response names no execution now says so. The imported count is still reported, no dead browse link is offered, and file attachments are skipped rather than recorded against an execution nothing can reach.
- A failed publish leaves the Publish tab on the run you picked, ready for a retry. The run list also stays current while the tab is open, so a run recorded in the meantime can be selected without reopening it.
- The Executions tab shows its empty line once the publish history is cleared, instead of an empty table frame.
- Reloading the window no longer leaves the Coverage Board blank when one of its panes fails to repaint. The remaining panes come back and the failure is logged to the output channel.
- The Coverage Board rebuilds when a setting it renders from changes (sync project keys, default project key, site URL), instead of showing the previous values until something else rebuilds it.

### Changed

- The packaged extension no longer carries the repository's internal working-agreement file.

## [0.3.9] - 2026-07-18
### Fixed

- **Windows: single-row targeting matched nothing, so nothing ran.** Playwright treats CLI file filters as regular expressions, and the `<spec>:<line>` target emitted in 0.3.8 used Windows path separators — `\b`, `\f` and friends are regex metacharacters there, so every targeted run ended in "no tests found" with all scenarios shown as possibly out of scope. Targets are now emitted with forward slashes on every platform.
- Safety net: when Playwright reports "no tests found" for a spec-line-targeted run, the run is retried once with the name-based `--grep` fallback — an unrecognized target (stale spec, path quirk) can no longer end a run with nothing executed.

## [0.3.8] - 2026-07-18
### Fixed

- **Single example-row runs no longer fan out to the whole Scenario Outline** when bddgen's output layout differs from the default. The generated-spec resolver now probes what bddgen actually wrote instead of assuming `<featuresGenDir>/<feature-path>.spec.js`:
  - specs nested under a named BDD project's directory (e.g. `.features-gen/browser/…` from `defineBddProject`) are found;
  - layouts shortened by a `featuresRoot` config are found by retrying with leading path segments stripped;
  - `.spec.ts` output (playwright-bdd v9) is recognized alongside `.spec.js`; when both exist, the newer file wins.
- Debug runs benefit from the same fix: breakpoint mirroring locates the generated spec in the layouts above.
- When the same feature is generated by multiple BDD projects, the run targets the newest spec and a warning names all candidates, the project actually targeted, and how to pin one via `playwrightBddRunner.featuresGenDir`.

## [0.3.7] - 2026-07-18
### Added

- **Richer Markdown catalog exports.** Feature and step catalogs now open with a branded masthead — the Specwright logo inlined in the heading plus headline counts (features/scenarios/tags, definitions/unused) — and close with a matching footer.
- **Browse by tag** section in scenario catalogs: each tag links to the features that carry it.
- **Unused** callout in step catalogs listing every never-referenced step definition in one place.
- Setting `playwrightBddRunner.collapseMarkdownExportSections` (default off) renders the collapsible sections collapsed by default, so large catalogs open as a scannable outline.

### Changed

- The Tags table in scenario catalogs is now two tag/count pairs per row, keeping long tag lists compact.

## [0.3.6] - 2026-07-17
## [0.3.0] - 2026-07-17
### Added

- **Steps panel.** A new "Specwright" container in the Activity Bar with a **Steps** view. Step definitions are grouped by `Given`/`When`/`Then` with a usage count and an unused marker on each; clicking one navigates to its `file:line`. An **Unmatched steps** section groups Gherkin steps that have no matching definition by feature file, with one-click scaffolding for a single step or a whole file.
- **Insert Step…** command — inserts a known step pattern into the active `.feature` file as a snippet, with a tab stop per parameter and `{string}` placeholders wrapped in quotes. Also available as an inline action on step-definition rows in the panel.
- **Export Steps** and **Export All Scenarios** commands — write Markdown catalogs (brand line, Summary section, linked Table of Contents, collapsible sections). The scenario export first asks for a scope — all features, by tag, or a multi-select of feature files — and records the active filter in its Summary; features with no matching scenarios are omitted.
- CodeLens Run/Debug links now render on the `Example:` and `Scenario Template:` Gherkin synonyms, alongside `Scenario:` and `Scenario Outline:`.
- Per-scenario durations in the Test Explorer, shown next to each scenario after a run.
- Actionable error hints when the `npx`, `playwright`, or `bddgen` binary is missing — a run that fails with a "command not found"/"is not recognized" shell error now names the binary and points at installing the project's dependencies, instead of surfacing only raw shell noise.
- New setting `playwrightBddRunner.enableStepsPanel` (default `true`): show or hide the Steps panel. Disabling it releases the panel and its share of the step-usage index.

### Changed

- The Test Explorer stop button now cancels the run: it kills the Playwright process tree (`taskkill /T` on Windows, process-group `SIGTERM` elsewhere), marks any not-yet-run items skipped, and no longer reports the killed subtree as failed.
- The `reporter` setting now also accepts a comma-separated list, the `github`/`blob`/`null` built-ins, and custom reporter module paths — validation checks each token rather than the whole string.
- The Feature-Based (hierarchical) view refreshes incrementally when a single `.feature` file is saved, re-reading just that file instead of re-globbing and re-parsing the whole workspace. Content-grouped views (tags, scenario type, flat) keep the full refresh.
- Run summaries in the Test Results panel report the run's measured wall-clock duration rather than the sum of per-scenario times (which double-counted multi-project and retried entries).
- The release script now bumps `package-lock.json` in lockstep with `package.json`, so a release commit no longer leaves the lockfile stale (the drift that dirtied the next `npm ci`/install).

### Fixed

- Flaky tests that fail then pass on retry now map to **passed**, matching Playwright's exit code, instead of showing as failed.
- A feature, Scenario Outline, or tag run that fails **before** producing any per-scenario results (e.g. a bddgen or compile error) now marks the parent item failed instead of leaving every scenario skipped and hiding the failure. The deliberate "no tests found" out-of-scope case is still explained as skipped.
- Scenario Outline titles that contain placeholders (e.g. `Add (<a>/<b>) widgets`) now resolve their per-row statuses even when the generated-spec line mapping is unavailable, and no longer falsely warn that no results were attributed.
- Multi-project runs use worst-wins when the same scenario runs more than once (chromium + firefox, `repeat-each`), so a failure in one project is no longer masked by a pass in another.
- bddgen errors from runs where codegen is delegated to `defineBddProject` now reach the Problems panel.
- Cancelled runs settle the status bar into a "cancelled" state instead of leaving the spinner running.
- Windows: drive-letter casing no longer breaks run-summary scoping or multi-root debug folder matching (`c:\` vs `C:\` mismatches are canonicalized).

## [0.2.3] - 2026-07-15
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
