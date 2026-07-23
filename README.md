# Specwright - BDD Authoring for Playwright in VS Code

**A first-class BDD authoring experience for [playwright-bdd](https://vitalets.github.io/playwright-bdd/) in VS Code.**

[![Install on VS Code Marketplace](https://img.shields.io/badge/Install-VS%20Code%20Marketplace-blue?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=upscaled-dev.specwright)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Write, navigate, validate, and generate Gherkin step definitions without leaving VS Code. Specwright keeps authoring connected to execution: run or debug the scenario you are editing directly from the Test Explorer, CodeLens, or editor.

![Run / Debug from the Test Explorer and CodeLens](images/running_feature_code_lens.gif)

## Why Specwright?

- **Run the exact test you mean.** Results return to the right feature, scenario, or Scenario Outline example row instead of getting lost in terminal output.
- **Debug from the feature file.** Set breakpoints in Gherkin or TypeScript step definitions, then use VS Code's normal Debug action — no Playwright Inspector workflow required.
- **Keep steps connected.** Autocomplete, hover, go to definition, references, usage counts, diagnostics, and generation all work from your real step definitions.
- **Use your existing project.** Once playwright-bdd is configured, Specwright discovers features, runs `bddgen`, starts Playwright, and maps the results back for you.

## Quick start

1. Open a workspace that has [playwright-bdd configured](docs/runs.md#prerequisites) and at least one `.feature` file.
2. Open the Testing view (beaker icon). Specwright discovers your scenarios automatically.
3. Select **Run** or **Debug** on a scenario, outline, or individual Examples row.

Only your playwright-bdd configuration is required. If your project layout differs from the defaults (step paths, package-manager commands, working directory), see [docs/settings.md](docs/settings.md).

## Features

### Run and debug tests

- **Automatic discovery** of every `.feature` file, kept live by a file watcher — create, edit, or delete a feature and the tree updates without a reload.
- **Three run profiles**: Run, Debug (including breakpoints in `.feature` files and step-definition `.ts` files), and Run in Parallel (prompts once for a worker count, then remembers it).
- **Five organization strategies**, switchable on the fly: hierarchical by feature, by tag, by file, by scenario type, or flat.
- **Scenario Outline rows as first-class items** — every `Examples:` row is individually runnable and individually reported.
- **Exact result mapping** back to the right `.feature` line — including individual outline example rows. Flaky tests that pass on retry show as passed; multi-project runs show the worst outcome.
- **Per-scenario durations** shown after a run, and a stop button that actually cancels — it kills the Playwright process tree and marks the rest skipped.

![Switching between tag, file, scenario-type, hierarchical, and flat views](images/views.gif)

→ [docs/runs.md](docs/runs.md)

### Run from the editor, explorer, or Test Explorer

Wherever you're looking at a scenario, there's a way to run it:

- **CodeLens at four levels**: the `Feature:` line (Run Feature File, plus one "Run with @tag" link per tag in the file), each scenario, each scenario outline, and each individual `Examples:` row.
- **Context menus** in the editor, the editor tab, the file explorer, and the Test Explorer.
- **Tag filtering** pushed into `bddgen --tags`, so only matching specs are even generated.
- **Pre-run hook** (`preRunCommand`) that runs before every invocation and aborts the run on failure.
- **Status bar** showing idle / running / last-run pass-fail counts; click it to open the test output.
- **Step-level Test Results panel** — each scenario's steps with durations, the failing step's error and clickable stack trace, surfaced missing-step suggestions, and a hint when a targeted feature is outside playwright-bdd's `features` glob.
- **`bddgen` errors as diagnostics** — codegen failures become red squiggles on the offending `.feature` line.

![Running a single Scenario Outline example row](images/running_example.gif)

→ [docs/runs.md](docs/runs.md)

### Debugging with breakpoints

Set breakpoints directly in the `.feature` file — the breakpoint gutter is enabled for Gherkin — or in your step-definition `.ts` files, then start any Debug action. The extension runs `bddgen` first, mirrors your feature-file breakpoints onto the matching lines of the generated spec (steps, `Scenario:` lines, and `Examples:` rows), launches VS Code's JS debugger, and removes the mirrored breakpoints when the session ends. While paused, the editor shows the generated spec (or your step definition once you step in), not the `.feature` file. If you customized playwright-bdd's `outputDir`, point `playwrightBddRunner.featuresGenDir` at it.

→ [docs/runs.md](docs/runs.md#debugging-with-breakpoints)

<!-- Media placeholder: add images/debug-feature-breakpoint.gif here if the hero placement above is removed.
Show: set a breakpoint in a Gherkin step → Debug Scenario → pause in the generated test or TypeScript step definition. -->

### Step intelligence

`.feature` files and step definitions are linked in both directions:

- **Go to Definition** from a Gherkin step to its `Given/When/Then` — plain strings, template literals, regex (with flags), and Cucumber Expression placeholders (`{string}`, `{int}`, `{word}`, custom types) all resolve.
- **Hover** shows the matching definition's pattern with a clickable source link; ambiguous steps list every match.
- **Step autocomplete** sourced from your real step definitions, inserted as snippets with a tab stop per parameter; regex patterns are humanized (`(\d+)` → `{int}`) where possible.
- **Find All References** on a step definition lists every matching Gherkin step across the workspace.
- **"Used N times" CodeLens** above each step definition — unused steps stand out at a glance.
- **Edit-time diagnostics**: unmatched step (with a *Create step definition* quick fix), ambiguous step (would throw at runtime — flagged at edit time, with a go-to quick fix per conflict), unused step definition, and Scenario Outline validation (undeclared `<placeholder>`, unused `Examples:` column).

→ [docs/features.md](docs/features.md)

### Steps panel

A **Specwright** container in the Activity Bar hosts a **Steps** view:

- **Step definitions** grouped by `Given`/`When`/`Then`, each with a usage count and an unused marker; click one to open its definition.
- **Unmatched steps** grouped by feature file, with one-click scaffolding for a single step or a whole file.
- **Insert Step…** picks a known step pattern and inserts it into the active `.feature` file as a snippet, with a tab stop per parameter.
- **Export Steps** and **Export All Scenarios** write shareable Markdown catalogs — a branded masthead with headline counts, a summary, a linked table of contents, and collapsible sections. Scenario catalogs add a "Browse by tag" index; step catalogs surface an "Unused" callout. The scenario export can be scoped to all features, a tag, or a hand-picked set, and `collapseMarkdownExportSections` starts the sections collapsed for large catalogs.

Toggle the panel with `playwrightBddRunner.enableStepsPanel`.

→ [docs/features.md#steps-panel](docs/features.md#steps-panel)

<!-- Media placeholder: add images/steps-panel-and-generation.gif here.
Show: find an unmatched step in the Steps panel → create its definition → return to the feature with the diagnostic cleared. -->

### Authoring `.feature` files

- **Syntax highlighting** built in — no second extension required.
- **Tag autocompletion** — type `@` and get every tag already in use across the workspace.
- **Snippets**: `feat`, `scen`, `bg`, `outline`, `ex`, `rule`.
- **Document outline & breadcrumbs** for `Feature`, `Rule`, `Background`, `Scenario`, `Scenario Outline`, and `Example`.
- **Data-table formatting** — Format Document aligns every pipe table, right-aligning numeric columns.
- **Literal-to-parameter refactor** — promote a hard-coded `"value"`, `42`, or `3.14` into `{string}`/`{int}`/`{float}`, atomically updating both the `.feature` file and the step definition.

→ [docs/features.md](docs/features.md)

### Step generation

Write the scenario first, then generate the code to match:

- **Generate Missing Step Definitions** scaffolds typed stubs for every unmatched step in a feature, with parameter inference (`"…"` → `{string}`, `5` → `{int}`, `3.14` → `{float}`), into an existing step file or a new one. Re-running appends only newly unmatched steps.
- **Per-step quick fix** on any unmatched-step squiggle creates a stub for just that step.

→ [docs/features.md](docs/features.md#step-definition-generation)

<!-- Media placeholder: add images/markdown-catalog-export.png here.
Show the rendered output of Export Steps or Export All Scenarios, including the summary and linked contents. -->

## Compatibility

Works alongside [Cucumber (Gherkin) Full Support](https://marketplace.visualstudio.com/items?itemName=alexkrechik.cucumberautocomplete). Every overlapping provider (autocomplete, hover, references, CodeLens, unused-step, literal promotion, table formatting) has an `auto`/`on`/`off` setting that defaults to `auto` and steps aside when cucumberautocomplete is installed — so your IntelliSense list, Problems panel, and References panel never show duplicates. See [docs/settings.md#cucumberautocomplete-coexistence](docs/settings.md#cucumberautocomplete-coexistence).

## Install

[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=upscaled-dev.specwright) or:

```bash
code --install-extension upscaled-dev.specwright
```

## Documentation

- [docs/runs.md](docs/runs.md) — running tests, cancellation, status bar, CodeLens, parallel, pre-run hook
- [docs/features.md](docs/features.md) — language features, step generation, the Steps panel, and Markdown exports
- [docs/settings.md](docs/settings.md) — full settings reference + compatibility behavior
- [docs/development.md](docs/development.md) — building, testing, releasing, project layout
- [CHANGELOG.md](CHANGELOG.md) — release notes
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution guidelines

## Support

If Specwright saves you time, consider buying me a coffee.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/upscaled.dev)

## Acknowledgments

- [playwright-bdd](https://vitalets.github.io/playwright-bdd/) — the Gherkin runner on top of Playwright that this extension targets.
- [Behave Test Runner](https://github.com/upscaled-dev/behave-vsc-extension) — the upstream VS Code extension this project was forked from; Test Explorer wiring, organization strategies, and CodeLens scaffolding originated there.
- [Cucumber (Gherkin) Full Support](https://marketplace.visualstudio.com/items?itemName=alexkrechik.cucumberautocomplete) — independent VS Code extension for Gherkin authoring. This extension is designed to coexist with it (see [docs/settings.md](docs/settings.md#cucumberautocomplete-coexistence)).
- [Gherkin](https://cucumber.io/docs/gherkin/) and the [VS Code Extension API](https://code.visualstudio.com/api) — the BDD syntax and the platform this extension is built on.

## License

MIT — see [LICENSE](LICENSE).
