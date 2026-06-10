# Specwright — Playwright-BDD Test Explorer

**Run, debug, and author [playwright-bdd](https://vitalets.github.io/playwright-bdd/) Gherkin tests without leaving your editor.**

[![Install on VS Code Marketplace](https://img.shields.io/badge/Install-VS%20Code%20Marketplace-blue?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=upscaled-dev.specwright)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Specwright integrates [playwright-bdd](https://vitalets.github.io/playwright-bdd/) with VS Code: scenarios appear in the Test Explorer like any other test, and `.feature` files get full language tooling — autocomplete, hover, go-to-definition, references, diagnostics, refactoring, and step-definition generation.

![Run / Debug from the Test Explorer and CodeLens](images/running_feature_code_lens.gif)

## Why Specwright?

- **Results land on the right scenario.** Pass/fail maps back to the exact `.feature` line — including individual Scenario Outline example rows — instead of leaving you to scan terminal output.
- **Real debugging.** Set a breakpoint in your step-definition `.ts` file, hit the debug icon, and step through — no `--debug` inspector workarounds.
- **Your steps are connected.** Autocomplete steps from your actual step definitions, hover to see the matching pattern, Ctrl+Click to jump to it, and see usage counts above every definition.
- **No setup beyond playwright-bdd itself.** Discovery, `bddgen`, runs, and result mapping are all automatic.

## Quick start

1. Open a workspace that has [playwright-bdd configured](docs/runs.md#prerequisites) and at least one `.feature` file.
2. Open the Test Explorer (⇧⌘T / Ctrl+Shift+T). Scenarios appear, organized by feature.
3. Click ▶ on a scenario to run, or 🐞 to debug. Status appears in the bottom-left status bar.

Only your playwright-bdd configuration is required. If your project layout differs from the defaults (step paths, package-manager commands, working directory), see [docs/settings.md](docs/settings.md).

## Features

### Test Explorer integration

- **Automatic discovery** of every `.feature` file, kept live by a file watcher — create, edit, or delete a feature and the tree updates without a reload.
- **Three run profiles**: Run, Debug (breakpoints in your step-definition `.ts` files just work), and Run in Parallel (prompts once for a worker count, then remembers it).
- **Five organization strategies**, switchable on the fly: hierarchical by feature, by tag, by file, by scenario type, or flat.
- **Scenario Outline rows as first-class items** — every `Examples:` row is individually runnable and individually reported.
- **Exact result mapping** back to the right `.feature` line via playwright-bdd's embedded source data, so pass/fail status sticks to the correct tree item — even for outline example rows.

![Switching between tag, file, scenario-type, hierarchical, and flat views](images/views.gif)

→ [docs/runs.md](docs/runs.md)

### Run and debug from anywhere

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

### Step intelligence

`.feature` files and step definitions are linked in both directions:

- **Go to Definition** from a Gherkin step to its `Given/When/Then` — plain strings, template literals, regex (with flags), and Cucumber Expression placeholders (`{string}`, `{int}`, `{word}`, custom types) all resolve.
- **Hover** shows the matching definition's pattern with a clickable source link; ambiguous steps list every match.
- **Step autocomplete** sourced from your real step definitions, inserted as snippets with a tab stop per parameter; regex patterns are humanized (`(\d+)` → `{int}`) where possible.
- **Find All References** on a step definition lists every matching Gherkin step across the workspace.
- **"Used N times" CodeLens** above each step definition — unused steps stand out at a glance.
- **Edit-time diagnostics**: unmatched step (with a *Create step definition* quick fix), ambiguous step (would throw at runtime — flagged at edit time, with a go-to quick fix per conflict), unused step definition, and Scenario Outline validation (undeclared `<placeholder>`, unused `Examples:` column).

→ [docs/features.md](docs/features.md)

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

## Compatibility

Works alongside [Cucumber (Gherkin) Full Support](https://marketplace.visualstudio.com/items?itemName=alexkrechik.cucumberautocomplete). Every overlapping provider (autocomplete, hover, references, CodeLens, unused-step, literal promotion, table formatting) has an `auto`/`on`/`off` setting that defaults to `auto` and steps aside when cucumberautocomplete is installed — so your IntelliSense list, Problems panel, and References panel never show duplicates. See [docs/settings.md#cucumberautocomplete-coexistence](docs/settings.md#cucumberautocomplete-coexistence).

## Install

[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=upscaled-dev.specwright) or:

```bash
code --install-extension upscaled-dev.specwright
```

## Documentation

- [docs/runs.md](docs/runs.md) — running tests, status bar, CodeLens, parallel, pre-run hook
- [docs/features.md](docs/features.md) — language-server features for `.feature` and step files
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
