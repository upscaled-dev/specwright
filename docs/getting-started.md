# Get started

Specwright adds VS Code authoring, test-running, and debugging workflows to an
**existing** `playwright-bdd` project. It uses the Playwright and `bddgen`
commands already installed for that project; it does not replace your
`playwright.config.*` file or create a separate test project.

## Before your first run

Open the folder that contains your project in VS Code. You need:

- A VS Code host listed in the [exact compatibility record](compatibility.md). The declared minimum is 1.99.0.
- A Node project with `@playwright/test` and `playwright-bdd` installed.
- At least one `.feature` file covered by your `playwright-bdd` configuration.
- Playwright browsers installed when your project requires them.

Before involving the extension, run the same test command your team uses from
the package directory that owns the feature and its `playwright.config.*` file.
If your setup invokes code generation separately, run that command too. This
establishes that the project itself can run before VS Code adds its integration.

Keep `playwrightBddRunner.bddgenCommand` configured for targeted runs. If
another command produces current generated specs before each targeted run, set
it as `playwrightBddRunner.preRunCommand` and leave `bddgenCommand` empty.

## Run one scenario

1. Open the **Testing** view in the Activity Bar (the beaker icon).
2. Wait for your features and scenarios to appear. If they do not, open a
   `.feature` file and run **Specwright: Discover Tests** from the Command
   Palette.
3. Select one scenario and choose **Run**. You can also use the Run CodeLens
   above a scenario in a `.feature` editor.
4. Inspect the result in the Testing view and its **Test Results** output.

Specwright discovers `.feature` files using
`playwrightBddRunner.testFilePattern`, which defaults to `**/*.feature`.
Discovery only finds and parses the files; the first run also verifies that the
feature is inside the `features` scope configured for `playwright-bdd`.

Use **Debug** on the same scenario when you need to stop at a breakpoint.
Feature-file breakpoints are mirrored onto the generated Playwright spec, while
breakpoints in step-definition files work through VS Code's JavaScript debugger.
See [running and debugging](runs.md#debug-with-breakpoints) for the full
flow and its limitations.

## Confirm that the workspace is healthy

After a successful first run, you should be able to:

- See the feature, scenario, and any Scenario Outline example rows in Testing.
- Run a scenario and see its result attached to the matching item.
- Open **Specwright: Show Test Output** to see the command and runner output.
- Cmd/Ctrl-click a Gherkin step to open its matching definition when the step
  file is in the configured discovery paths.

If one of these checks fails, start with [Troubleshooting](troubleshooting.md).

## Change only the settings your project needs

Open Settings with Cmd/Ctrl+, search for **Specwright**, or store workspace
settings in `.vscode/settings.json`.

| Your project differs because… | Start with |
| --- | --- |
| It uses pnpm, Yarn, or custom package scripts | `playwrightBddRunner.playwrightCommand` and `playwrightBddRunner.bddgenCommand` |
| Another command produces current generated specs before each targeted run | Set `playwrightBddRunner.bddgenCommand` to `""` and configure it as `playwrightBddRunner.preRunCommand` |
| Generated specs use a custom `outputDir` | `playwrightBddRunner.featuresGenDir` |
| Features are outside the default `**/*.feature` pattern | `playwrightBddRunner.testFilePattern` |
| Step definitions live outside the default step folders | `playwrightBddRunner.stepDefinitionPaths` |
| Generated or report files are being treated as step definitions | `playwrightBddRunner.stepDefinitionExcludePaths` |
| You need a command to run from one fixed package | `playwrightBddRunner.workingDirectory` |

The [settings reference](settings.md) describes every setting and its default.

## Package managers and monorepos

The default commands are `npx bddgen` and `npx playwright test`. Change both
commands if your repository uses another package manager. For example, a pnpm
workspace can use:

```json
{
  "playwrightBddRunner.playwrightCommand": "pnpm exec playwright test",
  "playwrightBddRunner.bddgenCommand": "pnpm exec bddgen"
}
```

For a run that targets a feature, scenario, or example row, Specwright walks up
from that feature to the nearest `playwright.config.*` file and runs commands
from that directory. This normally lets package-local binaries resolve without
extra monorepo configuration.

**Run All Tests** has no feature to locate, so it runs from the configured
working directory or, by default, the first workspace folder. If your root
script cannot run every package, run a targeted feature from the appropriate
package or set `playwrightBddRunner.workingDirectory` to the package or root
script location that should own all-suite runs. A relative working directory is
resolved from the first workspace folder.

`stepDefinitionPaths` and `stepDefinitionExcludePaths` are resource-scoped.
In a multi-root workspace, configure those paths for each folder that has its
own step directory. See the [monorepo settings example](settings.md#use-pnpm-in-a-monorepo).

## Where to go next

- [Run and debug tests](runs.md) for targeting, Test Explorer, breakpoints,
  parallel runs, and test output.
- [Author feature files and manage steps](features.md) for navigation,
  diagnostics, generated step stubs, the Steps panel, and exports.
- [Settings reference](settings.md) for commands, discovery, reporters, and
  compatibility settings.
- [Troubleshooting](troubleshooting.md) when discovery, code generation, or
  result mapping does not behave as expected.
