# Run and debug tests

Specwright discovers `.feature` files and presents their scenarios in VS Code's **Testing** view. Discovery starts when the Testing view resolves, when you refresh, or when a run needs tests. It does not perform a full workspace discovery during ordinary startup. You can run or debug the whole workspace, one feature, one scenario, a Scenario Outline, or one Examples row.

## Before you run

Your workspace needs a working [`playwright-bdd`](https://vitalets.github.io/playwright-bdd/) and Playwright configuration. Specwright runs the configured `bddgen` command before Playwright unless you have disabled it because your Playwright configuration already performs code generation.

If the Testing view is empty, start with [Troubleshooting: features do not appear in Testing](troubleshooting.md#features-do-not-appear-in-testing).

## Choose where to run from

| Where you are working | What you can do |
| --- | --- |
| **Testing** view | Run, debug, stop, or inspect features, scenarios, outlines, and Examples rows. |
| **Feature editor** | Use CodeLens above a feature, scenario, outline, or Examples row. |
| **Editor and Explorer context menus** | Choose **Run Feature File** or other file-level actions. Use CodeLens or the Testing view to select an individual scenario or Examples row. |
| **Command Palette** | Use commands under the **Specwright** category. Run and debug commands use the open `.feature` file, or let you pick one. |

![Run and Debug CodeLens in a feature file](../images/running_feature_code_lens.gif)

![Run a feature or scenario from the editor gutter](../images/running_feature_gutter.gif)

## Run a test

1. Open the **Testing** view.
2. Expand a feature until you reach the scope you want to run.
3. Select the **Run** icon, or use the action in the feature editor.

Specwright creates the required specs, starts Playwright, and maps each scenario result to the item you selected as soon as it finishes. During a long run, the Test Results output and status bar show the live completed count. Editor-triggered feature and scenario runs show the same count in a progress notification. The final JSON report reconciles the complete result and supplies the detailed summary after Playwright exits. Select the status bar item to open the Specwright output channel.

![Run a scenario directly from its editor action](../images/running_scenario_side.gif)

### Run one Scenario Outline row

Each Examples row is a first-class item in the Testing view and receives its own CodeLens actions. Choose **Run Example** or **Debug Example** above that row to target it. Code generation still runs when the project requires it, but Specwright targets the matching row and reports the outcome there.

![Run one Scenario Outline Examples row](../images/running_example.gif)

### Run by tag

Use **Run by tag…** above a tagged feature and enter an expression, or configure a default expression with `playwrightBddRunner.tags`. The expression is passed to `bddgen`, so only matching specs are generated.

### Run in parallel

Choose **Run All Tests in Parallel** from the Testing view or the Command Palette. The first run asks for a worker count and remembers it. You can also enable workers through `playwrightBddRunner.parallelExecution` and set `playwrightBddRunner.maxParallelProcesses`.

The worker count controls concurrency that Playwright permits across files and projects. A feature normally generates one spec file, so hundreds of scenarios in that one feature do not become parallel solely because Specwright passes `--workers`. Use Playwright's `fullyParallel` configuration when you deliberately want tests within one generated file to run in parallel.

### Run a pre-flight command

Set `playwrightBddRunner.preRunCommand` when a build, fixture setup, or other local task must succeed before every test run. A failing pre-run command stops the test run and writes its output to the Specwright channel.

## Organize the Testing view

Use **Group tests by** to choose:

- Tags
- File
- Scenario type
- None
- Feature

The selection changes only the Testing view. It does not move or modify feature files.

![Switch between test-organization views](../images/views.gif)

## Debug with breakpoints

Set a breakpoint in a `.feature` file or TypeScript/JavaScript step definition, then choose a **Debug** action.

When you debug a feature-file breakpoint, Specwright:

1. Runs `bddgen` so generated specs are available.
2. Finds the generated line that corresponds to supported Gherkin steps, scenarios, and Examples rows.
3. Mirrors the breakpoint to that generated spec and starts VS Code's JavaScript debugger.
4. Removes the mirrored breakpoint when the debug session ends.

The debugger pauses in the generated specification, or in your step definition after you step in, rather than in the `.feature` file. This is expected: the JavaScript debugger can bind only to executable JavaScript.

If your project writes generated specs outside `.features-gen`, set `playwrightBddRunner.featuresGenDir` to the matching directory. Step-definition breakpoints still work if a feature-file breakpoint cannot be mapped.

## Read results

While a run is active, the **Test Results** panel streams Playwright and `bddgen` output, marks each completed scenario, and writes lines such as `[127 / 500]`. After the run, it shows the final scenario summary with Gherkin steps, durations, failures, and clickable stack traces.

Specwright keeps only the newest 256 KiB from stdout and stderr as diagnostic tails. The full process output still streams to Test Results. If a tail is truncated, a notice reports its retained and discarded byte counts. A Playwright JSON report larger than 16 MiB stops result ingestion for that run with a specific size-limit message; a workspace report over the limit is skipped for board badges instead of blocking them. File-based reports are parsed in an isolated worker with a 128 MiB old-generation heap limit. Inline attachment bodies are ignored, but their encoded bytes still count toward the whole-report limit; file-based evidence paths are unaffected.

- A retry that eventually passes is reported as passed.
- If the same scenario runs in multiple Playwright projects, the least successful result is shown.
- Missing step-definition suggestions are surfaced when `bddgen` skips scenarios for missing steps.
- If a feature is outside your `playwright-bdd` `features` glob, Specwright explains why the targeted run produced no result.

## Stop a run

Use VS Code's **Stop** action in the Testing view. For a feature or scenario run started from CodeLens or an editor menu, use **Cancel** in its progress notification. Specwright ends the Playwright process tree and marks tests that did not run as skipped. A deliberately stopped run is shown as cancelled, not failed. A debug run stops the same way, and its debug session ends with it.

## Commands

Palette run and debug commands use the active `.feature` file. If none is open, select a feature file; scenario commands then use the scenario at the cursor or ask you to choose one. Commands that run with tags also ask for a tag expression.

**Generate Missing Step Definitions** and **Go to Step Definition** act on the file in the editor, so the palette lists them only while a `.feature` file is open. The commands in the table below are always listed.

| Task | Commands |
| --- | --- |
| Discover tests | **Discover Tests** |
| Run tests | **Run All Tests**, **Run All Tests in Parallel**, **Run Feature File**, **Run Scenario**, **Run Scenario with Tags**, **Run Feature File with Tags** |
| Debug tests | **Debug Scenario** |
| Change the Testing view | **Group tests by**: **Tags**, **File**, **Scenario type**, **None**, or **Feature** |
| Inspect the extension | **Show Test Output**, **Validate Configuration** |

CodeLens and menu actions continue to pass their exact target. The Testing view and CodeLens are the clearest way to choose an individual Scenario Outline Examples row.

## Limits to be aware of

- Specwright targets generated-spec lines and verifies each generated file's `Generated from` source identity. If it cannot prove that a current generated spec belongs to the requested feature, or cannot resolve its line for a targeted scenario or Examples row, it fails closed. Run `bddgen`, then check `playwrightBddRunner.featuresGenDir` and your bddgen features configuration.
- A breakpoint on a shared Background step pauses once for every scenario that executes that step.
- Code generation and result mapping depend on the output format emitted by your installed `playwright-bdd` and Playwright versions.

## Next steps

- [Configure commands, reports, tags, workers, and output directories](settings.md#execution)
- [Write and maintain feature files](features.md)
- [Troubleshoot runs and debugging](troubleshooting.md)
