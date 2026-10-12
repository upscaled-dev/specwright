# Compatibility

This record names exact tested versions. It does not turn a declared package range or a moving tool alias into a broader compatibility claim.

| Component | Exact version | Evidence |
| --- | --- | --- |
| VS Code declared minimum | `1.99.0` | The 2026-10-12 paired dependency migration passed 30 native tests on macOS, including actual Debug of one named outline row. Earlier hosted run `30704907718` passed the minimum lane at commit `6a7fb97d0f93263a7f9bc5099379d4a85fc24b9b`. |
| VS Code pinned current target | `1.132.0` | The 2026-10-12 paired dependency migration passed 30 native tests on macOS, including rendered progress, named outline retry results, and actual Debug. |
| `@playwright/test` | `1.64.0` | Used by the 2026-10-12 local generation, outline targeting, retry, actual Debug, and both full native host checks on macOS. |
| `playwright-bdd` | `9.2.1` | Used by the 2026-10-12 local generation, outline targeting, retry, actual Debug, and both full native host checks on macOS. |
| `vitest` | `5.0.3` | Real BDD targeting, retry/Debug, mock/timer checks, watch pass/fail/recovery, and the complete validation gate passed on development Node 24.21.0. |
| `@vitest/coverage-v8` | `5.0.3` | Reports the same 203 source files as the previous provider. Interim floors follow the reviewed AST mapper baseline; the future 95% target is separate work. |
| `jsdom` | `30.1.2` | Populated bundled Board, Traceability, and Xray setup clients pass their existing rendering, interaction, keyboard/focus, and accessibility checks on Node 24.21.0. |
| `@types/jsdom` | `30.0.0` | Installed with jsdom 30.1.2; all four TypeScript projects pass. |

The supported VS Code range is `^1.99.0`, matching the `engines.vscode` declaration. The table records the minimum lane and the pinned current lane; it does not extend support to an untested host merely because that host satisfies the range.

## Dependency updates

Keep Playwright and playwright-bdd as a tested pair. During the 2026-10-12 compatible dependency update, Playwright `1.64.0` with playwright-bdd `8.5.1` failed in the installed bddgen command while loading `registerESMLoader`, before tests could be generated. The paired migration replaces that combination with Playwright `1.64.0` and playwright-bdd `9.2.1`. Playwright is bounded to `~1.64.0` so a dependency update cannot silently select an untested minor.

These are the repository's development dependencies. Commands in user workspaces continue to resolve their workspace's installed packages. The declared VS Code minimum is unchanged. Node development tooling and typings now follow the 24 LTS line. Major upgrades to extension packaging or test-host tooling remain separate migrations.

playwright-bdd 9 requires Node.js 20 or newer and validates step callback argument counts against captured parameters, doc strings, and data tables. With captures, a Playwright-style callback includes the fixtures object before its captured parameters. Its Cucumber JSON reporter omits attachments by default; this does not change the Playwright JSON report consumed by Specwright. These changes are described in the [upstream release notes](https://github.com/vitalets/playwright-bdd/blob/main/CHANGELOG.md).

Focused acceptance passed installed bddgen and Playwright for same-titled outline targeting, successful retries, and Debug. Native acceptance passed Testing and editor progress, distinct generic outline retry identities, green retry results, and actual Debug of the named first row without running its siblings. The complete gate passed all four type-check projects, lint, 3,510 unit tests with enforced coverage, production bundling, and 18 release contracts. Both VS Code hosts (`1.99.0` and `1.132.0`) passed 30 native tests. Three unit tests were skipped, and three Windows-only native cases remain pending on macOS. Exact VSIX inventory and installation, activation, and fixture discovery passed. Windows and Linux execution remain with their native CI lanes.

## Unit-test runner and Node typings

Vitest and its V8 coverage provider use the matching `5.0.3` versions. Vitest 5's Node typing peer does not accept the previous Node 20 types, so `@types/node` now uses `24.19.2` with the pinned Node `24.21.0` development runtime. VS Code supplies its own embedded runtime: the minimum `1.99.0` host uses Node `20.18.3` and Electron `34.3.2`. Production Node API calls are unchanged in this migration. Check new Node API usage against the minimum host's embedded runtime.

The new AST mapper reports lines `83.56%`, statements `81.22%`, functions `83.07%`, and branches `77.22%` after the same 3,510 tests pass. All 203 reported source files and the coverage include/exclude patterns remain unchanged. The temporary migration floors are statements `81%`, branches `77%`, and functions and lines `83%`, rounded down from this reviewed mapper baseline. This records a measurement change without adding coverage tests. Expanding meaningful source coverage and raising all four floors to `95%` is deferred to a separate task. See the [Vitest 4 coverage migration notes](https://v4.vitest.dev/guide/migration.html#v8-code-coverage-major-changes) and [Vitest 5 migration guide](https://vitest.dev/guide/migration/).

The final gate passed all four TypeScript projects, lint, 3,510 unit tests with three existing skips, the temporary coverage floors, and production bundling. A separate negative probe rejected each coverage floor, and the report retained the same 203 files. Both VS Code hosts (`1.99.0` and `1.132.0`) passed 30 native tests, with three Windows-only cases pending on macOS. All six production JavaScript bundles were unchanged. The VSIX contained exactly the expected 31 payload files without configuration or source leakage; clean-profile installation, activation, and named fixture discovery passed on `1.132.0`. Independent Astra review accepted the migration with no remaining findings.

## Browser-test DOM

jsdom `30.1.2` and `@types/jsdom` `30.0.0` are development-only dependencies. The pinned Node `24.21.0` runtime meets jsdom's Node `^22.22.2 || ^24.15.0 || >=26.0.0` requirement. This does not change VS Code's embedded runtime or the extension's declared minimum.

The migration from jsdom 26 crosses changes to CSS selectors and computed styles, default click events, and focus behavior. Existing tests execute the actual bundled clients. They render the named `SHOP-10000` test from three synced projects, filter and page the Matrix, retain keyboard focus through repaints, run named `SHOP-301` and nested repository selections, and keep setup secrets out of persisted client state. All 221 tests across the eight jsdom consumer suites pass without production or test-helper changes. See the [jsdom 27 changes](https://github.com/jsdom/jsdom/releases/tag/27.0.0), [jsdom 30 requirements](https://github.com/jsdom/jsdom/releases/tag/v30.0.0), and [30.1.2 fixes](https://github.com/jsdom/jsdom/releases/tag/v30.1.2).

Clean installation and the complete gate passed: all four TypeScript projects, lint, 3,510 unit tests with three existing skips, coverage, 18 release contracts, and production bundling. The coverage metrics and all 203 reported files are unchanged from the Vitest 5 baseline above. All six production JavaScript bundles are byte-identical to that accepted baseline, so its passing evidence on both native VS Code hosts remains applicable. The VSIX contains exactly the expected 31 payload files. Clean-profile installation, activation, and named fixture discovery passed on VS Code `1.132.0`. Independent Astra review accepted the migration with no remaining findings.

## TypeScript compiler and API

The `@typescript/native` alias installs TypeScript `7.0.2` and supplies `tsc` for type checking, watch mode, and integration compilation. The `typescript` alias installs `@typescript/typescript6` version `6.0.2`, which supplies the TypeScript `6.0.3` API used by ESLint and the separate `tsc6` command. A clean install verifies that each command and the ESLint parser resolve to the intended version.

The esbuild projects use bundler resolution. Browser code uses ESNext modules, while the integration project uses Node16 module resolution and emits CommonJS for the existing Extension Host runner. Strict checking remains enabled.

The 2026-10-12 migration passed clean installation, all four type-check projects, lint, watch-mode error detection and recovery, 3,510 unit tests with enforced coverage, and 18 release contracts on macOS. The native suite passed 29 tests on each VS Code host (`1.99.0` and `1.132.0`), with three Windows-only cases pending on macOS. The packaged extension passed installation, activation, and fixture discovery. Windows and Linux execution remain with their native CI lanes.

## Ownership and review

Repository maintainers own this record. Review it when changing `engines.vscode`, integration targets, the lockfile versions listed above, or release evidence. Review it at least once per release cycle and record only evidence available in this repository or its CI history.

## Deprecation policy

| Change | Maintainer action | Record update |
| --- | --- | --- |
| Raise the VS Code minimum | Update `engines.vscode`, both integration lanes, and this table together. | State the new minimum and its passing evidence. |
| Replace the pinned current host lane | Replace it after the newer exact lane passes. Keep the minimum lane until `engines.vscode` moves. | State the replacement version and passing evidence. |
| Replace a dependency compatibility boundary | Preserve the previous evidence until the replacement has passing evidence. | Add the replacement version and evidence before removing the prior row. |

The release contract test rejects drift between this record, the lockfile, and CI targets where those checks apply.
