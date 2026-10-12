# Compatibility

This record names exact tested versions. It does not turn a declared package range or a moving tool alias into a broader compatibility claim.

| Component | Exact version | Evidence |
| --- | --- | --- |
| VS Code declared minimum | `1.99.0` | The 2026-10-12 compatible dependency validation passed 29 native tests on macOS. Earlier hosted run `30704907718` passed the minimum lane at commit `6a7fb97d0f93263a7f9bc5099379d4a85fc24b9b`. |
| VS Code pinned current target | `1.132.0` | The 2026-10-12 compatible dependency validation passed 29 native tests on macOS, including rendered progress and named outline retry results. |
| `@playwright/test` | `1.60.0` | Used by the 2026-10-12 local generation, outline targeting, retry, Debug, and native integration checks. |
| `playwright-bdd` | `8.5.1` | Used by the 2026-10-12 local generation, outline targeting, retry, Debug, and native integration checks. |

The supported VS Code range is `^1.99.0`, matching the `engines.vscode` declaration. The table records the minimum lane and the pinned current lane; it does not extend support to an untested host merely because that host satisfies the range.

## Dependency updates

Keep Playwright and playwright-bdd as a tested pair. During the 2026-10-12 compatible dependency update, Playwright `1.64.0` with playwright-bdd `8.5.1` failed in the installed bddgen command while loading `registerESMLoader`, before tests could be generated. The repository stays on the Playwright `1.60` minor line until the playwright-bdd major migration is validated.

This pass updates compatible development dependency lines. Major upgrades to playwright-bdd, Vitest and coverage, jsdom, and extension packaging or test-host tooling remain separate migrations. The declared VS Code minimum and Node API type line are unchanged.

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
