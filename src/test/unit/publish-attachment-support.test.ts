import { describe, it, expect, vi } from "vitest";
import { AttachmentModelDeps, buildAttachmentsModel } from "../../xray/publish-attachment-support";
import { JiraAttachmentMeta } from "../../xray/jira-attachments";
import { EVIDENCE_MAX_FILE_BYTES } from "../../traceability/evidence-resolution";

function deps(over: Partial<AttachmentModelDeps> = {}): AttachmentModelDeps {
  return {
    reportGlobs: ["playwright-report/**"],
    attachTo: "evidence",
    jiraAvailable: true,
    findFiles: () => Promise.resolve([]),
    fileSize: () => 10,
    baseName: (p) => p.split("/").pop() ?? p,
    attachmentMeta: () => Promise.resolve<JiraAttachmentMeta>({ enabled: true }),
    ...over,
  };
}

describe("buildAttachmentsModel: disabled reasons", () => {
  it("renders disabled with the add-creds reason and never probes when Jira creds are absent", async () => {
    const attachmentMeta = vi.fn(() => Promise.resolve<JiraAttachmentMeta>({ enabled: true }));
    const model = await buildAttachmentsModel(deps({ jiraAvailable: false, attachmentMeta, attachTo: "issue" }));
    expect(model.available).toBe(false);
    expect(model.reason).toContain("Add Jira access");
    expect(model.suggestions).toEqual([]);
    expect(model.uploadLimitBytes).toBe(EVIDENCE_MAX_FILE_BYTES);
    expect(model.evidenceStream).toBe("issue");
    // No creds ⇒ no attachment/meta call.
    expect(attachmentMeta).not.toHaveBeenCalled();
  });

  it("renders disabled with the site reason when the site turns attachments off", async () => {
    const model = await buildAttachmentsModel(
      deps({ attachmentMeta: () => Promise.resolve({ enabled: false, uploadLimit: 42 }) })
    );
    expect(model.available).toBe(false);
    expect(model.reason).toContain("disabled for this Jira site");
    expect(model.uploadLimitBytes).toBe(42);
  });

  it("uses the site uploadLimit when enabled", async () => {
    const model = await buildAttachmentsModel(
      deps({ attachmentMeta: () => Promise.resolve({ enabled: true, uploadLimit: 9999 }) })
    );
    expect(model.available).toBe(true);
    expect(model.uploadLimitBytes).toBe(9999);
  });
});

describe("buildAttachmentsModel: discovery", () => {
  it("maps discovered files to sized suggestions", async () => {
    const model = await buildAttachmentsModel(
      deps({
        findFiles: () => Promise.resolve(["/ws/playwright-report/index.html"]),
        fileSize: () => 2048,
      })
    );
    expect(model.suggestions).toEqual([{ path: "/ws/playwright-report/index.html", name: "index.html", size: 2048 }]);
  });

  it("dedupes files matched by more than one glob", async () => {
    const model = await buildAttachmentsModel(
      deps({
        reportGlobs: ["a/**", "b/**"],
        findFiles: () => Promise.resolve(["/ws/report.zip"]),
      })
    );
    expect(model.suggestions.map((s) => s.path)).toEqual(["/ws/report.zip"]);
  });

  it("skips a file whose size cannot be read", async () => {
    const model = await buildAttachmentsModel(
      deps({
        findFiles: () => Promise.resolve(["/ws/ok.zip", "/ws/gone.zip"]),
        fileSize: (p) => (p === "/ws/gone.zip" ? undefined : 5),
      })
    );
    expect(model.suggestions.map((s) => s.path)).toEqual(["/ws/ok.zip"]);
  });

  it("continues past a glob whose discovery throws", async () => {
    const model = await buildAttachmentsModel(
      deps({
        reportGlobs: ["bad/**", "good/**"],
        findFiles: (glob) => (glob === "bad/**" ? Promise.reject(new Error("boom")) : Promise.resolve(["/ws/good.zip"])),
      })
    );
    expect(model.suggestions.map((s) => s.path)).toEqual(["/ws/good.zip"]);
  });

  it("caps the suggestion list at 25", async () => {
    const many = Array.from({ length: 40 }, (_v, i) => `/ws/f${i}.png`);
    const model = await buildAttachmentsModel(deps({ findFiles: () => Promise.resolve(many) }));
    expect(model.suggestions).toHaveLength(25);
    expect(model.suggestions[0]!.path).toBe("/ws/f0.png");
  });
});
