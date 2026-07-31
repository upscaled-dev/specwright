# Specwright

**BDD authoring, test execution, and traceability for `playwright-bdd` in VS Code.**

Write Gherkin scenarios, keep them connected to their step definitions, and run or debug the exact test you are editing. Specwright brings authoring and Playwright results together in VS Code.

[![Install on VS Code Marketplace](https://img.shields.io/badge/Install-VS%20Code%20Marketplace-blue?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=upscaled-dev.specwright)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

![Run and Debug CodeLens in a feature file](images/running_feature_code_lens.gif)

<!-- GIF placeholder: images/authoring-to-execution.gif
Show an unmatched Gherkin step being resolved or generated, then run the scenario. Keep the recording
tight, use a current Specwright build, and do not show personal paths, account names, or external apps. -->

## What you can do

### Write better feature files

Use built-in Gherkin highlighting, snippets, document outline, tag suggestions, and table formatting. Specwright can identify missing or ambiguous steps, validate Scenario Outline tables, and help create a matching step definition.

### Keep steps connected

Go from a Gherkin step to its TypeScript or JavaScript definition, inspect the matching pattern on hover, find every scenario that uses a definition, and spot unused definitions. Suggestions come from the step definitions in your workspace.

### Run and debug the right scenario

Discover features in the Testing view and run a feature, scenario, Scenario Outline, or individual Examples row. Use CodeLens or the Testing view to target an individual scenario or row; editor and Explorer context menus provide file-level actions. Results map back to the feature file as each scenario finishes, so a long run shows useful progress immediately.

Set breakpoints in `.feature` files or step definitions, then use VS Code's normal Debug action. Specwright generates the necessary specs, mirrors supported feature-file breakpoints, and removes the generated breakpoints when the session ends.

![Debug a feature with breakpoints](images/debugging_feature.gif)

![Run one Scenario Outline Examples row](images/running_example.gif)

![Switch between feature, tag, file, scenario-type, and flat test views](images/views.gif)

### Manage a growing step library

The Steps panel groups definitions by keyword, highlights unmatched and unused steps, and provides one-click generation. It can also export shareable Markdown catalogs of steps or scenarios.

![Browse step definitions and their usage in the Steps panel](images/bdd-steps.png)

### Connect scenarios to Xray Cloud

**Experimental.** The Traceability panel maps tagged scenarios to Xray Cloud tests, shows coverage in VS Code, and supports local-run publishing workflows. It can be evaluated with an existing Jira/Xray project, including a trial tenant when the account has the required permissions. No standalone sample project is required.

The Xray guide clearly identifies actions that only change your workspace, actions that read remote data, and actions that can create, update, attach, or publish remote Jira/Xray records.

![Traceability panel showing mapped and untraced scenarios](images/traceability.png)

## Quick start

1. Install Specwright from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=upscaled-dev.specwright).
2. Open a workspace already configured for [`playwright-bdd`](https://vitalets.github.io/playwright-bdd/) with one or more `.feature` files.
3. Open the **Testing** view. Specwright discovers scenarios automatically.
4. Choose **Run** or **Debug** for the feature, scenario, outline, or Examples row you need.

Specwright uses your existing `playwright-bdd` and Playwright configuration. If you use a monorepo, another package manager, or custom step paths, follow the [getting started guide](docs/getting-started.md).

## Common tasks

| If you want to… | Start here |
| --- | --- |
| Run, debug, filter, stop, or interpret a test | [Run and debug tests](docs/runs.md) |
| Fix a missing or ambiguous step | [Author feature files](docs/features.md) |
| Find, insert, generate, or export steps | [Use the Steps panel](docs/features.md#steps-panel) |
| Configure a monorepo, package-manager command, or custom output directory | [Settings](docs/settings.md) |
| Connect tagged scenarios to Xray Cloud | [Xray traceability](docs/traceability.md) |
| Diagnose discovery, code generation, or result-mapping problems | [Troubleshooting](docs/troubleshooting.md) |

## Highlights

- Run, debug, cancel, and inspect results from the Testing view, CodeLens, file-level editor menus, or the Command Palette.
- Treat Scenario Outline rows as first-class tests.
- Navigate between Gherkin steps and real `Given`, `When`, and `Then` definitions.
- Get autocomplete, hover, references, usage counts, diagnostics, quick fixes, and typed stub generation.
- Format Gherkin data tables and promote literal values to reusable step parameters.
- Organize discovered tests by feature, tag, file, scenario type, or as a flat list.
- Export step and scenario catalogs as Markdown.
- Use experimental Xray Cloud traceability from within VS Code.

## Compatibility and prerequisites

- VS Code `1.99` or later.
- A project configured for `playwright-bdd` and Playwright.
- TypeScript or JavaScript step-definition files.
- Single-folder, multi-root, and monorepo workspaces are supported when their step paths and working directories are configured correctly.

Specwright can coexist with [Cucumber (Gherkin) Full Support](https://marketplace.visualstudio.com/items?itemName=alexkrechik.cucumberautocomplete). Overlapping authoring features default to an automatic compatibility mode to avoid duplicate suggestions and diagnostics. You can change that behavior in Settings.

## Documentation

- [Getting started](docs/getting-started.md)
- [Run and debug tests](docs/runs.md)
- [Author feature files and manage steps](docs/features.md)
- [Xray traceability](docs/traceability.md)
- [Settings and workspace configuration](docs/settings.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development](docs/development.md)
- [Release notes](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)

## Install from the command line

```bash
code --install-extension upscaled-dev.specwright
```

## Support

If Specwright saves you time, consider buying me a coffee.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/upscaled.dev)

## Acknowledgments

Specwright stands on the work of projects and communities that make BDD development in VS Code possible.

### Test runner

[playwright-bdd](https://vitalets.github.io/playwright-bdd/) provides the Gherkin runner on top of Playwright that Specwright targets.

### Original extension foundation

[Behave Test Runner](https://github.com/upscaled-dev/behave-vsc-extension) is the upstream VS Code extension that Specwright was forked from. Its Test Explorer wiring, organization strategies, and CodeLens scaffolding provided the starting point.

### Gherkin ecosystem

[Cucumber (Gherkin) Full Support](https://marketplace.visualstudio.com/items?itemName=alexkrechik.cucumberautocomplete) is an independent VS Code extension for Gherkin authoring. Specwright is designed to coexist with it; see the [compatibility settings](docs/settings.md#compatibility-mode-settings).

[Gherkin](https://cucumber.io/docs/gherkin/) and the [VS Code Extension API](https://code.visualstudio.com/api) provide the language and platform that make the extension possible.

## License

[MIT](LICENSE)
