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
