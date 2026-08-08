import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { applyTagInsert, applyTagRemove } from "../../traceability/tag-edit";
import { InMemoryTraceabilityAdapter } from "../../traceability/in-memory-adapter";
import type { ScenarioRef } from "../../traceability/scenario-ref";
import { applyWsEdit, EditEntry } from "./helpers/workspace-edit";
import { trustedWorkspace } from "./helpers/test-workspace-trust";
import { WorkspaceTrust, WorkspaceTrustRequiredError } from "../../core/workspace-trust";

const GRAMMAR = new InMemoryTraceabilityAdapter().keyGrammar;
const UNTAGGED = "Feature: F\n\nScenario: A\n  Given x\n";
const TAGGED = "Feature: F\n\n@TC-9\nScenario: A\n  Given x\n";

// The keyword line is one lower once the scenario carries a tag line.
const scenarioAt = (line: number): ScenarioRef => ({ filePath: "/ws/a.feature", line, name: "A", kind: "scenario" });

interface DocOptions {
  isDirty?: boolean;
  save?: () => Promise<boolean>;
}

function stubDocument(text: string, options: DocOptions = {}): { saves: number } {
  const sep = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(sep);
  const counter = { saves: 0 };
  vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue({
    uri: vscode.Uri.file("/ws/a.feature"),
    eol: sep === "\r\n" ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF,
    isDirty: options.isDirty ?? true,
    getText: () => text,
    lineAt: (n: number) => ({ text: lines[n] ?? "", rangeIncludingLineBreak: new vscode.Range(n, 0, n + 1, 0) }),
    save: () => {
      counter.saves++;
      return options.save?.() ?? Promise.resolve(true);
    },
  } as unknown as vscode.TextDocument);
  return counter;
}

function captureEdits(applied = true): EditEntry[][] {
  const edits: EditEntry[][] = [];
  vi.spyOn(vscode.workspace, "applyEdit").mockImplementation((edit) => {
    edits.push((edit as unknown as { __entries: EditEntry[] }).__entries);
    return Promise.resolve(applied);
  });
  return edits;
}

describe("tag-edit", () => {
  afterEach(() => vi.restoreAllMocks());

  it("inserts a tag line above an untagged scenario and saves", async () => {
    const doc = stubDocument(UNTAGGED);
    const edits = captureEdits();

    await expect(applyTagInsert(scenarioAt(3), "5", GRAMMAR, trustedWorkspace()))
      .resolves.toBe("inserted");
    expect(edits).toHaveLength(1);
    expect(applyWsEdit(UNTAGGED, edits[0]!)).toBe("Feature: F\n\n@TC-5\nScenario: A\n  Given x\n");
    expect(doc.saves).toBe(1);
  });

  it("terminates the inserted tag line with CRLF in a CRLF document", async () => {
    const feature = "Feature: F\r\n\r\nScenario: A\r\n  Given x\r\n";
    stubDocument(feature);
    const edits = captureEdits();

    await expect(applyTagInsert(scenarioAt(3), "5", GRAMMAR, trustedWorkspace()))
      .resolves.toBe("inserted");
    expect(edits[0]![0]).toMatchObject({ op: "insert", text: "@TC-5\r\n" });
    const result = applyWsEdit(feature, edits[0]!);
    expect(result).toBe("Feature: F\r\n\r\n@TC-5\r\nScenario: A\r\n  Given x\r\n");
    expect(result).not.toContain("\r\r");
  });

  it("deletes a lone tag line via a WorkspaceEdit when unlinking removes the scenario's only tag", async () => {
    const doc = stubDocument(TAGGED);
    const edits = captureEdits();

    await expect(applyTagRemove(scenarioAt(4), "9", GRAMMAR, trustedWorkspace()))
      .resolves.toBe("removed");
    expect(edits[0]![0]!.op).toBe("delete");
    expect(applyWsEdit(TAGGED, edits[0]!)).toBe("Feature: F\n\nScenario: A\n  Given x\n");
    expect(doc.saves).toBe(1);
  });

  it("replaces the line to drop just the test tag when other tags remain, keeping the EOL", async () => {
    const feature = "Feature: F\r\n\r\n@smoke @TC-9\r\nScenario: A\r\n  Given x\r\n";
    stubDocument(feature);
    const edits = captureEdits();

    await expect(applyTagRemove(scenarioAt(4), "9", GRAMMAR, trustedWorkspace()))
      .resolves.toBe("removed");
    expect(edits[0]![0]!.op).toBe("replace");
    const result = applyWsEdit(feature, edits[0]!);
    expect(result).toBe("Feature: F\r\n\r\n@smoke\r\nScenario: A\r\n  Given x\r\n");
    expect(result).not.toContain("\r\r");
  });

  it("reports unchanged without an edit or a save when the scenario already carries the key", async () => {
    const doc = stubDocument(TAGGED);
    const edits = captureEdits();

    await expect(applyTagInsert(scenarioAt(4), "9", GRAMMAR, trustedWorkspace()))
      .resolves.toBe("unchanged");
    expect(edits).toHaveLength(0);
    expect(doc.saves).toBe(0);
  });

  it("reports unchanged when unlinking a key the scenario does not carry", async () => {
    const doc = stubDocument(TAGGED);
    const edits = captureEdits();

    await expect(applyTagRemove(scenarioAt(4), "5", GRAMMAR, trustedWorkspace()))
      .resolves.toBe("unchanged");
    expect(edits).toHaveLength(0);
    expect(doc.saves).toBe(0);
  });

  it("reports rejected and never saves when the workspace edit is refused", async () => {
    const doc = stubDocument(UNTAGGED);
    captureEdits(false);

    await expect(applyTagInsert(scenarioAt(3), "5", GRAMMAR, trustedWorkspace()))
      .resolves.toBe("rejected");
    expect(doc.saves).toBe(0);
  });

  it("does not start saving when trust is revoked while the workspace edit is pending", async () => {
    let trusted = true;
    let resolveEdit: ((applied: boolean) => void) | undefined;
    const doc = stubDocument(UNTAGGED);
    vi.spyOn(vscode.workspace, "applyEdit").mockImplementation(() =>
      new Promise<boolean>((resolve) => {resolveEdit = resolve;})
    );
    const pending = applyTagInsert(
      scenarioAt(3),
      "5",
      GRAMMAR,
      new WorkspaceTrust(() => trusted)
    );
    await vi.waitFor(() => expect(resolveEdit).toBeDefined());

    trusted = false;
    resolveEdit?.(true);

    await expect(pending).rejects.toBeInstanceOf(WorkspaceTrustRequiredError);
    expect(doc.saves).toBe(0);
  });

  it("reports rejected when a dirty document refuses the save", async () => {
    stubDocument(TAGGED, { save: () => Promise.resolve(false) });
    const edits = captureEdits();

    await expect(applyTagRemove(scenarioAt(4), "9", GRAMMAR, trustedWorkspace()))
      .resolves.toBe("rejected");
    expect(edits).toHaveLength(1);
  });

  it("counts an already-saved document as written rather than rejected", async () => {
    const doc = stubDocument(UNTAGGED, { isDirty: false, save: () => Promise.resolve(false) });
    captureEdits();

    await expect(applyTagInsert(scenarioAt(3), "5", GRAMMAR, trustedWorkspace()))
      .resolves.toBe("inserted");
    expect(doc.saves).toBe(0);
  });
});
