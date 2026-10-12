import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

export interface SavedRun {
  readonly id: string;
  readonly completedAt?: number;
  readonly items?: ReadonlyArray<{
    readonly item: { readonly extId: string };
    readonly ownComputedState: number;
    readonly computedState: number;
    readonly tasks: ReadonlyArray<{ readonly state: number }>;
  }>;
}

export function savedTestRuns(): SavedRun[] {
  const storage = path.resolve(__dirname, "../../../../.vscode-test/user-data/User/workspaceStorage");
  if (!fs.existsSync(storage)) {return [];}
  const runs: SavedRun[] = [];
  for (const workspace of fs.readdirSync(storage)) {
    const directory = path.join(storage, workspace, "testResults");
    if (!fs.existsSync(directory)) {continue;}
    for (const file of fs.readdirSync(directory)) {
      if (!file.endsWith(".json")) {continue;}
      try {runs.push(JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")) as SavedRun);}
      catch { /* the host may still be writing a result */ }
    }
  }
  return runs;
}

export function openTestRunOutput(id: string): Thenable<vscode.TextDocument> {
  return vscode.workspace.openTextDocument(vscode.Uri.from({
    scheme: "vscode-test-data", authority: "results", path: `/${id}/output/0`,
  }));
}
