import * as vscode from "vscode";
import { WorkspaceTrustRequiredError } from "../core/workspace-trust";

const MANAGE_TRUST = "Manage Workspace Trust";

export async function explainWorkspaceTrust(error: unknown): Promise<boolean> {
  if (!(error instanceof WorkspaceTrustRequiredError)) {return false;}
  const picked = await vscode.window.showWarningMessage(error.message, MANAGE_TRUST);
  if (picked === MANAGE_TRUST) {
    await vscode.commands.executeCommand("workbench.trust.manage");
  }
  return true;
}
