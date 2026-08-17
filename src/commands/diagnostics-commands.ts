import * as vscode from "vscode";
import type { Logger } from "../utils/logger";

export class DiagnosticsCommands {
  constructor(private readonly logger: Logger, private readonly context: vscode.ExtensionContext) {}

  public async openSupportSnapshot(): Promise<void> {
    const diagnostics = this.logger.supportDiagnostics;
    if (!diagnostics) { return; }
    try {
      const content = diagnostics.snapshot({
        extensionVersion: String(this.context.extension?.packageJSON?.version ?? "unknown"),
        configuration: this.context.extension?.packageJSON?.contributes?.configuration,
      });
      const document = await vscode.workspace.openTextDocument({ language: "json", content });
      await vscode.window.showTextDocument(document, { preview: true });
      if (await vscode.window.showInformationMessage("Support snapshot preview opened.", "Copy Snapshot") !== "Copy Snapshot") { return; }
      try { await vscode.env.clipboard.writeText(content); }
      catch (error) { this.logger.warn("Could not copy support snapshot", { error: error instanceof Error ? error.message : String(error) }); }
    } catch (error) {
      this.logger.warn("Could not open support snapshot", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
