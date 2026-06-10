import * as vscode from "vscode";
import { ParsedStepDefWithFile } from "./step-resolver";
import { extractStepDefsFromSource } from "./step-definition-provider";
import { StepUsageIndex } from "./step-usage-index";

export class StepUsageCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  private readonly indexSubscription: vscode.Disposable;

  constructor(private readonly index: StepUsageIndex) {
    this.indexSubscription = this.index.onDidChangeUsages(() => {
      this._onDidChangeCodeLenses.fire();
    });
  }

  public async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const defs = extractStepDefsFromSource(document.getText());
    const filePath = document.uri.fsPath;
    const lenses: vscode.CodeLens[] = [];
    for (const def of defs) {
      const defWithFile: ParsedStepDefWithFile = {
        line: def.line,
        regex: def.regex,
        pattern: def.pattern,
        isRegex: def.isRegex,
        filePath,
      };
      const count = await this.index.countUsagesForDef(defWithFile);
      const title = titleFor(count);
      const range = new vscode.Range(def.line, 0, def.line, 0);
      lenses.push(new vscode.CodeLens(range, {
        title,
        command: "editor.action.findReferences",
        arguments: [document.uri, new vscode.Position(def.line, 0)],
      }));
    }
    return lenses;
  }

  public dispose(): void {
    this.indexSubscription.dispose();
    this._onDidChangeCodeLenses.dispose();
  }
}

function titleFor(count: number): string {
  if (count === 0) {return "Unused";}
  const suffix = count === 1 ? "" : "s";
  return `Used ${count} time${suffix}`;
}
