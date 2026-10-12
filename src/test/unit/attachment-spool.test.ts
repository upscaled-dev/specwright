import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Memento } from "vscode";
import { AttachmentSpool, pruneAttachmentSpool } from "../../traceability/attachment-spool";
import { PublishLedger, PublishLedgerPersistenceError } from "../../traceability/publish-ledger";
import { Logger, LogLevel } from "../../utils/logger";

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
}));

const roots: string[] = [];
const tempRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "specwright-spool-test-"));
  roots.push(root);
  return root;
};

// Generic spool behavior is platform-independent. Inject a read-compatible open flag through the
// no-follow capability seam so Windows CI does not exercise production's deliberate fail-closed
// path. UV_FS_O_FILEMAP is Windows' nonzero read-capable flag; POSIX retains the real O_NOFOLLOW.
// The dedicated null-flag tests below own the unsupported-platform contract.
const TEST_READ_CAPABILITY_FLAG = process.platform === "win32"
  ? fs.constants.UV_FS_O_FILEMAP
  : fs.constants.O_NOFOLLOW;

const supportedSpool = (
  storage: string,
  now: () => number = Date.now
): AttachmentSpool => new AttachmentSpool(
  storage,
  Logger.create(undefined, LogLevel.ERROR),
  now,
  { noFollowFlag: TEST_READ_CAPABILITY_FLAG }
);

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {fs.rmSync(root, { recursive: true, force: true });}
});

describe("AttachmentSpool", () => {
  it("rejects invalid or oversized snapshot records before opening storage", () => {
    const spool = supportedSpool(path.join(tempRoot(), "storage"));
    expect(() => spool.read({ ref: "../escape" } as never)).toThrow("record is invalid");
    expect(() => spool.read({ ref: "00000000-0000-4000-8000-000000000000", name: "report.zip",
      size: 26 * 1024 * 1024, sha256: "a".repeat(64), createdAt: 1,
    })).toThrow("safe per-file limit");
  });

  it("rejects a snapshot whose file size changed", () => {
    const root = tempRoot(); const storage = path.join(root, "storage");
    const source = path.join(root, "report.zip"); fs.writeFileSync(source, "confirmed");
    const spool = supportedSpool(storage); const [snapshot] = spool.seal([source]);
    const sealed = path.join(storage, "attachment-spool", snapshot!.ref);
    fs.chmodSync(sealed, 0o600); fs.writeFileSync(sealed, "short");
    expect(() => spool.read(snapshot!)).toThrow("changed or is unavailable");
  });

  it("rolls back the whole batch when a later file is not a regular file", () => {
    const root = tempRoot(); const source = path.join(root, "report.zip"); fs.writeFileSync(source, "bytes");
    const storage = path.join(root, "storage"); const spool = supportedSpool(storage);
    expect(() => spool.seal([source, root])).toThrow("Only regular, non-linked files");
    expect(fs.readdirSync(path.join(storage, "attachment-spool"))).toEqual([]);
  });

  it("rejects an inode replaced between checking and opening the source", () => {
    const root = tempRoot(); const source = path.join(root, "report.zip"); fs.writeFileSync(source, "first");
    const spool = new AttachmentSpool(path.join(root, "storage"), Logger.create(), Date.now, {
      noFollowFlag: TEST_READ_CAPABILITY_FLAG,
      beforeOpen: () => { fs.renameSync(source, `${source}.old`); fs.writeFileSync(source, "other"); },
    });
    expect(() => spool.seal([source])).toThrow("replaced while it was being opened");
  });

  it.each(["seal", "read"])("refuses a file truncated during %s and cleans incomplete copies", (stage) => {
    const root = tempRoot(); const storage = path.join(root, "storage");
    const source = path.join(root, "report.zip"); fs.writeFileSync(source, "confirmed");
    const spool = supportedSpool(storage);
    const snapshot = stage === "read" ? spool.seal([source])[0]! : undefined;
    vi.spyOn(fs, "readSync").mockReturnValue(0);
    expect(() => snapshot ? spool.read(snapshot) : spool.seal([source])).toThrow(/integrity|changed/);
    if (stage === "seal") { expect(fs.readdirSync(path.join(storage, "attachment-spool"))).toEqual([]); }
  });

  it.each(["count", "bytes"])("prunes only the oldest snapshots needed to recover the %s budget", (limit) => {
    const root = tempRoot(); const storage = path.join(root, "storage");
    const directory = path.join(storage, "attachment-spool"); fs.mkdirSync(directory, { recursive: true });
    const now = Date.now(); const count = limit === "count" ? 102 : 5;
    const refs = Array.from({ length: count }, (_, index) => `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`);
    for (const [index, ref] of refs.entries()) {
      const file = path.join(directory, ref); const fd = fs.openSync(file, "w");
      try { fs.ftruncateSync(fd, limit === "bytes" ? 25 * 1024 * 1024 : 1); } finally { fs.closeSync(fd); }
      fs.utimesSync(file, new Date(now - 10_000 + index * 10), new Date(now - 10_000 + index * 10));
    }
    fs.mkdirSync(path.join(directory, "not-a-snapshot")); fs.writeFileSync(path.join(directory, "README"), "keep");
    const spool = supportedSpool(storage, () => now);
    const source = path.join(root, "new.zip"); fs.writeFileSync(source, "new");
    expect(() => spool.seal([source])).toThrow("spool is full");
    const candidates = spool.cleanupCandidates();
    expect(candidates).toEqual(refs.slice(0, limit === "count" ? 2 : 1));
    expect(spool.deleteCandidates(candidates)).toBe(candidates.length);
    expect(spool.cleanupCandidates()).toEqual([]);
    expect(fs.readFileSync(path.join(directory, "README"), "utf8")).toBe("keep");
  });

  it("reports failed candidate deletion while keeping the bytes available", () => {
    const root = tempRoot(); const source = path.join(root, "report.zip"); fs.writeFileSync(source, "bytes");
    const logger = Logger.create(); const warn = vi.spyOn(logger, "warn");
    const spool = new AttachmentSpool(path.join(root, "storage"), logger, Date.now, { noFollowFlag: TEST_READ_CAPABILITY_FLAG });
    const [snapshot] = spool.seal([source]);
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(() => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); });
    expect(spool.deleteCandidates([snapshot!.ref])).toBe(0);
    expect(warn).toHaveBeenCalledWith("Attachment spool candidate deletion failed", expect.objectContaining({ snapshotRef: snapshot!.ref }));
    unlink.mockRestore();
    expect(spool.read(snapshot!)).toEqual(Buffer.from("bytes"));
  });

  it("uploads the immutable confirmed bytes after the original is replaced", () => {
    const root = tempRoot();
    const source = path.join(root, "report.zip");
    fs.writeFileSync(source, "confirmed");
    const spool = supportedSpool(path.join(root, "storage"));
    const [snapshot] = spool.seal([source]);
    fs.writeFileSync(source, "changed");
    expect(spool.read(snapshot!)).toEqual(Buffer.from("confirmed"));
    expect(snapshot).toMatchObject({ name: "report.zip", size: 9 });
    expect(snapshot?.ref).not.toContain(root);
  });

  it("refuses a symlink and makes cleanup idempotent", () => {
    const root = tempRoot();
    const target = path.join(root, "target.zip");
    const link = path.join(root, "link.zip");
    fs.writeFileSync(target, "bytes");
    fs.symlinkSync(target, link);
    const spool = supportedSpool(path.join(root, "storage"));
    expect(() => spool.seal([link])).toThrow();
    const snapshots = spool.seal([target]);
    expect(spool.discard(snapshots)).toBe(1);
    expect(spool.discard(snapshots)).toBe(0);
  });

  it("refuses a forged snapshot reference outside the spool", () => {
    const root = tempRoot();
    const external = path.join(root, "external.zip");
    fs.writeFileSync(external, "keep");
    const spool = supportedSpool(path.join(root, "storage"));

    expect(spool.discard([{ ref: "../../external.zip" } as never])).toBe(0);
    expect(fs.readFileSync(external, "utf8")).toBe("keep");
  });

  it("fails closed without no-follow even when a symlink race resolves to the same inode", () => {
    const root = tempRoot();
    const source = path.join(root, "report.zip");
    const original = path.join(root, "original.zip");
    const alias = path.join(root, "alias.zip");
    fs.writeFileSync(source, "confirmed");
    fs.linkSync(source, alias);
    expect(fs.statSync(source).ino).toBe(fs.statSync(alias).ino);
    let replaced = false;
    const spool = new AttachmentSpool(
      path.join(root, "storage"),
      Logger.create(undefined, LogLevel.ERROR),
      Date.now,
      {
        noFollowFlag: null,
        beforeOpen: (opened) => {
          if (opened !== source || replaced) {return;}
          replaced = true;
          fs.renameSync(source, original);
          fs.symlinkSync(alias, source);
        },
      }
    );

    expect(() => spool.seal([source])).toThrow(/cannot open attachment files without following links/);
    expect(replaced).toBe(true);
  });

  it("refuses both sealing and snapshot reads when no no-follow primitive exists", () => {
    const root = tempRoot();
    const storage = path.join(root, "storage");
    const source = path.join(root, "report.zip");
    fs.writeFileSync(source, "confirmed");
    const supported = supportedSpool(storage);
    const [snapshot] = supported.seal([source]);
    const unsupported = new AttachmentSpool(
      storage,
      Logger.create(undefined, LogLevel.ERROR),
      Date.now,
      { noFollowFlag: null }
    );

    expect(() => unsupported.seal([source])).toThrow(/attachment sealing is disabled/);
    expect(() => unsupported.read(snapshot!)).toThrow(/attachment sealing is disabled/);
  });

  it("rejects an oversized sparse file before allocating or copying its bytes", () => {
    const root = tempRoot();
    const source = path.join(root, "large.zip");
    const fd = fs.openSync(source, "w");
    try {fs.ftruncateSync(fd, 26 * 1024 * 1024);} finally {fs.closeSync(fd);}
    const storage = path.join(root, "storage");
    const spool = supportedSpool(storage);

    expect(() => spool.seal([source])).toThrow(/safe limit/);
    expect(fs.readdirSync(path.join(storage, "attachment-spool"))).toEqual([]);
  });

  it("detects replacement of sealed storage bytes", () => {
    const root = tempRoot();
    const storage = path.join(root, "storage");
    const source = path.join(root, "report.zip");
    fs.writeFileSync(source, "confirmed");
    const spool = supportedSpool(storage);
    const [snapshot] = spool.seal([source]);
    fs.chmodSync(path.join(storage, "attachment-spool", snapshot!.ref), 0o600);
    fs.writeFileSync(path.join(storage, "attachment-spool", snapshot!.ref), "tampered!");
    expect(() => spool.read(snapshot!)).toThrow(/integrity|changed/);
  });

  it("expires even retained snapshots after the bounded retention window", () => {
    const root = tempRoot();
    const source = path.join(root, "report.zip");
    fs.writeFileSync(source, "confirmed");
    const storage = path.join(root, "storage");
    const spool = supportedSpool(storage, () => Date.now());
    const [snapshot] = spool.seal([source]);
    const future = supportedSpool(storage, () => Date.now() + 8 * 24 * 60 * 60 * 1000);
    const candidates = future.cleanupCandidates();
    expect(candidates).toEqual([snapshot!.ref]);
    expect(future.deleteCandidates(candidates)).toBe(1);
    expect(() => future.read(snapshot!)).toThrow();
  });

  it("keeps candidate bytes retryable when durable reference removal fails", async () => {
    const root = tempRoot();
    const storage = path.join(root, "storage");
    const source = path.join(root, "report.zip");
    fs.writeFileSync(source, "confirmed");
    const spool = supportedSpool(storage);
    const [snapshot] = spool.seal([source]);
    const state = new Map<string, unknown>();
    let fail = false;
    const memento = {
      keys: () => [...state.keys()],
      get: <T>(key: string): T | undefined => state.get(key) as T | undefined,
      update: (key: string, value: unknown): Promise<void> => {
        if (fail) {return Promise.reject(new Error("memento unavailable"));}
        state.set(key, value);
        return Promise.resolve();
      },
    } as unknown as Memento;
    const ledger = new PublishLedger(memento, Logger.create(undefined, LogLevel.ERROR));
    await ledger.record({
      artifactId: "run-1",
      executionRef: "XNP-1",
      site: "acme.atlassian.net",
      account: "client-1",
      publishedAt: 1,
      pendingAttachments: [snapshot!],
    });
    fail = true;
    const future = supportedSpool(storage, () => Date.now() + 8 * 24 * 60 * 60 * 1000);

    await expect(pruneAttachmentSpool(future, (refs) => ledger.discardSnapshotRefs(refs)))
      .rejects.toBeInstanceOf(PublishLedgerPersistenceError);

    expect(future.read(snapshot!)).toEqual(Buffer.from("confirmed"));
    expect(ledger.find("run-1", "acme.atlassian.net")?.pendingAttachments).toEqual([snapshot]);
  });
});


describe("spool cleanup filesystem changes", () => {
  it("treats a candidate deleted by another cleanup as already gone", () => {
    const root = tempRoot(); const source = path.join(root, "report.zip"); fs.writeFileSync(source, "bytes");
    const logger = Logger.create(); const warn = vi.spyOn(logger, "warn");
    const spool = new AttachmentSpool(path.join(root, "storage"), logger, Date.now, { noFollowFlag: TEST_READ_CAPABILITY_FLAG });
    const [snapshot] = spool.seal([source]);
    expect(spool.deleteCandidates([snapshot!.ref])).toBe(1);
    expect(spool.deleteCandidates([snapshot!.ref])).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("surfaces storage traversal errors instead of claiming there are no snapshots", () => {
    const root = tempRoot(); const storage = path.join(root, "storage");
    fs.mkdirSync(storage); fs.writeFileSync(path.join(storage, "attachment-spool"), "not a directory");
    const spool = supportedSpool(storage);
    expect(() => spool.cleanupCandidates()).toThrow();
    expect(fs.readFileSync(path.join(storage, "attachment-spool"), "utf8")).toBe("not a directory");
  });
});
