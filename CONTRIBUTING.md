# Contributing

Thanks for your interest. This project is a VS Code extension that drives [playwright-bdd](https://vitalets.github.io/playwright-bdd/) — the runtime it shells out to is `npx bddgen && npx playwright test`.

## Setup

```bash
npm install
npm run watch    # esbuild bundle + tsc in parallel
```

Open the repo in VS Code and press **F5** to launch a new Extension Development Host window with the extension loaded. The included [features/](features/) directory and [playwright.config.ts](playwright.config.ts) serve as a working sample to exercise the Test Explorer integration end-to-end.

## Project layout

See the project layout section in [docs/development.md](docs/development.md#project-layout).

## Testing

```bash
npm test           # vitest run (unit tests)
npm run test:watch # vitest in watch mode
npm run test:coverage
```

Unit tests live under [src/test/unit/](src/test/unit/). They use Vitest and the stub `vscode` module at [src/test/__mocks__/vscode.ts](src/test/__mocks__/vscode.ts), aliased via [vitest.config.ts](vitest.config.ts).

When adding a new module, prefer extracting pure-function logic into something a Vitest test can call directly without touching VS Code APIs. Examples in this repo:

- [shell.ts](src/utils/shell.ts) → [shell.test.ts](src/test/unit/shell.test.ts)
- [command-builder.ts](src/core/command-builder.ts) → [command-builder.test.ts](src/test/unit/command-builder.test.ts) (uses a typed config stub instead of importing `ExtensionConfig`)
- [playwright-json-parser.ts](src/utils/playwright-json-parser.ts) → [playwright-json-parser.test.ts](src/test/unit/playwright-json-parser.test.ts)

## Integration tests

```bash
npm run test:integration
```

Integration tests live under [src/test/integration/](src/test/integration/) and cover what the Vitest `vscode` stub can't reach: real `TestController` behavior, `TestItem` tree population, run-profile registration, and other extension-host APIs. The script compiles the integration suite with a separate [tsconfig.integration.json](tsconfig.integration.json), then launches a real VS Code instance against the fixture workspace at [src/test/integration/fixtures/workspace/](src/test/integration/fixtures/workspace/).

Current suites cover `scenarioByTestId` map population across all 5 organization strategies and Test Explorer run-profile registration.

**First-run cost.** The first invocation downloads a ~210 MB VS Code binary into `.vscode-test/` (gitignored), so expect about a minute of extra wall time on first run. Subsequent runs reuse the cached binary.

**Visible window on macOS / Windows.** The harness briefly pops a VS Code window while the tests run. That's normal.

**Linux headless runs.** Use `xvfb-run npm run test:integration` — local Linux runs without a display need this. CI does the same: [.github/workflows/ci.yml](.github/workflows/ci.yml) runs `check-types`, `lint`, the vitest suite, and the integration suite (under `xvfb` on Linux) on Ubuntu, Windows, and macOS for every push to `main` and every pull request.

**`ELECTRON_RUN_AS_NODE` gotcha.** [src/test/integration/runTest.ts](src/test/integration/runTest.ts) explicitly unsets `ELECTRON_RUN_AS_NODE` before launching, because some shells export it globally and it breaks Electron startup. Don't re-introduce it.

**Debugging with F5.** The "Extension Tests" configuration in [.vscode/launch.json](.vscode/launch.json) launches the integration suite under the VS Code debugger so you can set breakpoints in the test files and the extension code.

## Type-checking and lint

```bash
npm run check-types
npm run lint
npm run lint:fix
```

`tsconfig.json` is strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`). When adding optional fields to an interface, declare them as `field?: T | undefined` so callers can pass `undefined` explicitly.

## Build and package

```bash
npm run build          # clean + check-types + lint + esbuild
npm run build:prod     # check-types + lint + vitest + esbuild --production
npm run package:vsix   # clean + build:prod + patch-bump version + vsce package into packages/ (filename stamped with version + git sha + dirty marker)
npm run release        # bump version, update CHANGELOG, package, commit, tag (scripts/release.mjs)
```

`release:patch` / `release:minor` / `release:major` choose the bump type; `release:dry-run` previews without writing.

The bundle entry point is [src/extension.ts](src/extension.ts); esbuild emits a single `dist/extension.js` with `vscode` marked external.

## Adding a setting

1. Add the JSON schema entry under `contributes.configuration.properties.playwrightBddRunner.<name>` in [package.json](package.json).
2. Add a getter on [ExtensionConfig](src/core/extension-config.ts) so the rest of the codebase reads it through one place.
3. If it affects command construction, thread it through [CommandBuilder](src/core/command-builder.ts).

## Adding a command

1. Add the entry under `contributes.commands` in [package.json](package.json) with `playwrightBddRunner.<verb>`.
2. Register the handler in [CommandManager.registerCommands()](src/commands/command-manager.ts).
3. If the command should appear in a menu, add it under the matching `contributes.menus.*` entry.

`CommandManager.registerCommands()` is the single source of truth for what's wired up. If you add a command in package.json but not here, it won't do anything. If you add a handler here without a matching package.json entry, it's unreachable (this is what was wrong with `debugFeature` before — drop the handler or add the package.json entry).

## Style

- No emojis in code, comments, or commit messages unless specifically requested.
- Comments are for the WHY, not the WHAT. If a comment is restating the code, delete it.
- Prefer narrow, focused tests over broad scenarios. Unit tests should not require launching VS Code.
- When fixing a bug, write a test that fails without the fix.

## Commit messages

The repo uses [Conventional Commits](https://www.conventionalcommits.org/) via commitlint. Common prefixes:

- `feat:` new functionality
- `fix:` bug fixes
- `refactor:` no behavior change
- `chore:` build/tooling/dependency bumps
- `docs:` documentation only
- `test:` test-only changes
