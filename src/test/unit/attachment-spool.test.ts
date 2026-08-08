import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Memento } from "vscode";
import { AttachmentSpool, pruneAttachmentSpool } from "../../traceability/attachment-spool";
import { PublishLedger, PublishLedgerPersistenceError } from "../../traceability/publish-ledger";
import { Logger, LogLevel } from "../../utils/logger";

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
  for (const root of roots.splice(0)) {fs.rmSync(root, { recursive: true, force: true });}
});

describe("AttachmentSpool", () => {
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
