# Run your first sync

**Sync Traceability** pulls remote metadata, status, and requirement coverage for the tests your scenarios reference, plus the catalog needed to flag orphan tests.

After a sync the **Traceability** tree shows:

- remote **summaries** on mapped-test rows,
- normalized **status badges**,
- **orphan** Xray tests with no local scenario.

Saving an ordinary feature file re-derives the local mapping offline, with no network call. Specwright also schedules one quiet project sync after a confirmed remote create, or when an operation reports that Xray may need reindexing. Run **Sync Traceability** whenever you want an immediate refresh.
