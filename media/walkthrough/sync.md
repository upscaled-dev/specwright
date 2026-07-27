# Run your first Sync

**Sync** is the only action that fetches from Xray. It pulls remote metadata, status, and requirement coverage for the tests your scenarios reference, plus the catalog needed to flag orphan tests.

After a sync the **Traceability** tree shows:

- remote **summaries** on mapped-test rows,
- normalized **status badges**,
- **orphan** Xray tests with no local scenario.

Sync is manual. Saving a feature file re-derives the local mapping offline, with no network call. Re-run **Sync with Xray** whenever you want fresh remote data.
