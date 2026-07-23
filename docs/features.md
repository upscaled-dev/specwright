# Language features

Reference for every language-server-style feature contributed by the extension. Settings reference: [settings.md](settings.md).

## Features for `.feature` files

### Gherkin parsing

Parsing lives in [src/parsers/feature-parser.ts](../src/parsers/feature-parser.ts). The parser recognises:

- **`Background:`** at both feature and rule level. Its steps are prepended to each scenario in scope (rule-level background adds on top of feature-level).
- **`Rule:`** blocks. Scenarios under a rule carry the rule name through to the Test Explorer.
- **`Scenario Outline:`** with one or more `Examples:` blocks. Each example row is discovered as its own scenario named `<index>: <outline name> - <header>: <value>, …`. `Examples:` blocks may be named and tagged.
- **Tag inheritance** onto each generated example scenario: the outline's own tags merge with the tags on the originating `Examples:` block. Feature- and rule-level tags are not auto-propagated to children — apply them on the scenario or examples block where you want them to take effect.

### Syntax highlighting

Gherkin syntax is highlighted out of the box with a built-in TextMate grammar; no second extension required.

### Step-definition navigation

`Cmd/Ctrl+Click` on a step in a `.feature` file jumps to the matching `Given/When/Then` in your TypeScript steps. The provider supports:

- Plain strings: `Given('I am on the home page', …)`
- Template literals: `` When(`I click {string}`, …) ``
- Regex literals (preserving flags): `Then(/^count is (\d+)$/i, …)`
- Cucumber-Expression placeholders `{string}`, `{int}`, `{word}`, `{customName}`, `{}` — expanded to non-greedy wildcards.

Controlled by `playwrightBddRunner.enableStepDefinitionNavigation` (boolean, default `true`).

### Step-definition hover

Hovering a step shows the matching step-definition's pattern and a clickable `relpath:line` link to the source. When multiple definitions match (an ambiguous step), every match is listed.

Controlled by `playwrightBddRunner.enableStepHover` (`auto`/`on`/`off`, default `auto`).

### Step-definition autocompletion

Typing on a step line (`Given`, `When`, `Then`, `And`, `But`, or `*`) triggers IntelliSense suggestions sourced from the playwright-bdd step definitions found under `playwrightBddRunner.stepDefinitionPaths`. Selecting an item inserts it as a snippet with tab-stop placeholders for each parameter.

- **No extra configuration.** Reuses `stepDefinitionPaths`; no separate glob.
- **Live updates.** Edits to step files are reflected in the next completion without reloading.
- **Humanized regex.** Regex-only step definitions are normalized where possible (`(\d+)` → `{int}`, `"([^"]*)"` → `"{string}"`), falling back to the raw regex source when ambiguous.
- **`And` / `But` / `*` follow the preceding keyword** in the same scenario. Lookback stops at `Scenario:`, `Background:`, `Feature:`, `Rule:`, `Example:`, and `Scenario Template:` boundaries; an orphan `And` with no prior concrete keyword yields nothing.
- **Distinguishable items.** `detail` starts with `Playwright-BDD ·` so you can tell our entries apart from cucumberautocomplete's when both providers are active.

Controlled by `playwrightBddRunner.enableStepAutocomplete` (`auto`/`on`/`off`, default `auto`).

### Tag autocompletion

Typing `@` in a `.feature` file triggers IntelliSense suggestions for every tag in use across the workspace (`@smoke`, `@regression`, `@wip`, `@JIRA-123`, …).

- **Workspace-wide source.** Tags pool from every file matched by `playwrightBddRunner.testFilePattern`. Multi-root: all roots contribute.
- **Lazy and live.** The tag index is built on first use and kept current via a `FileSystemWatcher`. No reload needed.
- **Tag shape.** Recognised pattern is `@[\w-]+` — `@smoke`, `@JIRA-123`, `@bdd-feature` work; unicode tags and dotted names like `@team.platform` don't.

Controlled by `playwrightBddRunner.enableTagAutocomplete` (`auto`/`on`/`off`, default `auto`).

### Unmatched step diagnostic

Steps with no matching `Given/When/Then` definition show a red squiggle. Source `Playwright-BDD`, code `unmatched-step`. The lightbulb exposes a **Create step definition for: \<step\>** quick-fix that opens the destination picker but only writes a stub for that one step.

Refreshes on file open, on edit (debounced 300ms), and when any step file under `stepDefinitionPaths` changes. Doc strings (`"""…"""`), data tables (`|…|`), comment lines, and `Examples:` block bodies are skipped.

Controlled by `playwrightBddRunner.enableStepDiagnostics` (boolean, default `true`). This setting is also the master switch for the ambiguous-step and Scenario Outline diagnostics.

### Ambiguous step diagnostic

A Gherkin step that matches more than one `Given/When/Then` definition would throw `AmbiguousMatchesException` at runtime. The extension surfaces this at edit time as a yellow Warning squiggle with code `ambiguous-step`. The message lists every conflicting source file at `relpath:line`. The lightbulb exposes one **Go to definition N: \<relpath:line\>** quick-fix per conflict.

`And`/`But`/`*` lines resolve against the last concrete keyword in the same scenario, with lookback stopping at scenario-boundary keywords. Doc strings and tables are suppressed (same as unmatched).

Honors `playwrightBddRunner.enableStepDiagnostics`.

### Scenario Outline validation

Two `Examples:`-consistency diagnostics, also gated by `enableStepDiagnostics`:

- **Warning, code `outline-undeclared-placeholder`** — an outline step references `<placeholder>` but no `Examples:` block under that outline has a column named `placeholder`.
- **Information, code `outline-unused-column`** — an `Examples:` column is declared in the header row but no step references it.

Both are scoped to the outline's `Examples:` block and clear on the next edit that resolves the mismatch.

### Document outline

`.feature` files contribute symbols for `Feature`, `Rule`, `Background`, `Scenario`, `Scenario Outline`, and `Example` so each appears in the breadcrumb bar and Outline view. Rebuilt on edit; no setting controls it.

### Gherkin snippets

Six snippets contributed for `.feature` files:

| Prefix | Expands to |
|---|---|
| `feat` | `Feature:` with a user-story preamble and a first scenario |
| `scen` | `Scenario:` with Given/When/Then |
| `bg` | `Background:` block |
| `outline` | `Scenario Outline:` with an `Examples:` table |
| `ex` | `Examples:` block |
| `rule` | `Rule:` with one `Example:` |

Each snippet has tab stops you can `Tab` through. Declarative ([snippets/gherkin.code-snippets](../snippets/gherkin.code-snippets)); no opt-out setting.

### Data-table formatting

Running **Format Document** (`Shift+Alt+F`) on a `.feature` file aligns pipes in every `Examples:` and step data table, right-aligning columns whose every cell parses as a number. Non-numeric columns are left-aligned. Header and separator rows preserved.

Controlled by `playwrightBddRunner.enableTableFormatting` (`auto`/`on`/`off`, default `auto`).

### Literal-to-parameter quick-fix

On a Gherkin step like `Given I have "John" users`, place the cursor on the literal and trigger the Code Action lightbulb. The **Promote literal to `{string}`** refactor updates both files atomically:

- The `.feature` line becomes `Given I have "{string}" users`.
- The matching step definition's pattern becomes `Given('I have {string} users', …)`.

Only offered when:
- Exactly one step definition matches the step (zero or multiple matches are skipped).
- That definition uses a Cucumber Expression — regex definitions are skipped because parameter promotion would require rewriting capture groups.
- The literal appears verbatim in the definition pattern.

Supported literals: double- or single-quoted strings (→ `{string}`), plain integers (→ `{int}`), plain floats (→ `{float}`). Date and version strings are not promoted.

Controlled by `playwrightBddRunner.enableStepLiteralPromotion` (`auto`/`on`/`off`, default `auto`).

## Features for step-definition files

### Find All References

Right-click on a `Given/When/Then` call in a `.ts`/`.js` step file and choose **Find All References** (`Shift+Alt+F12`) to list every Gherkin step across the workspace that matches it. Matches open in the standard References panel.

Controlled by `playwrightBddRunner.enableStepReferences` (`auto`/`on`/`off`, default `auto`).

### "Used N times" CodeLens

A `Used N times` (or `Unused`) CodeLens sits above each `Given/When/Then` definition. Clicking opens the References panel.

Controlled by `playwrightBddRunner.enableStepUsageCodeLens` (`auto`/`on`/`off`, default `auto`).

### Unused-step diagnostic

Step definitions with no matching Gherkin step anywhere in the workspace get an Information-severity diagnostic on the `Given/When/Then` line (source `Playwright-BDD`, code `unused-step`). They appear in the Problems panel grouped with the rest of the extension's diagnostics.

Controlled by `playwrightBddRunner.enableUnusedStepDiagnostics` (`auto`/`on`/`off`, default `auto`).

### Step-definition generation

Right-click inside a `.feature` editor and choose **Specwright: Generate Missing Step Definitions** to scaffold stubs for every Gherkin step that has no matching definition across `playwrightBddRunner.stepDefinitionPaths`. The command opens a QuickPick listing existing step files (most-recently-modified first) plus a **Create new file…** entry. The new-file default path is derived from the first concrete prefix of `stepDefinitionPaths`. Stubs are inserted via an undoable `WorkspaceEdit`; the destination opens and reveals the first inserted line. Re-running appends only newly unmatched steps.

Parameter inference (heuristic):

- `"…"` or `'…'` → `{string}` (TypeScript `string`)
- Plain integer (e.g. `5`) → `{int}` (TypeScript `number`)
- Plain float (e.g. `3.14`) → `{float}` (TypeScript `number`)
- `<outline-placeholder>` → `{string}` (TypeScript `string`)

Limitations:

- Heuristic inference mis-classifies date strings (`2026-05-22` → three ints), version strings (`1.2.3`), and other unusual numeric forms. Hand-edit the stub when this happens.
- No regenerate or overwrite — the command only appends; existing stubs are never rewritten.
- `<placeholder>` always maps to `{string}`, losing type info for numeric Scenario Outlines.
- Newly-created files hardcode `import { createBdd } from "playwright-bdd"`. Projects that wrap `createBdd` need a manual edit to the import.

<!-- Media placeholder: add ../images/step-generation.gif here.
Show an unmatched-step diagnostic, the Generate Missing Step Definitions command, destination selection, and the generated typed stubs. -->

## Steps panel

A **Specwright** container in the Activity Bar contributes a **Steps** tree view (id `playwrightBddRunner.stepsExplorer`), a read-only overview of the same indices that power step navigation and diagnostics. Two sections:

- **Step definitions** — grouped by effective keyword (`Given` / `When` / `Then`; a step registered for more than one keyword appears under each). Each leaf shows the humanized pattern, a `N uses · <file>` description, and a `symbol-method` icon — or a `warning` icon when the usage count is zero. Clicking a leaf opens the defining `file:line`.
- **Unmatched steps** — Gherkin steps with no matching definition, grouped by feature file (reusing the step-usage index's unmatched-step data). Clicking a leaf jumps to the feature line.

Empty and disabled states are explicit: "No step definitions found — check `playwrightBddRunner.stepDefinitionPaths`", "No unmatched steps", or a note that the panel is off when `enableStepsPanel` is `false`. The tree refreshes off the step-usage index's change events; the **Refresh Steps Panel** toolbar button forces a rescan.

Inline actions:

- On a **step definition** row — **Insert Step…** (see below), inserting that exact pattern into the active `.feature` editor.
- On an **unmatched step** row — **Create Step Definition**, which runs the same per-step generator as the unmatched-step quick fix.
- On an **unmatched file** row — **Generate Missing Step Definitions**, scaffolding every unmatched step in that file.

Controlled by `playwrightBddRunner.enableStepsPanel` (boolean, default `true`). Disabling disposes the panel and releases its share of the step-usage index.

<!-- Media placeholder: add ../images/steps-panel-and-generation.gif here.
Show the Steps panel's usage counts and unmatched-step action, then the generated definition. -->

## Inserting steps

**Specwright: Insert Step…** (command palette, or the inline action on a Steps-panel definition) inserts a known step pattern into the active `.feature` editor as a snippet:

- Without a preselected pattern it opens a QuickPick over every indexed definition, searchable by humanized text and by `keyword · source file`.
- The chosen pattern is converted to a snippet with a tab stop per parameter. Bare `{string}` placeholders are wrapped in double quotes so the inserted step matches the `{string}` parameter (which requires quotes); regex-derived placeholders that the humanized pattern already quotes are left as-is.
- With no active `.feature` editor the command shows a clear message and does nothing.

## Markdown exports

Two commands (command palette, or the Steps-panel toolbar) write shareable Markdown catalogs and open the result. Both prompt with a save dialog defaulting to the workspace root (`steps.md` / `scenarios.md`), and both open with a brand line (`Generated by Specwright vX.Y.Z — <local date/time>`), a **Summary**, a linked **Contents** table, and `<details open>` collapsible sections. In a multi-root workspace each export renders one section per folder.

- **Export Steps** — every indexed definition grouped by keyword (alphabetical within a group), each with its humanized label, verbatim pattern, source `file:line`, and usage count. The Summary reports total definitions, per-keyword counts, and the unused count. This export is always global.
- **Export All Scenarios** — first asks for a scope: **All features**, **By tag…** (pick from the known tags or enter custom ones; a feature is included when any of its scenarios carries any of the chosen tags), or **Selected features…** (multi-select of discovered feature files). Each feature renders its title and path, then each scenario or outline with its tags and steps, and outline example tables copied verbatim. The Summary states the active filter and how much was included, plus feature/scenario/outline/example-row counts and a descending tag-frequency list. Features with no matching scenarios are omitted.

Markdown is the only export format; JSON/CSV and standalone HTML are out of scope.

<!-- Media placeholder: add ../images/markdown-catalog-export.png here.
Show a rendered scenario or step catalog with its summary, contents, and collapsible sections. -->

## Experimental: Xray traceability

> This capability is still under development and is not presented as a supported Specwright feature. Its behaviour and settings may change without notice. Do not rely on it for production traceability workflows yet.

A **Traceability** view (id `playwrightBddRunner.traceability`) is being developed below the Steps view in the Specwright container. It currently maps scenarios to Jira Xray test and requirement keys using tags in the `.feature` files — entirely offline, from tags alone. Xray Cloud syncing, a coverage board, and publishing run results are not complete.

### Tag convention

- `@TEST_<KEY>` maps a scenario to an Xray test: `@TEST_CALC-1043` links to test `CALC-1043`.
- `@REQ_<KEY>` marks requirement coverage: `@REQ_CALC-900` shows as `REQ CALC-900` on the scenario row.
- The prefix is matched **case-insensitively** and the key is normalized to uppercase, so `@test_calc-1043` and `@TEST_CALC-1043` collapse to the same test.
- Keys follow the Jira shape `PROJ-123`; multi-segment projects like `AB-CD-123` work (the project is everything before the trailing `-<number>`, so `AB-CD-123` belongs to `AB-CD`).
- Prefixes are configurable via `traceability.testTagPrefix` / `traceability.reqTagPrefix`; an empty prefix falls back to the default. Extraction lives in [src/traceability/tag-extraction.ts](../src/traceability/tag-extraction.ts).

Because the mapping comes from tags, not scenario names, renaming a scenario never breaks its link.

### Tree structure

Two sections, each with a count:

- **Mapped tests** — one node per Xray test key (description: project and scenario count), expanding to the scenarios it covers. Clicking a scenario reveals its `.feature` line.
- **Untraced scenarios** — scenarios with no `@TEST_` tag, listed as coverage gaps with a warning icon.

**Scenario Outlines** map as **one Xray test per outline** — a `@TEST_` tag on the outline covers every example row, which Xray treats as iterations. A `@TEST_` tag on a specific `Examples:` block splits that block out into its own test (the rest of the outline stays with the outline-level key). There is never one test per example row.

When no scenarios carry Xray tags yet, the view shows a welcome note explaining the tag convention instead of an empty tree.

### Context actions

Right-click (or use the inline icons on) a test-key node:

- **Open Issue in Tracker** — opens `https://{siteUrl}/browse/{KEY}` using the `xray.siteUrl` setting. Warns if the setting is empty.
- **Copy Issue Key** — copies the key to the clipboard.

### Result badges

Test-key and scenario nodes show pass/fail/skipped badges from the most recent **persistent Playwright JSON report** found in the workspace — the first-found newest of `results.json`, `test-results.json`, `test-results/results.json`, or `playwright-report/results.json` in any workspace root. A test key covering several scenarios shows the worst outcome among them.

Important caveat: runs launched from the Test Explorer do **not** produce badges — the extension's own runs write their JSON report to a temp file and delete it after parsing. Badges appear only for runs whose Playwright config writes a JSON report to one of the paths above (for example a plain `npx playwright test` with a `['json', { outputFile: 'results.json' }]` reporter). Deeper integration with the extension's own runs lands in a later phase. The panel watches the report paths, so badges refresh when a report is written and clear when it is deleted.

### Settings

Controlled by `playwrightBddRunner.traceability.enablePanel` (boolean, default `true`) — disabling hides the view and tears down its watchers. The `traceability.*` settings (plus `xray.siteUrl`) are in [settings.md](settings.md).
