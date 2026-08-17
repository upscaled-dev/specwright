# Compatibility

This record names exact tested versions. It does not turn a declared package range or a moving tool alias into a broader compatibility claim.

| Component | Exact version | Evidence |
| --- | --- | --- |
| VS Code declared minimum | `1.99.0` | Hosted run `30704907718` passed the minimum lane at commit `6a7fb97d0f93263a7f9bc5099379d4a85fc24b9b`. |
| VS Code pinned current target | `1.132.0` | The 2026-08-03 local W3B integration gate passed 22 Extension Host tests. The earlier hosted run used the moving `stable` alias, so it does not prove this exact version. |
| `@playwright/test` | `1.60.0` | The lockfile version installed by the hosted W2C and local W3B gates. |
| `playwright-bdd` | `8.5.1` | The lockfile version installed by the hosted W2C and local W3B gates. |

The supported VS Code range is `^1.99.0`, matching the `engines.vscode` declaration. The table records the minimum lane and the pinned current lane; it does not extend support to an untested host merely because that host satisfies the range.

## Ownership and review

Repository maintainers own this record. Review it when changing `engines.vscode`, integration targets, the lockfile versions listed above, or release evidence. Review it at least once per release cycle and record only evidence available in this repository or its CI history.

## Deprecation policy

| Change | Maintainer action | Record update |
| --- | --- | --- |
| Raise the VS Code minimum | Update `engines.vscode`, both integration lanes, and this table together. | State the new minimum and its passing evidence. |
| Replace the pinned current host lane | Replace it after the newer exact lane passes. Keep the minimum lane until `engines.vscode` moves. | State the replacement version and passing evidence. |
| Replace a dependency compatibility boundary | Preserve the previous evidence until the replacement has passing evidence. | Add the replacement version and evidence before removing the prior row. |

The release contract test rejects drift between this record, the lockfile, and CI targets where those checks apply.
