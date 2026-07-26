import * as fs from "node:fs";
import * as path from "node:path";
import { plural } from "../utils/text";

// Conservative caps; the official Xray import size limits are undocumented (open item). A single
// evidence file over the file cap, or one that would push the running total past the total cap, is
// skipped with a surfaced note rather than silently dropped or sent oversize.
export const EVIDENCE_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const EVIDENCE_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webm: "video/webm",
  zip: "application/zip",
  txt: "text/plain",
};
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export function contentTypeForFile(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? DEFAULT_CONTENT_TYPE;
}

// evidenceRefs are forward-slashed and posix-relative (relativized per run folder in 2b), so the base
// name is the last `/`-segment regardless of the host OS.
function refBaseName(ref: string): string {
  const parts = ref.split("/");
  return parts[parts.length - 1] ?? ref;
}

// The fs seam evidence resolution reads through; the `nodeEvidenceFs` default is swapped for a fake
// map in tests so no real screenshot has to exist on disk.
export interface EvidenceFs {
  exists(absPath: string): boolean;
  read(absPath: string): Buffer;
}

export const nodeEvidenceFs: EvidenceFs = {
  exists: (absPath) => fs.existsSync(absPath),
  read: (absPath) => fs.readFileSync(absPath),
};

// A resolved evidence file base64-embedded into a result payload (Xray JSON `evidence` or Cucumber
// `embeddings`).
export interface EmbeddedEvidence {
  readonly filename: string;
  readonly contentType: string;
  readonly data: string;
}

export type EvidenceSkipReason = "missing" | "too-large" | "budget-exceeded";

export interface EvidenceSkip {
  readonly ref: string;
  readonly reason: EvidenceSkipReason;
}

// The distinct workspace-folder roots owning the artifact's shard working dirs (multi-root aware);
// an evidenceRef relativized against one run folder resolves against that folder, first existing wins.
export function evidenceRoots(
  workingDirs: readonly string[],
  workspaceRootFor: (filePath: string) => string | undefined
): string[] {
  const roots: string[] = [];
  for (const dir of workingDirs) {
    const root = workspaceRootFor(dir);
    if (root !== undefined && !roots.includes(root)) {
      roots.push(root);
    }
  }
  return roots;
}

// First root under which the ref names an existing file; undefined when none does (a missing file).
export function resolveEvidencePath(
  ref: string,
  roots: readonly string[],
  exists: (absPath: string) => boolean
): string | undefined {
  for (const root of roots) {
    const abs = path.join(root, ref);
    if (exists(abs)) {
      return abs;
    }
  }
  return undefined;
}

// Reads + base64-encodes resolved evidence for the in-payload stream, enforcing the file and running
// total caps. One instance spans a whole publish so the 25 MB total is shared across every result.
export class EvidenceEmbedder {
  private total = 0;
  public readonly skips: EvidenceSkip[] = [];

  constructor(private readonly fsImpl: EvidenceFs) {}

  public embed(ref: string, absPath: string): EmbeddedEvidence | undefined {
    const buffer = this.fsImpl.read(absPath);
    if (buffer.length > EVIDENCE_MAX_FILE_BYTES) {
      this.skips.push({ ref, reason: "too-large" });
      return undefined;
    }
    if (this.total + buffer.length > EVIDENCE_MAX_TOTAL_BYTES) {
      this.skips.push({ ref, reason: "budget-exceeded" });
      return undefined;
    }
    this.total += buffer.length;
    return { filename: refBaseName(ref), contentType: contentTypeForFile(ref), data: buffer.toString("base64") };
  }
}

const MB = 1024 * 1024;

// A single surfaced note for every skip reason (never silent, same bar as preflight). Counts are
// grouped so the toast reads "Skipped 2 files over 5 MB, 1 evidence file not found."
export function summarizeEvidenceSkips(skips: readonly EvidenceSkip[]): string | undefined {
  if (skips.length === 0) {
    return undefined;
  }
  const counts = { "too-large": 0, "budget-exceeded": 0, missing: 0 };
  for (const skip of skips) {
    counts[skip.reason] += 1;
  }
  const parts: string[] = [];
  if (counts["too-large"] > 0) {
    parts.push(`${counts["too-large"]} ${plural(counts["too-large"], "file")} over ${EVIDENCE_MAX_FILE_BYTES / MB} MB`);
  }
  if (counts["budget-exceeded"] > 0) {
    parts.push(
      `${counts["budget-exceeded"]} ${plural(counts["budget-exceeded"], "file")} over the ${EVIDENCE_MAX_TOTAL_BYTES / MB} MB evidence total`
    );
  }
  if (counts.missing > 0) {
    parts.push(`${counts.missing} evidence ${plural(counts.missing, "file")} not found`);
  }
  return `Skipped ${parts.join(", ")}.`;
}
