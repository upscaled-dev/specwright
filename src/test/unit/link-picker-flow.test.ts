import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LinkPickerDeps,
  LinkPickerRow,
  LinkPickerUi,
  runLinkPickerFlow,
} from "../../traceability/link-picker-flow";
import { RemoteSearchCapability, RemoteSearchResult } from "../../traceability/contracts";
import { LinkScenarioPick } from "../../traceability/link-scenario";

// A fake port standing in for the webview panel: it records what the flow paints (rows/busy/close)
// and lets the test drive user intent (type/confirm/cancel) — the whole point of keeping the flow
// vscode-free.
class FakeUi implements LinkPickerUi {
  public rows: LinkPickerRow[] = [];
  public busy = false;
  public closed = false;
  public setRowsCalls = 0;
  private search: ((value: string) => void) | undefined;
  private confirm: ((id: string) => void) | undefined;
  private cancel: (() => void) | undefined;

  public setRows(rows: readonly LinkPickerRow[]): void {
    this.rows = [...rows];
    this.setRowsCalls += 1;
  }
  public setBusy(busy: boolean): void {
    this.busy = busy;
  }
  public onSearch(handler: (value: string) => void): void {
    this.search = handler;
  }
  public onConfirm(handler: (id: string) => void): void {
    this.confirm = handler;
  }
  public onCancel(handler: () => void): void {
    this.cancel = handler;
  }
  public close(): void {
    this.closed = true;
  }

  public type(value: string): void {
    this.search?.(value);
  }
  public clickConfirm(id: string): void {
    this.confirm?.(id);
  }
  public clickCancel(): void {
    this.cancel?.();
  }
  public keys(): string[] {
    return this.rows.map((row) => row.key);
  }
  public kinds(): string[] {
    return this.rows.map((row) => row.kind);
  }
}

interface SearchCall {
  text: string;
  signal: AbortSignal | undefined;
  resolve: (result: RemoteSearchResult) => void;
  reject: (error: unknown) => void;
}

function deferredSearch(): { remoteSearch: RemoteSearchCapability; calls: SearchCall[] } {
  const calls: SearchCall[] = [];
  const remoteSearch: RemoteSearchCapability = {
    search: (text, signal) =>
      new Promise<RemoteSearchResult>((resolve, reject) => calls.push({ text, signal, resolve, reject })),
    mergeKeys: () => Promise.resolve(),
  };
  return { remoteSearch, calls };
}

interface Harness {
  ui: FakeUi;
  linked: Array<{ key: string; synced: boolean }>;
  created: { count: number };
  searchErrors: unknown[];
  deps: LinkPickerDeps;
}

function harness(over: Partial<LinkPickerDeps> = {}): Harness {
  const ui = new FakeUi();
  const linked: Array<{ key: string; synced: boolean }> = [];
  const created = { count: 0 };
  const searchErrors: unknown[] = [];
  const base: LinkPickerDeps = {
    ui,
    orphanSuggestions: [],
    localCandidates: [],
    syncedKeys: new Set<string>(),
    linkExisting: (key, synced) => {
      linked.push({ key, synced });
      return Promise.resolve();
    },
    createNew: () => {
      created.count += 1;
      return Promise.resolve();
    },
    logSearchError: (error) => searchErrors.push(error),
  };
  return { ui, linked, created, searchErrors, deps: { ...base, ...over, ui } };
}

// A resolved search promise's then→setRows→finally chain settles over a few microtask turns.
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

const ORPHANS: LinkScenarioPick[] = [
  { key: "CALC-9", summary: "Orphan nine" },
  { key: "CALC-8", summary: "Orphan eight" },
];

describe("runLinkPickerFlow", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows the snapshot's orphan tests on open, before any typing", async () => {
    const h = harness({ orphanSuggestions: ORPHANS });
    const flow = runLinkPickerFlow(h.deps);
    expect(h.ui.keys()).toEqual(["CALC-9", "CALC-8"]);
    expect(h.ui.kinds()).toEqual(["test", "test"]);
    h.ui.clickCancel();
    await flow;
  });

  it("shows an empty list when there are no orphans and no create action", async () => {
    const h = harness();
    const flow = runLinkPickerFlow(h.deps);
    expect(h.ui.rows).toEqual([]);
    h.ui.clickCancel();
    await flow;
  });

  it("pins a create action row above the orphan suggestions when authoring is available", async () => {
    const h = harness({ orphanSuggestions: ORPHANS, createLabel: "Create new Xray test…" });
    const flow = runLinkPickerFlow(h.deps);
    expect(h.ui.kinds()).toEqual(["create", "test", "test"]);
    expect(h.ui.rows[0]!.key).toBe("Create new Xray test…");
    h.ui.clickCancel();
    await flow;
  });

  it("filters the synced snapshot instantly as the user types, with no remote search yet", async () => {
    const { remoteSearch, calls } = deferredSearch();
    const local: LinkScenarioPick[] = [
      { key: "CALC-1", summary: "Login" },
      { key: "CALC-2", summary: "Logout" },
      { key: "PAY-3", summary: "Refund" },
    ];
    const h = harness({ localCandidates: local, remoteSearch });
    const flow = runLinkPickerFlow(h.deps);

    h.ui.type("log");

    expect(h.ui.keys()).toEqual(["CALC-1", "CALC-2"]);
    expect(calls).toHaveLength(0);
    h.ui.clickCancel();
    await flow;
  });

  it("does not fire a remote search below the 3-character threshold", async () => {
    const { remoteSearch, calls } = deferredSearch();
    const h = harness({ localCandidates: [{ key: "AB-1", summary: "x" }], remoteSearch });
    const flow = runLinkPickerFlow(h.deps);

    h.ui.type("ab");
    await vi.advanceTimersByTimeAsync(400);

    expect(calls).toHaveLength(0);
    h.ui.clickCancel();
    await flow;
  });

  it("debounces the remote search by 400ms and issues only the latest query", async () => {
    const { remoteSearch, calls } = deferredSearch();
    const h = harness({ remoteSearch });
    const flow = runLinkPickerFlow(h.deps);

    h.ui.type("abc");
    await vi.advanceTimersByTimeAsync(399);
    expect(calls).toHaveLength(0);

    h.ui.type("abcd");
    await vi.advanceTimersByTimeAsync(399);
    expect(calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe("abcd");

    h.ui.clickCancel();
    await flow;
  });

  it("aborts an in-flight search when a newer query arrives and drops the stale result", async () => {
    const { remoteSearch, calls } = deferredSearch();
    const h = harness({ remoteSearch });
    const flow = runLinkPickerFlow(h.deps);

    h.ui.type("abc");
    await vi.advanceTimersByTimeAsync(400);
    h.ui.type("abcd");
    await vi.advanceTimersByTimeAsync(400);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.signal!.aborted).toBe(true);
    expect(calls[1]!.signal!.aborted).toBe(false);

    calls[0]!.resolve({ tests: [{ key: "STALE-1", summary: "stale" }], complete: true });
    await flush();
    expect(h.ui.keys()).not.toContain("STALE-1");

    calls[1]!.resolve({ tests: [{ key: "FRESH-1", summary: "fresh" }], complete: true });
    await flush();
    expect(h.ui.keys()).toContain("FRESH-1");

    h.ui.clickCancel();
    await flow;
  });

  it("drops a remote result that resolves after the picker is cancelled (dispose-safety)", async () => {
    const { remoteSearch, calls } = deferredSearch();
    const h = harness({ remoteSearch });
    const flow = runLinkPickerFlow(h.deps);

    h.ui.type("abc");
    await vi.advanceTimersByTimeAsync(400);
    h.ui.clickCancel();
    await flow;
    expect(h.ui.closed).toBe(true);

    calls[0]!.resolve({ tests: [{ key: "LATE-1" }], complete: true });
    await flush();

    expect(h.ui.keys()).not.toContain("LATE-1");
    expect(h.searchErrors).toHaveLength(0);
  });

  it("drops a remote result that resolves after a confirm, mutating no UI", async () => {
    const { remoteSearch, calls } = deferredSearch();
    const h = harness({ orphanSuggestions: [{ key: "CALC-9" }], syncedKeys: new Set(["CALC-9"]), remoteSearch });
    const flow = runLinkPickerFlow(h.deps);

    h.ui.type("abc");
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(1);
    h.ui.clickConfirm("CALC-9");
    await flow;

    const settledAt = h.ui.setRowsCalls;
    calls[0]!.resolve({ tests: [{ key: "LATE-1" }], complete: true });
    await flush();

    expect(h.ui.setRowsCalls).toBe(settledAt);
    expect(h.ui.keys()).not.toContain("LATE-1");
  });

  it("drops a stale remote result after the query is reset below 3 chars (list stays reset)", async () => {
    const { remoteSearch, calls } = deferredSearch();
    const h = harness({ localCandidates: [{ key: "AB-1", summary: "alpha" }], remoteSearch });
    const flow = runLinkPickerFlow(h.deps);

    h.ui.type("abc");
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(1);

    // The user deletes down to <3 chars — the list resets to the instant local filter.
    h.ui.type("ab");
    expect(h.ui.keys()).toEqual(["AB-1"]);
    const resetAt = h.ui.setRowsCalls;

    // The earlier in-flight search lands late — it must be dropped, leaving the reset list intact.
    calls[0]!.resolve({ tests: [{ key: "REM-1" }], complete: true });
    await flush();

    expect(h.ui.keys()).toEqual(["AB-1"]);
    expect(h.ui.setRowsCalls).toBe(resetAt);
    h.ui.clickCancel();
    await flow;
  });

  it("shows the 'no matches' hint when a complete remote search returns nothing", async () => {
    const { remoteSearch, calls } = deferredSearch();
    const h = harness({ remoteSearch });
    const flow = runLinkPickerFlow(h.deps);

    h.ui.type("abc");
    await vi.advanceTimersByTimeAsync(400);
    calls[0]!.resolve({ tests: [], complete: true });
    await flush();

    const hint = h.ui.rows.find((row) => row.kind === "hint");
    expect(hint?.key).toContain("No matches");
    h.ui.clickCancel();
    await flow;
  });

  it("shows the 'did not complete' hint when the remote search reports incomplete", async () => {
    const { remoteSearch, calls } = deferredSearch();
    const h = harness({ remoteSearch });
    const flow = runLinkPickerFlow(h.deps);

    h.ui.type("abc");
    await vi.advanceTimersByTimeAsync(400);
    calls[0]!.resolve({ tests: [], complete: false });
    await flush();

    const hint = h.ui.rows.find((row) => row.kind === "hint");
    expect(hint?.key).toContain("did not complete");
    h.ui.clickCancel();
    await flow;
  });

  it("confirms a synced orphan by writing its tag, then closes the picker", async () => {
    const h = harness({ orphanSuggestions: [{ key: "CALC-9", summary: "nine" }], syncedKeys: new Set(["CALC-9"]) });
    const flow = runLinkPickerFlow(h.deps);

    h.ui.clickConfirm("CALC-9");
    await flow;

    expect(h.linked).toEqual([{ key: "CALC-9", synced: true }]);
    expect(h.ui.closed).toBe(true);
    expect(h.created.count).toBe(0);
  });

  it("links a remote (unsynced) result as unsynced so the caller merges its metadata", async () => {
    const { remoteSearch, calls } = deferredSearch();
    const h = harness({ remoteSearch });
    const flow = runLinkPickerFlow(h.deps);

    h.ui.type("abc");
    await vi.advanceTimersByTimeAsync(400);
    calls[0]!.resolve({ tests: [{ key: "REM-1", summary: "remote" }], complete: true });
    await flush();
    expect(h.ui.keys()).toContain("REM-1");

    h.ui.clickConfirm("REM-1");
    await flow;

    expect(h.linked).toEqual([{ key: "REM-1", synced: false }]);
  });

  it("writes nothing when the picker is cancelled", async () => {
    const h = harness({ orphanSuggestions: ORPHANS });
    const flow = runLinkPickerFlow(h.deps);

    h.ui.clickCancel();
    await flow;

    expect(h.linked).toEqual([]);
    expect(h.created.count).toBe(0);
    expect(h.ui.closed).toBe(true);
  });

  it("confirming the create row authors a new test instead of writing a tag", async () => {
    const h = harness({ orphanSuggestions: ORPHANS, createLabel: "Create new Xray test…" });
    const flow = runLinkPickerFlow(h.deps);

    const createRow = h.ui.rows[0]!;
    expect(createRow.kind).toBe("create");
    h.ui.clickConfirm(createRow.id);
    await flow;

    expect(h.created.count).toBe(1);
    expect(h.linked).toEqual([]);
  });

  it("ignores a confirm or cancel after the flow has already settled", async () => {
    const h = harness({ orphanSuggestions: [{ key: "CALC-9" }], syncedKeys: new Set(["CALC-9"]) });
    const flow = runLinkPickerFlow(h.deps);

    h.ui.clickConfirm("CALC-9");
    await flow;
    h.ui.clickConfirm("CALC-9");
    h.ui.clickCancel();

    expect(h.linked).toEqual([{ key: "CALC-9", synced: true }]);
  });
});
