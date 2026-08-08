import { describe, it, expect } from "vitest";
import type { Memento } from "vscode";
import * as vscode from "vscode";
import {
  findLedgerEntry,
  LedgerEntry,
  PublishLedger,
  PublishLedgerPersistenceError,
  STANDALONE_ARTIFACT_PREFIX,
  withLedgerEntry,
  withUpdatedPending,
} from "../../traceability/publish-ledger";
import { buildExecutionRows } from "../../traceability/board-data";
import { Logger, LogLevel } from "../../utils/logger";

function entry(over: Omit<Partial<LedgerEntry>, "pendingAttachments"> & { pendingAttachments?: readonly unknown[] } = {}): LedgerEntry {
  return {
    artifactId: "run-1",
    executionRef: "XNP-1",
    site: "acme.atlassian.net",
    account: "client-1",
    publishedAt: 1000,
    pendingAttachments: [],
    ...over,
  } as LedgerEntry;
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

function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const channel = {
    name: "test",
    append: () => undefined,
    appendLine: (line: string): void => {lines.push(line);},
    replace: () => undefined,
    clear: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  } as unknown as vscode.OutputChannel;
  return { logger: Logger.create(channel, LogLevel.DEBUG), lines };
}

const snapshot = (name: string) => ({
  ref: `${name.charCodeAt(0).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
  name: `${name}.zip`,
  size: 1,
  sha256: "a".repeat(64),
  createdAt: 1,
});

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

  it("is site-scoped: an entry from another site is not a match", () => {
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
    const updated = withUpdatedPending(entries, "run-1", "acme.atlassian.net", ["/b"] as never);
    expect(updated[0]!.pendingAttachments).toEqual(["/b"]);
    expect(updated[1]!.pendingAttachments).toEqual(["/c"]);
  });

  it("is a no-op when nothing matches", () => {
    expect(withUpdatedPending(entries, "run-9", "acme.atlassian.net", [])).toEqual(entries);
  });

  it("touches only the newest entry when the same run was published more than once", () => {
    // recordPublish prepends, so index 0 is the newest publish of run-1 and index 1 the earlier one.
    const republished = [
      entry({ artifactId: "run-1", executionRef: "XNP-2", pendingAttachments: ["/new-a", "/new-b"] }),
      entry({ artifactId: "run-1", executionRef: "XNP-1", pendingAttachments: ["/old-a"] }),
    ];
    const updated = withUpdatedPending(republished, "run-1", "acme.atlassian.net", ["/new-b"] as never);
    expect(updated[0]!.pendingAttachments).toEqual(["/new-b"]);
    expect(updated[1]!.pendingAttachments).toEqual(["/old-a"]);
  });
});

// A standalone execution create: no run behind it, so it borrows the artifactId slot under the
// namespace and carries no counts and nothing pending.
function standalone(key = "XNP-7"): LedgerEntry {
  return entry({
    artifactId: `${STANDALONE_ARTIFACT_PREFIX}${key}`,
    executionRef: key,
    summary: "CALC Test Execution (2026-07-26)",
    mode: "created-empty",
    publishedAt: 2000,
  });
}

describe("standalone execution entries", () => {
  it("survives the store's validation and reads back whole, counts absent", async () => {
    const memento = fakeMemento();
    await new PublishLedger(memento, logger).record(standalone());

    const reloaded = new PublishLedger(memento, logger).entriesForSite("acme.atlassian.net");

    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({
      artifactId: "standalone:XNP-7",
      executionRef: "XNP-7",
      mode: "created-empty",
      summary: "CALC Test Execution (2026-07-26)",
      pendingAttachments: [],
    });
    expect(reloaded[0]!.total).toBeUndefined();
    expect(reloaded[0]!.passed).toBeUndefined();
  });

  it("is never what a run's republish lookup finds, and never eats its pending update", () => {
    const entries = [standalone(), entry({ artifactId: "run-1", executionRef: "XNP-1", pendingAttachments: ["/a"] })];

    // The republish banner looks up a run's randomUUID, which can never carry the namespace.
    expect(findLedgerEntry(entries, "run-1", "acme.atlassian.net")?.executionRef).toBe("XNP-1");
    expect(findLedgerEntry(entries, "standalone:XNP-7", "acme.atlassian.net")?.mode).toBe("created-empty");

    const updated = withUpdatedPending(entries, "run-1", "acme.atlassian.net", ["/b"] as never);

    expect(updated[0]).toEqual(standalone());
    expect(updated[1]!.pendingAttachments).toEqual(["/b"]);
  });

  // The parent history includes the empty creation and every publish that later named the same key.
  it("groups itself alongside the publishes that later landed on the same key", () => {
    const rows = buildExecutionRows([
      standalone("XNP-7"),
      entry({ artifactId: "run-1", executionRef: "XNP-7", mode: "create-new", publishedAt: 3000 }),
      entry({ artifactId: "run-2", executionRef: "XNP-7", mode: "append", publishedAt: 4000 }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "group",
      key: "XNP-7",
      activityCount: 3,
      activities: [{ action: "Appended" }, { action: "Created" }, { action: "Created (empty)" }],
    });
  });

  it("keeps another key's activity history separate", () => {
    const rows = buildExecutionRows([
      standalone("XNP-7"),
      entry({ artifactId: "run-1", executionRef: "XNP-1", mode: "create-new", publishedAt: 1500 }),
      entry({ artifactId: "run-2", executionRef: "XNP-1", mode: "append", publishedAt: 1000 }),
    ]);

    expect(rows.map((row) => [row.key, row.activityCount])).toEqual([
      ["XNP-7", 1],
      ["XNP-1", 2],
    ]);
    expect(rows[0]).toMatchObject({ activities: [{ action: "Created (empty)" }] });
    expect(rows[1]).toMatchObject({ activities: [{ action: "Created" }, { action: "Appended" }] });
  });
});

describe("PublishLedger", () => {
  it("records, persists, and finds an entry", async () => {
    const memento = fakeMemento();
    const ledger = new PublishLedger(memento, logger);
    await ledger.record(entry({ artifactId: "run-1", executionRef: "XNP-5" }));

    expect(ledger.find("run-1", "acme.atlassian.net")?.executionRef).toBe("XNP-5");
    expect(Array.isArray(memento.store.get("specwright.publishLedger"))).toBe(true);
  });

  it("reloads a truthful outcome-unknown entry without inventing an execution key", async () => {
    const memento = fakeMemento();
    const ledger = new PublishLedger(memento, logger);
    await ledger.record({
      kind: "outcome-unknown",
      artifactId: "run-unknown",
      site: "acme.atlassian.net",
      account: "client-1",
      publishedAt: 1000,
      pendingAttachments: [],
      operationId: "publish-unknown",
      mode: "append",
    });

    const reloaded = new PublishLedger(memento, logger).find("run-unknown", "acme.atlassian.net");

    expect(reloaded).toMatchObject({
      kind: "outcome-unknown",
      operationId: "publish-unknown",
      mode: "append",
    });
    expect(reloaded).not.toHaveProperty("executionRef");
  });

  it("does not expose or reload a record until durable persistence resolves", async () => {
    const memento = fakeMemento();
    let release: (() => void) | undefined;
    memento.update = (key: string, value: unknown): Promise<void> => new Promise((resolve) => {
      release = () => {
        memento.store.set(key, value);
        resolve();
      };
    });
    const ledger = new PublishLedger(memento, logger);
    const recording = ledger.record(entry({ artifactId: "deferred", operationId: "operation-7" }));
    while (release === undefined) {await Promise.resolve();}

    expect(ledger.find("deferred", "acme.atlassian.net")).toBeUndefined();
    expect(new PublishLedger(memento, logger).find("deferred", "acme.atlassian.net")).toBeUndefined();
    release?.();
    await recording;

    expect(ledger.find("deferred", "acme.atlassian.net")?.operationId).toBe("operation-7");
    expect(new PublishLedger(memento, logger).find("deferred", "acme.atlassian.net")?.operationId).toBe("operation-7");
  });

  it("fails closed when persistence rejects and leaves memory and reload unchanged", async () => {
    const memento = fakeMemento();
    memento.update = (): Promise<void> => Promise.reject(new Error("disk full"));
    const ledger = new PublishLedger(memento, logger);

    await expect(ledger.record(entry({ artifactId: "lost" }))).rejects.toBeInstanceOf(PublishLedgerPersistenceError);

    expect(ledger.find("lost", "acme.atlassian.net")).toBeUndefined();
    expect(new PublishLedger(memento, logger).find("lost", "acme.atlassian.net")).toBeUndefined();
  });

  it("returns snapshots evicted by the fifty-entry cap for physical cleanup", async () => {
    const seeded = Array.from({ length: 50 }, (_, index) =>
      entry({ artifactId: `run-${index}`, pendingAttachments: [snapshot(String.fromCharCode(65 + index))] })
    );
    const memento = fakeMemento(seeded);
    const ledger = new PublishLedger(memento, logger);

    const evicted = await ledger.record(entry({ artifactId: "newest" }));

    expect(evicted).toEqual(seeded[49]!.pendingAttachments);
    expect(ledger.entriesForSite("acme.atlassian.net")).toHaveLength(50);
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

  it("durably removes legacy absolute paths before migration is complete", async () => {
    const retained = snapshot("retained");
    const memento = fakeMemento([
      entry({ artifactId: "legacy", pendingAttachments: ["/ws/report.zip", retained] }),
    ]);
    const captured = capturingLogger();
    const ledger = new PublishLedger(memento, captured.logger);

    await ledger.ready();

    const stored = memento.store.get("specwright.publishLedger") as LedgerEntry[];
    expect(stored[0]!.pendingAttachments).toEqual([retained]);
    expect(stored[0]!.pendingAttachments.every((item) => typeof item !== "string")).toBe(true);
    expect(captured.lines.filter((line) => line.includes("Discarded legacy pending attachment paths"))).toHaveLength(1);

    const reloaded = new PublishLedger(memento, captured.logger);
    await reloaded.ready();
    expect(reloaded.find("legacy", "acme.atlassian.net")?.pendingAttachments).toEqual([retained]);
    expect(captured.lines.filter((line) => line.includes("Discarded legacy pending attachment paths"))).toHaveLength(1);
  });

  it("reads back a v1 entry that predates the counts, leaving them absent", () => {
    // A v1 entry carries only the original required fields, no summary/mode/counts.
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

  it("records and reads back the counts, summary, mode, and total", async () => {
    const memento = fakeMemento();
    const ledger = new PublishLedger(memento, logger);
    await ledger.record(entry({ artifactId: "run-1", summary: "Nightly", mode: "append", passed: 4, failed: 0, skipped: 1, total: 5 }));

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

  it("updates pending attachments and persists (resume/retry clears cleared files)", async () => {
    const memento = fakeMemento();
    const ledger = new PublishLedger(memento, logger);
    const a = snapshot("a");
    const b = snapshot("b");
    await ledger.record(entry({ artifactId: "run-1", pendingAttachments: [a, b] }));

    await ledger.setPendingAttachments("run-1", "acme.atlassian.net", [b]);
    expect(ledger.find("run-1", "acme.atlassian.net")?.pendingAttachments).toEqual([b]);

    await ledger.setPendingAttachments("run-1", "acme.atlassian.net", []);
    expect(ledger.find("run-1", "acme.atlassian.net")?.pendingAttachments).toEqual([]);
    const persisted = memento.store.get("specwright.publishLedger") as LedgerEntry[];
    expect(persisted[0]!.pendingAttachments).toEqual([]);
  });

  it("clear drops every site's entries, persists the empty list, and reports how many went", async () => {
    const memento = fakeMemento([
      entry({ artifactId: "a", site: "acme.atlassian.net" }),
      entry({ artifactId: "b", site: "other.atlassian.net" }),
    ]);
    const ledger = new PublishLedger(memento, logger);

    expect(await ledger.clear()).toMatchObject({ removed: 2 });
    expect(ledger.entriesForSite("acme.atlassian.net")).toEqual([]);
    expect(ledger.entriesForSite("other.atlassian.net")).toEqual([]);
    expect(memento.store.get("specwright.publishLedger")).toEqual([]);
    expect(new PublishLedger(memento, logger).find("a", "acme.atlassian.net")).toBeUndefined();
  });

  it("clear on an empty ledger reports nothing removed", async () => {
    const ledger = new PublishLedger(fakeMemento(), logger);
    expect(await ledger.clear()).toMatchObject({ removed: 0 });
    expect(ledger.entriesForSite("acme.atlassian.net")).toEqual([]);
  });

  it("attach-pending on a republished run leaves the earlier publish's pending record intact", async () => {
    const memento = fakeMemento();
    const ledger = new PublishLedger(memento, logger);
    // Publish the same run twice: two entries, newest first, each with its own pending files.
    const oldA = snapshot("old-a");
    const newA = snapshot("new-a");
    const newB = snapshot("new-b");
    await ledger.record(entry({ artifactId: "run-1", executionRef: "XNP-1", publishedAt: 1000, pendingAttachments: [oldA] }));
    await ledger.record(entry({ artifactId: "run-1", executionRef: "XNP-2", publishedAt: 2000, pendingAttachments: [newA, newB] }));

    // The banner's attach-pending action replays the newest publish's files.
    await ledger.setPendingAttachments("run-1", "acme.atlassian.net", [newB]);

    const bySite = ledger.entriesForSite("acme.atlassian.net");
    expect(bySite[0]!.executionRef).toBe("XNP-2");
    expect(bySite[0]!.pendingAttachments).toEqual([newB]);
    expect(bySite[1]!.executionRef).toBe("XNP-1");
    expect(bySite[1]!.pendingAttachments).toEqual([oldA]);
  });
});
