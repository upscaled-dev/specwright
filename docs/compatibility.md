# Compatibility

This record names exact tested versions. It does not turn a declared package range or a moving tool alias into a broader compatibility claim.

| Component | Exact version | Evidence |
| --- | --- | --- |
| VS Code declared minimum | `1.99.0` | Hosted run `30704907718` passed the minimum lane at commit `6a7fb97d0f93263a7f9bc5099379d4a85fc24b9b`. |
| VS Code pinned current target | `1.132.0` | The 2026-08-03 local W3B integration gate passed 22 Extension Host tests. The earlier hosted run used the moving `stable` alias, so it does not prove this exact version. |
| `@playwright/test` | `1.60.0` | The lockfile version installed by the hosted W2C and local W3B gates. |
| `playwright-bdd` | `8.5.1` | The lockfile version installed by the hosted W2C and local W3B gates. |

CI now pins both VS Code integration targets. The `1.132.0` target still needs a successful hosted run before QA-001 acceptance. Update this record, the lockfile, and the CI targets together; the release contract test rejects drift.
