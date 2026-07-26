import { RemoteSearchCapability } from "./contracts";
import { LinkScenarioPick } from "./link-scenario";

export type LinkPickerRowKind = "test" | "create" | "hint";

export interface LinkPickerRow {
  readonly id: string;
  readonly key: string;
  readonly summary?: string | undefined;
  readonly kind: LinkPickerRowKind;
}

// A test the scenario already carries a `@TEST_` tag for. Rendered above the search as an
// informational row (never navigable, never confirmable) with open/unlink mouse actions. `summary` is
// the snapshot's cached remote summary; `remoteMissing` marks a key the snapshot proved absent.
export interface LinkedRow {
  readonly key: string;
  readonly summary?: string | undefined;
  readonly remoteMissing?: boolean | undefined;
}

// The port the webview panel implements. The flow owns all decision logic (candidate assembly, the
// ≥3-char remote gate, the 400ms debounce, and abort/supersede); the panel is a thin renderer that
// forwards user intent (search/confirm/cancel) and paints whatever rows the flow hands it. Keeping
// this vscode-free is what makes the whole picker unit-testable through a fake UI.
export interface LinkPickerUi {
  setRows(rows: readonly LinkPickerRow[]): void;
  // The already-linked tests shown above the search; an empty list hides the whole "Linked" section.
  setLinked(rows: readonly LinkedRow[]): void;
  setBusy(busy: boolean): void;
  onSearch(handler: (value: string) => void): void;
  onConfirm(handler: (id: string) => void): void;
  onCancel(handler: () => void): void;
  onOpenLinked(handler: (key: string) => void): void;
  onUnlink(handler: (key: string) => void): void;
  close(): void;
}

export interface LinkPickerDeps {
  readonly ui: LinkPickerUi;
  // The tests the scenario already carries `@TEST_` tags for, the dialog's "Linked" section.
  readonly linkedTests: readonly LinkedRow[];
  // Shown before any typing: the snapshot's orphan tests, the best link candidates by definition.
  readonly orphanSuggestions: readonly LinkScenarioPick[];
  // The synced snapshot, filtered instantly as the user types (no network).
  readonly localCandidates: readonly LinkScenarioPick[];
  // Keys already in the local snapshot; remote results dedupe against these, and a confirm reads it
  // to decide whether the picked test needs a background metadata merge.
  readonly syncedKeys: ReadonlySet<string>;
  // Present only when the adapter can author; pins a "create a new test" action row on top.
  readonly createLabel?: string | undefined;
  readonly remoteSearch?: RemoteSearchCapability | undefined;
  // The idempotent `@TEST_<key>` insert (+ background merge for an unsynced pick), reused verbatim.
  linkExisting(key: string, synced: boolean): Promise<void>;
  createNew(): Promise<void>;
  // Open the linked test in the tracker's browser view. Fire and forget; the dialog stays open.
  openLinked(key: string): void;
  // Remove the `@TEST_<key>` tag from the scenario. Resolves once the edit has landed.
  unlink(key: string): Promise<void>;
  logSearchError(error: unknown): void;
  logUnlinkError(error: unknown): void;
}

const CREATE_ROW_ID = " create";
const HINT_ROW_ID = " hint";
const REMOTE_MIN_CHARS = 3;
const SEARCH_DEBOUNCE_MS = 400;
// Reused verbatim from the retired QuickPick so the remote section's feedback wording is unchanged.
const NO_MATCHES_HINT = "No matches, or the summary field isn't searchable with these credentials";
const INCOMPLETE_HINT = "Search did not complete, try again";

function toRow(pick: LinkScenarioPick): LinkPickerRow {
  return { id: pick.key, key: pick.key, kind: "test", ...(pick.summary !== undefined ? { summary: pick.summary } : {}) };
}

function filterPicks(picks: readonly LinkScenarioPick[], query: string): LinkScenarioPick[] {
  const needle = query.toLowerCase();
  return picks.filter(
    (pick) => pick.key.toLowerCase().includes(needle) || (pick.summary ?? "").toLowerCase().includes(needle)
  );
}

/**
 * The link-target picker flow, isolated from VS Code. On open the list is the snapshot's orphan tests;
 * typing filters the synced snapshot instantly and, when the adapter exposes remote search, appends a
 * debounced (400ms) ≥3-char Xray search with abort/supersede so a stale result never clobbers a fresh
 * one and a sub-threshold reset can't be overwritten by an earlier search landing. Confirming an
 * existing row runs the verbatim tag-write path; confirming the pinned create row authors a new test;
 * cancel/close writes nothing. Resolves once a terminal (confirm/cancel/close) has settled.
 */
export function runLinkPickerFlow(deps: LinkPickerDeps): Promise<void> {
  const { ui } = deps;
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let searchToken = 0;
    let controller: AbortController | undefined;
    let done = false;
    let linked: readonly LinkedRow[] = deps.linkedTests;
    let query = "";

    const supersede = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      searchToken += 1;
      controller?.abort();
      controller = undefined;
      ui.setBusy(false);
    };

    const withCreate = (rows: readonly LinkPickerRow[]): LinkPickerRow[] => (
      deps.createLabel !== undefined
        ? [{ id: CREATE_ROW_ID, key: deps.createLabel, kind: "create" }, ...rows]
        : [...rows]
    );

    const localRows = (query: string): LinkPickerRow[] => (
      query === ""
        ? withCreate(deps.orphanSuggestions.map(toRow))
        : withCreate(filterPicks(deps.localCandidates, query).map(toRow))
    );

    const runSearch = (query: string): void => {
      const remoteSearch = deps.remoteSearch;
      if (remoteSearch === undefined) {
        return;
      }
      const token = (searchToken += 1);
      const active = new AbortController();
      controller = active;
      ui.setBusy(true);
      remoteSearch
        .search(query, active.signal)
        .then((result) => {
          if (done || token !== searchToken) {
            return;
          }
          const remoteRows = result.tests
            .filter((test) => !deps.syncedKeys.has(test.key))
            .map((test): LinkPickerRow => ({
              id: test.key,
              key: test.key,
              kind: "test",
              ...(test.summary !== undefined ? { summary: test.summary } : {}),
            }));
          const rows: LinkPickerRow[] = [...localRows(query), ...remoteRows];
          // No remote matches → the QuickPick's honest feedback: a "no matches" note on a complete
          // fetch, a "did not complete" note when the fetch paged short. Rendered non-interactively.
          if (remoteRows.length === 0) {
            rows.push({ id: HINT_ROW_ID, key: result.complete ? NO_MATCHES_HINT : INCOMPLETE_HINT, kind: "hint" });
          }
          ui.setRows(rows);
        })
        .catch((error: unknown) => {
          if (done || token !== searchToken) {
            return;
          }
          deps.logSearchError(error);
        })
        .finally(() => {
          if (!done && token === searchToken) {
            ui.setBusy(false);
          }
        });
    };

    ui.onSearch((value) => {
      supersede();
      query = value.trim();
      ui.setRows(localRows(query));
      if (deps.remoteSearch !== undefined && query.length >= REMOTE_MIN_CHARS) {
        timer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
      }
    });

    ui.onOpenLinked((key) => {
      if (!done) {
        deps.openLinked(key);
      }
    });

    // Unlink drops the row and re-derives candidates: the just-unlinked test is now re-linkable and,
    // if it was the scenario's last tag, the scenario is untraced again; the fresh local rows reflect
    // both. An in-flight remote search is superseded so its late result can't repaint a stale list.
    // A key already being unlinked is ignored, so a double-click can't fire a second edit that (with
    // the first row already gone) would target the wrong line. A failed edit keeps the row and the
    // session alive; it is logged, never propagated, so the modal is never orphaned mid-flight.
    const unlinking = new Set<string>();
    ui.onUnlink((key) => {
      if (done || unlinking.has(key)) {
        return;
      }
      unlinking.add(key);
      deps.unlink(key).then(
        () => {
          unlinking.delete(key);
          if (done) {
            return;
          }
          linked = linked.filter((row) => row.key !== key);
          supersede();
          ui.setLinked(linked);
          ui.setRows(localRows(query));
        },
        (error) => {
          unlinking.delete(key);
          deps.logUnlinkError(error);
        }
      );
    });

    ui.onConfirm((id) => {
      if (done) {
        return;
      }
      done = true;
      supersede();
      ui.close();
      const effect = id === CREATE_ROW_ID ? deps.createNew() : deps.linkExisting(id, deps.syncedKeys.has(id));
      effect.then(() => resolve(), (error) => reject(error));
    });

    ui.onCancel(() => {
      if (done) {
        return;
      }
      done = true;
      supersede();
      ui.close();
      resolve();
    });

    ui.setLinked(linked);
    ui.setRows(localRows(""));
  });
}
