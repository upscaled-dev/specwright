import { describe, it, expect } from "vitest";
import type { Memento } from "vscode";
import {
  findLedgerEntry,
  LedgerEntry,
  PublishLedger,
  withLedgerEntry,
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

  it("caps the ledger at ten entries", () => {
    let list: LedgerEntry[] = [];
    for (let i = 0; i < 15; i++) {
      list = withLedgerEntry(list, entry({ artifactId: `run-${i}` }));
    }
    expect(list).toHaveLength(10);
    expect(list[0]!.artifactId).toBe("run-14");
    expect(list[9]!.artifactId).toBe("run-5");
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

  it("renders entries for the current site only", () => {
    const memento = fakeMemento([
      entry({ artifactId: "a", site: "acme.atlassian.net" }),
      entry({ artifactId: "b", site: "other.atlassian.net" }),
    ]);
    const ledger = new PublishLedger(memento, logger);
    expect(ledger.entriesForSite("acme.atlassian.net").map((e) => e.artifactId)).toEqual(["a"]);
  });
});
