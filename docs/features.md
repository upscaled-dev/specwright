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
