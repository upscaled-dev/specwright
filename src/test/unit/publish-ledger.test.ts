import { describe, it, expect } from "vitest";
import type { Memento } from "vscode";
import {
  findLedgerEntry,
  LedgerEntry,
  PublishLedger,
  withLedgerEntry,
  withUpdatedPending,
} from "../../traceability/publish-ledger";
import { Logger, LogLevel } from "../../utils/logger";

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    artifactId: "run-1",
    executionRef: "XNP-1",
    site: "acme.atlassian.net",
    account: "client-1",
    publishedAt: 1000,
    pendingAttachments: [],
    ...over,
  };
}

function fakeMemento(seed: unknown = undefined): Memento & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  if (seed !== undefined) {
    store.set("specwright.publishLedger", seed);
  }
  return {
    store,
    keys: () => [...store.keys()],
    get: <T>(key: string, dflt?: T): T | undefined => (store.has(key) ? (store.get(key) as T) : dflt),
    update: (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
      return Promise.resolve();
    },
  } as unknown as Memento & { store: Map<string, unknown> };
}

const logger = Logger.create(undefined, LogLevel.ERROR);

describe("withLedgerEntry", () => {
  it("prepends the newest entry", () => {
    const list = withLedgerEntry([entry({ artifactId: "old" })], entry({ artifactId: "new" }));
    expect(list.map((e) => e.artifactId)).toEqual(["new", "old"]);
  });

  it("caps the ledger at fifty entries", () => {
    let list: LedgerEntry[] = [];
    for (let i = 0; i < 55; i++) {
      list = withLedgerEntry(list, entry({ artifactId: `run-${i}` }));
    }
    expect(list).toHaveLength(50);
    expect(list[0]!.artifactId).toBe("run-54");
    expect(list[49]!.artifactId).toBe("run-5");
  });

  it("carries the recorded summary, mode, counts, and total through", () => {
    const [recorded] = withLedgerEntry([], entry({ summary: "Nightly", mode: "create-new", passed: 3, failed: 1, skipped: 2, total: 6 }));
    expect(recorded).toMatchObject({ summary: "Nightly", mode: "create-new", passed: 3, failed: 1, skipped: 2, total: 6 });
  });
});

describe("findLedgerEntry", () => {
  const entries = [
    entry({ artifactId: "run-1", executionRef: "XNP-1", site: "acme.atlassian.net" }),
    entry({ artifactId: "run-1", executionRef: "OTHER-9", site: "other.atlassian.net" }),
  ];

  it("returns the entry matching the artifact on the current site", () => {
    expect(findLedgerEntry(entries, "run-1", "acme.atlassian.net")?.executionRef).toBe("XNP-1");
  });

  it("is site-scoped — an entry from another site is not a match", () => {
    expect(findLedgerEntry(entries, "run-1", "third.atlassian.net")).toBeUndefined();
  });

  it("returns undefined for an unknown artifact", () => {
    expect(findLedgerEntry(entries, "run-99", "acme.atlassian.net")).toBeUndefined();
  });
});

describe("withUpdatedPending", () => {
  const entries = [
    entry({ artifactId: "run-1", site: "acme.atlassian.net", pendingAttachments: ["/a", "/b"] }),
    entry({ artifactId: "run-1", site: "other.atlassian.net", pendingAttachments: ["/c"] }),
  ];

  it("replaces the matching entry's pending list, leaving other-site entries untouched", () => {
    const updated = withUpdatedPending(entries, "run-1", "acme.atlassian.net", ["/b"]);
    expect(updated[0]!.pendingAttachments).toEqual(["/b"]);
    expect(updated[1]!.pendingAttachments).toEqual(["/c"]);
  });

  it("is a no-op when nothing matches", () => {
    expect(withUpdatedPending(entries, "run-9", "acme.atlassian.net", [])).toEqual(entries);
  });
});

describe("PublishLedger", () => {
  it("records, persists, and finds an entry", () => {
    const memento = fakeMemento();
    const ledger = new PublishLedger(memento, logger);
    ledger.record(entry({ artifactId: "run-1", executionRef: "XNP-5" }));

    expect(ledger.find("run-1", "acme.atlassian.net")?.executionRef).toBe("XNP-5");
    expect(Array.isArray(memento.store.get("specwright.publishLedger"))).toBe(true);
  });

  it("loads existing entries from the memento, dropping malformed ones", () => {
    const memento = fakeMemento([
      entry({ artifactId: "good" }),
      { artifactId: "bad" }, // missing required fields
    ]);
    const ledger = new PublishLedger(memento, logger);
    expect(ledger.find("good", "acme.atlassian.net")).toBeDefined();
    expect(ledger.find("bad", "acme.atlassian.net")).toBeUndefined();
  });

  it("reads back a v1 entry that predates the counts, leaving them absent", () => {
    // A v1 entry carries only the original required fields — no summary/mode/counts.
    const v1 = {
      artifactId: "v1",
      executionRef: "XNP-1",
      site: "acme.atlassian.net",
      account: "client-1",
      publishedAt: 1000,
      pendingAttachments: [],
    };
    const ledger = new PublishLedger(fakeMemento([v1]), logger);
    const loaded = ledger.find("v1", "acme.atlassian.net");
    expect(loaded).toBeDefined();
    expect(loaded?.passed).toBeUndefined();
    expect(loaded?.mode).toBeUndefined();
    expect(loaded?.summary).toBeUndefined();
  });

  it("records and reads back the counts, summary, mode, and total", () => {
    const memento = fakeMemento();
    const ledger = new PublishLedger(memento, logger);
    ledger.record(entry({ artifactId: "run-1", summary: "Nightly", mode: "append", passed: 4, failed: 0, skipped: 1, total: 5 }));

    expect(ledger.find("run-1", "acme.atlassian.net")).toMatchObject({
      summary: "Nightly",
      mode: "append",
      passed: 4,
      failed: 0,
      skipped: 1,
      total: 5,
    });
  });

  it("drops an entry whose optional fields are the wrong type (corrupt store)", () => {
    const memento = fakeMemento([
      { ...entry({ artifactId: "bad-summary" }), summary: 7 },
      { ...entry({ artifactId: "bad-mode" }), mode: "sideways" },
      { ...entry({ artifactId: "bad-count" }), passed: "3" },
      entry({ artifactId: "good", mode: "create-new", passed: 1, failed: 0, skipped: 0, total: 1 }),
    ]);
    const ledger = new PublishLedger(memento, logger);
    expect(ledger.find("bad-summary", "acme.atlassian.net")).toBeUndefined();
    expect(ledger.find("bad-mode", "acme.atlassian.net")).toBeUndefined();
    expect(ledger.find("bad-count", "acme.atlassian.net")).toBeUndefined();
    expect(ledger.find("good", "acme.atlassian.net")).toBeDefined();
  });

  it("renders entries for the current site only", () => {
    const memento = fakeMemento([
      entry({ artifactId: "a", site: "acme.atlassian.net" }),
      entry({ artifactId: "b", site: "other.atlassian.net" }),
    ]);
    const ledger = new PublishLedger(memento, logger);
    expect(ledger.entriesForSite("acme.atlassian.net").map((e) => e.artifactId)).toEqual(["a"]);
  });

  it("updates pending attachments and persists (resume/retry clears cleared files)", () => {
    const memento = fakeMemento();
    const ledger = new PublishLedger(memento, logger);
    ledger.record(entry({ artifactId: "run-1", pendingAttachments: ["/a", "/b"] }));

    ledger.setPendingAttachments("run-1", "acme.atlassian.net", ["/b"]);
    expect(ledger.find("run-1", "acme.atlassian.net")?.pendingAttachments).toEqual(["/b"]);

    ledger.setPendingAttachments("run-1", "acme.atlassian.net", []);
    expect(ledger.find("run-1", "acme.atlassian.net")?.pendingAttachments).toEqual([]);
    const persisted = memento.store.get("specwright.publishLedger") as LedgerEntry[];
    expect(persisted[0]!.pendingAttachments).toEqual([]);
  });
});
