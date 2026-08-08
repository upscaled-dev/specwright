import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "../utils/logger";

const MAX_SPOOL_BYTES = 100 * 1024 * 1024;
const MAX_SNAPSHOTS = 100;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024;
const COPY_CHUNK_BYTES = 64 * 1024;
const SNAPSHOT_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AttachmentSnapshot {
  readonly ref: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: number;
}

export function isAttachmentSnapshot(value: unknown): value is AttachmentSnapshot {
  if (typeof value !== "object" || value === null) {return false;}
  const item = value as Record<string, unknown>;
  return typeof item["ref"] === "string" && SNAPSHOT_REF.test(item["ref"])
    && typeof item["name"] === "string" && path.basename(item["name"]) === item["name"]
    && typeof item["size"] === "number" && Number.isSafeInteger(item["size"]) && item["size"] >= 0
    && typeof item["sha256"] === "string" && /^[0-9a-f]{64}$/.test(item["sha256"])
    && typeof item["createdAt"] === "number" && Number.isFinite(item["createdAt"]);
}

export class AttachmentSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentSnapshotError";
  }
}

interface SpoolEntry {
  readonly ref: string;
  readonly size: number;
  readonly modifiedAt: number;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function identityOf(stat: fs.BigIntStats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

export interface AttachmentSpoolOptions {
  // `null` exercises the fail-closed platform path in platform-independent tests.
  readonly noFollowFlag?: number | null | undefined;
  readonly beforeOpen?: ((filePath: string) => void) | undefined;
}

export async function pruneAttachmentSpool(
  spool: AttachmentSpool,
  removeReferences: (refs: readonly string[]) => Promise<void>
): Promise<number> {
  const candidates = spool.cleanupCandidates();
  await removeReferences(candidates);
  return spool.deleteCandidates(candidates);
}

/** Owns immutable attachment bytes below the extension global storage directory. */
export class AttachmentSpool {
  private readonly directory: string;

  constructor(
    storageRoot: string,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    private readonly options: AttachmentSpoolOptions = {}
  ) {
    this.directory = path.join(storageRoot, "attachment-spool");
  }

  public seal(paths: readonly string[]): AttachmentSnapshot[] {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const sealed: AttachmentSnapshot[] = [];
    try {
      for (const source of paths) {sealed.push(this.sealOne(source));}
      return sealed;
    } catch (error) {
      this.discard(sealed);
      throw error;
    }
  }

  public read(snapshot: AttachmentSnapshot): Buffer {
    if (!isAttachmentSnapshot(snapshot)) {throw new AttachmentSnapshotError("The attachment snapshot record is invalid.");}
    if (snapshot.size > MAX_SNAPSHOT_BYTES) {throw new AttachmentSnapshotError("The attachment snapshot exceeds the safe per-file limit.");}
    const { fd, before } = this.openVerified(this.snapshotPath(snapshot.ref));
    try {
      if (Number(before.size) !== snapshot.size) {
        throw new AttachmentSnapshotError(`The sealed attachment ${snapshot.name} changed or is unavailable.`);
      }
      const content = Buffer.alloc(snapshot.size);
      let offset = 0;
      while (offset < content.length) {
        const read = fs.readSync(fd, content, offset, content.length - offset, offset);
        if (read === 0) {break;}
        offset += read;
      }
      const after = this.identityOfFd(fd);
      if (offset !== content.length || !sameFile(before, after) || crypto.createHash("sha256").update(content).digest("hex") !== snapshot.sha256) {
        throw new AttachmentSnapshotError(`The sealed attachment ${snapshot.name} failed its integrity check.`);
      }
      return content;
    } finally {
      fs.closeSync(fd);
    }
  }

  public discard(snapshots: readonly AttachmentSnapshot[]): number {
    let removed = 0;
    for (const snapshot of snapshots) {
      try {
        fs.unlinkSync(this.snapshotPath(snapshot.ref));
        removed += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.logger.warn("Attachment snapshot cleanup failed", { snapshotRef: snapshot.ref, error: String(error) });
        }
      }
    }
    if (snapshots.length > 0) {
      this.logger.info("Attachment snapshot cleanup completed", { requested: snapshots.length, removed });
    }
    return removed;
  }

  public cleanupCandidates(): string[] {
    const entries = this.entries();
    const expired = entries.filter((entry) => this.now() - entry.modifiedAt > MAX_AGE_MS);
    const expiredRefs = new Set(expired.map((entry) => entry.ref));
    const remaining = entries
      .filter((entry) => !expiredRefs.has(entry.ref))
      .sort((left, right) => left.modifiedAt - right.modifiedAt);
    let bytes = remaining.reduce((total, entry) => total + entry.size, 0);
    let count = remaining.length;
    const evicted: SpoolEntry[] = [];
    for (const entry of remaining) {
      if (bytes <= MAX_SPOOL_BYTES && count <= MAX_SNAPSHOTS) {break;}
      evicted.push(entry);
      bytes -= entry.size;
      count -= 1;
    }
    return [...expired.map((entry) => entry.ref), ...evicted.map((entry) => entry.ref)];
  }

  public deleteCandidates(refs: readonly string[]): number {
    let removed = 0;
    for (const ref of refs) {
      try {
        fs.unlinkSync(this.snapshotPath(ref));
        removed += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.logger.warn("Attachment spool candidate deletion failed", { snapshotRef: ref, error: String(error) });
        }
      }
    }
    if (refs.length > 0) {this.logger.info("Attachment spool prune completed", { requested: refs.length, removed });}
    return removed;
  }

  private sealOne(source: string): AttachmentSnapshot {
    const { fd: sourceFd, before } = this.openVerified(source);
    const size = Number(before.size);
    try {
      if (!Number.isSafeInteger(size) || size > MAX_SNAPSHOT_BYTES) {
        throw new AttachmentSnapshotError(`Attachment ${path.basename(source)} exceeds the ${MAX_SNAPSHOT_BYTES} byte safe limit.`);
      }
      const current = this.entries();
      const currentBytes = current.reduce((total, item) => total + item.size, 0);
      if (current.length + 1 > MAX_SNAPSHOTS || currentBytes + size > MAX_SPOOL_BYTES) {
        throw new AttachmentSnapshotError("The attachment spool is full. Discard pending attachments before adding more.");
      }
      const ref = crypto.randomUUID();
      const destination = this.snapshotPath(ref);
      const destinationFd = fs.openSync(
        destination,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o400
      );
      const hash = crypto.createHash("sha256");
      const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      let offset = 0;
      let failure: unknown;
      try {
        while (offset < size) {
          const requested = Math.min(chunk.length, size - offset);
          const read = fs.readSync(sourceFd, chunk, 0, requested, offset);
          if (read === 0) {break;}
          fs.writeSync(destinationFd, chunk, 0, read, offset);
          hash.update(chunk.subarray(0, read));
          offset += read;
        }
        fs.fsyncSync(destinationFd);
        const after = this.identityOfFd(sourceFd);
        if (offset !== size || !sameFile(before, after) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
          throw new AttachmentSnapshotError(`Attachment ${path.basename(source)} changed while it was being sealed.`);
        }
      } catch (error) {
        failure = error;
      } finally {
        fs.closeSync(destinationFd);
      }
      if (failure !== undefined) {
        try {fs.unlinkSync(destination);} catch { /* best effort after a failed seal */ }
        throw failure;
      }
      return { ref, name: path.basename(source), size, sha256: hash.digest("hex"), createdAt: this.now() };
    } finally {
      fs.closeSync(sourceFd);
    }
  }

  private openVerified(filePath: string): { readonly fd: number; readonly before: FileIdentity } {
    const lstat = fs.lstatSync(filePath, { bigint: true });
    if (!lstat.isFile()) {throw new AttachmentSnapshotError("Only regular, non-linked files can be attached.");}
    const noFollow = this.options.noFollowFlag === null
      ? undefined
      : this.options.noFollowFlag ?? (process.platform === "win32" ? undefined : fs.constants.O_NOFOLLOW);
    this.options.beforeOpen?.(filePath);
    if (noFollow === undefined || noFollow === 0) {
      throw new AttachmentSnapshotError(
        "This platform cannot open attachment files without following links, so attachment sealing is disabled."
      );
    }
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    try {
      const before = this.identityOfFd(fd);
      const lstatIdentity = identityOf(lstat);
      if (!sameFile(lstatIdentity, before)) {
        throw new AttachmentSnapshotError("The attachment was replaced while it was being opened.");
      }
      return { fd, before };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  private identityOfFd(fd: number): FileIdentity {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) {throw new AttachmentSnapshotError("Only regular files can be attached.");}
    return identityOf(stat);
  }

  private entries(): SpoolEntry[] {
    try {
      return fs.readdirSync(this.directory, { withFileTypes: true }).flatMap((entry) => {
        if (!entry.isFile() || !SNAPSHOT_REF.test(entry.name)) {return [];}
        try {
          const stat = fs.lstatSync(this.snapshotPath(entry.name));
          return stat.isFile() ? [{ ref: entry.name, size: stat.size, modifiedAt: stat.mtimeMs }] : [];
        } catch {return [];}
      });
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : (() => {throw error;})();
    }
  }

  private snapshotPath(ref: string): string {
    if (!SNAPSHOT_REF.test(ref)) {throw new AttachmentSnapshotError("The attachment snapshot reference is invalid.");}
    return path.join(this.directory, ref);
  }
}
