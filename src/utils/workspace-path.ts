import * as vscode from "vscode";
import * as path from "node:path";

export function toWorkspaceRelative(
  filePath: string,
  caseInsensitive: boolean = process.platform === "win32"
): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    const normalized = path.normalize(filePath);
    const comparable = caseInsensitive ? normalized.toLowerCase() : normalized;
    for (const folder of folders) {
      const root = path.normalize(folder.uri.fsPath);
      const rootComparable = caseInsensitive ? root.toLowerCase() : root;
      if (comparable.startsWith(`${rootComparable}${path.sep}`)) {
        return normalized.slice(root.length + 1);
      }
    }
  }
  return filePath;
}
