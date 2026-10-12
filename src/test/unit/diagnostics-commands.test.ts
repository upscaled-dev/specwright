import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { DiagnosticsCommands } from "../../commands/diagnostics-commands";
import { SupportDiagnostics } from "../../core/support-diagnostics";
import { Logger } from "../../utils/logger";

function command() {
  const diagnostics = new SupportDiagnostics();
  diagnostics.record("info", "candidate");
  const logger = Logger.create(undefined, undefined, diagnostics);
  return new DiagnosticsCommands(logger, { extension: { packageJSON: { version: "1.2.3", contributes: { configuration: [] } } } } as unknown as vscode.ExtensionContext);
}

describe("DiagnosticsCommands", () => {
  it.each(["preview", "clipboard"] as const)("contains a non-Error %s failure and reports its cause", async stage => {
    const warn = vi.spyOn(Logger.prototype, "warn");
    vi.spyOn(vscode.workspace, "openTextDocument").mockImplementation(async () => {
      if (stage === "preview") {throw "document unavailable";}
      return {} as vscode.TextDocument;
    });
    vi.spyOn(vscode.window, "showTextDocument").mockResolvedValue({} as vscode.TextEditor);
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue("Copy Snapshot" as never);
    const copy = vi.spyOn(vscode.env.clipboard, "writeText").mockRejectedValue("clipboard unavailable");
    try {
      await expect(command().openSupportSnapshot()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(stage === "preview" ? "Could not open support snapshot" : "Could not copy support snapshot", {
        error: stage === "preview" ? "document unavailable" : "clipboard unavailable",
      });
      if (stage === "preview") {expect(copy).not.toHaveBeenCalled();}
    } finally {vi.restoreAllMocks();}
  });
  it("previews before an explicit copy and copies the exact preview bytes", async () => {
    const order: string[] = [];
    let content = "";
    vi.spyOn(vscode.workspace, "openTextDocument").mockImplementation(async value => { content = (value as { content: string }).content; order.push("preview"); return {} as vscode.TextDocument; });
    vi.spyOn(vscode.window, "showTextDocument").mockResolvedValue({} as vscode.TextEditor);
    vi.spyOn(vscode.window, "showInformationMessage").mockImplementation(async () => { order.push("choice"); return "Copy Snapshot" as never; });
    const copied = vi.spyOn(vscode.env.clipboard, "writeText").mockImplementation(async text => { order.push("copy"); expect(text).toBe(content); });
    await command().openSupportSnapshot();
    expect(order).toEqual(["preview", "choice", "copy"]);
    expect(copied).toHaveBeenCalledOnce();
  });

  it("does not copy when dismissed and contains clipboard failure", async () => {
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue({} as vscode.TextDocument);
    vi.spyOn(vscode.window, "showTextDocument").mockResolvedValue({} as vscode.TextEditor);
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);
    const copied = vi.spyOn(vscode.env.clipboard, "writeText");
    await command().openSupportSnapshot();
    expect(copied).not.toHaveBeenCalled();
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue("Copy Snapshot" as never);
    copied.mockRejectedValueOnce(new Error("clipboard unavailable"));
    await expect(command().openSupportSnapshot()).resolves.toBeUndefined();
  });
});
