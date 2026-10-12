# Compatibility

This record names exact tested versions. It does not turn a declared package range or a moving tool alias into a broader compatibility claim.

| Component | Exact version | Evidence |
| --- | --- | --- |
| VS Code declared minimum | `1.99.0` | The 2026-10-12 paired dependency migration passed 30 native tests on macOS, including actual Debug of one named outline row. Earlier hosted run `30704907718` passed the minimum lane at commit `6a7fb97d0f93263a7f9bc5099379d4a85fc24b9b`. |
| VS Code pinned current target | `1.132.0` | The 2026-10-12 paired dependency migration passed 30 native tests on macOS, including rendered progress, named outline retry results, and actual Debug. |
| `@playwright/test` | `1.64.0` | Used by the 2026-10-12 local generation, outline targeting, retry, actual Debug, and both full native host checks on macOS. |
| `playwright-bdd` | `9.2.1` | Used by the 2026-10-12 local generation, outline targeting, retry, actual Debug, and both full native host checks on macOS. |

The supported VS Code range is `^1.99.0`, matching the `engines.vscode` declaration. The table records the minimum lane and the pinned current lane; it does not extend support to an untested host merely because that host satisfies the range.

## Dependency updates

Keep Playwright and playwright-bdd as a tested pair. During the 2026-10-12 compatible dependency update, Playwright `1.64.0` with playwright-bdd `8.5.1` failed in the installed bddgen command while loading `registerESMLoader`, before tests could be generated. The paired migration replaces that combination with Playwright `1.64.0` and playwright-bdd `9.2.1`. Playwright is bounded to `~1.64.0` so a dependency update cannot silently select an untested minor.

These are the repository's development dependencies. Commands in user workspaces continue to resolve their workspace's installed packages. The declared VS Code minimum and Node API type line are unchanged. Major upgrades to Vitest and coverage, jsdom, and extension packaging or test-host tooling remain separate migrations.

playwright-bdd 9 requires Node.js 20 or newer and validates step callback argument counts against captured parameters, doc strings, and data tables. With captures, a Playwright-style callback includes the fixtures object before its captured parameters. Its Cucumber JSON reporter omits attachments by default; this does not change the Playwright JSON report consumed by Specwright. These changes are described in the [upstream release notes](https://github.com/vitalets/playwright-bdd/blob/main/CHANGELOG.md).

Focused acceptance passed installed bddgen and Playwright for same-titled outline targeting, successful retries, and Debug. Native acceptance passed Testing and editor progress, distinct generic outline retry identities, green retry results, and actual Debug of the named first row without running its siblings. The complete gate passed all four type-check projects, lint, 3,510 unit tests with enforced coverage, production bundling, and 18 release contracts. Both VS Code hosts (`1.99.0` and `1.132.0`) passed 30 native tests. Three unit tests were skipped, and three Windows-only native cases remain pending on macOS. Exact VSIX inventory and installation, activation, and fixture discovery passed. Windows and Linux execution remain with their native CI lanes.

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
