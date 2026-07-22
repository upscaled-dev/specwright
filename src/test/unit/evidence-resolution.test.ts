import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  contentTypeForFile,
  EVIDENCE_MAX_FILE_BYTES,
  EvidenceEmbedder,
  EvidenceFs,
  evidenceRoots,
  resolveEvidencePath,
  summarizeEvidenceSkips,
} from "../../traceability/evidence-resolution";

function fakeFs(files: Record<string, Buffer>): EvidenceFs {
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    read: (p) => files[p] ?? Buffer.alloc(0),
  };
}

describe("contentTypeForFile", () => {
  it.each([
    ["shot.png", "image/png"],
    ["photo.JPG", "image/jpeg"],
    ["photo.jpeg", "image/jpeg"],
    ["clip.webm", "video/webm"],
    ["trace.zip", "application/zip"],
    ["log.txt", "text/plain"],
    ["data.bin", "application/octet-stream"],
    ["noext", "application/octet-stream"],
  ])("maps %s to %s", (name, expected) => {
    expect(contentTypeForFile(name)).toBe(expected);
  });
});

describe("evidenceRoots", () => {
  it("maps shard working dirs to their owning roots and dedupes", () => {
    const roots = evidenceRoots(
      ["/roots/a/pkg1", "/roots/a/pkg2", "/roots/b/pkg"],
      (dir) => (dir.startsWith("/roots/a/") ? "/roots/a" : "/roots/b")
    );
    expect(roots).toEqual(["/roots/a", "/roots/b"]);
  });

  it("drops working dirs with no owning root", () => {
    expect(evidenceRoots(["/x", "/y"], (dir) => (dir === "/x" ? "/root" : undefined))).toEqual(["/root"]);
  });
});

describe("resolveEvidencePath", () => {
  it("returns the first root under which the ref exists (multi-root, first wins)", () => {
    const files = fakeFs({ [path.join("/roots/b", "test-results/x.png")]: Buffer.from("x") });
    const abs = resolveEvidencePath("test-results/x.png", ["/roots/a", "/roots/b"], files.exists);
    expect(abs).toBe(path.join("/roots/b", "test-results/x.png"));
  });

  it("returns undefined when no root names an existing file", () => {
    const files = fakeFs({});
    expect(resolveEvidencePath("test-results/x.png", ["/roots/a"], files.exists)).toBeUndefined();
  });
});

describe("EvidenceEmbedder", () => {
  it("base64-embeds a resolved file with its filename + content type", () => {
    const abs = path.join("/root", "test-results/shot.png");
    const embedder = new EvidenceEmbedder(fakeFs({ [abs]: Buffer.from("PNGDATA") }));
    const embedded = embedder.embed("test-results/shot.png", abs);
    expect(embedded).toEqual({
      filename: "shot.png",
      contentType: "image/png",
      data: Buffer.from("PNGDATA").toString("base64"),
    });
    expect(embedder.skips).toEqual([]);
  });

  it("skips a file over the 5 MB file cap (never sent oversize)", () => {
    const abs = "/root/big.zip";
    const embedder = new EvidenceEmbedder(fakeFs({ [abs]: Buffer.alloc(EVIDENCE_MAX_FILE_BYTES + 1) }));
    expect(embedder.embed("big.zip", abs)).toBeUndefined();
    expect(embedder.skips).toEqual([{ ref: "big.zip", reason: "too-large" }]);
  });

  it("skips once the shared 25 MB total budget would overflow", () => {
    const fourMb = Buffer.alloc(4 * 1024 * 1024);
    const files: Record<string, Buffer> = {};
    for (let i = 0; i < 8; i++) {
      files[`/root/e${i}.png`] = fourMb;
    }
    const embedder = new EvidenceEmbedder(fakeFs(files));
    let embedded = 0;
    for (let i = 0; i < 8; i++) {
      if (embedder.embed(`e${i}.png`, `/root/e${i}.png`) !== undefined) {
        embedded += 1;
      }
    }
    // 6 × 4 MB = 24 MB fits; the 7th would exceed 25 MB, so 6 embed and 2 are skipped.
    expect(embedded).toBe(6);
    expect(embedder.skips.every((s) => s.reason === "budget-exceeded")).toBe(true);
    expect(embedder.skips).toHaveLength(2);
  });
});

describe("summarizeEvidenceSkips", () => {
  it("returns undefined when nothing was skipped", () => {
    expect(summarizeEvidenceSkips([])).toBeUndefined();
  });

  it("groups counts by reason with the size thresholds named", () => {
    const note = summarizeEvidenceSkips([
      { ref: "a.zip", reason: "too-large" },
      { ref: "b.zip", reason: "too-large" },
      { ref: "c.png", reason: "budget-exceeded" },
      { ref: "d.png", reason: "missing" },
    ]);
    expect(note).toBe("Skipped 2 files over 5 MB, 1 file over the 25 MB evidence total, 1 evidence file not found.");
  });

  it("uses the singular form for a single skip", () => {
    expect(summarizeEvidenceSkips([{ ref: "a.zip", reason: "too-large" }])).toBe("Skipped 1 file over 5 MB.");
  });
});
