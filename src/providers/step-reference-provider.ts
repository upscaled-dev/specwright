import * as vscode from "vscode";
import { ParsedStepDefWithFile, StepResolver } from "./step-resolver";
import { extractStepDefsFromSource, ParsedStepDef } from "./step-definition-provider";
import { StepUsageIndex } from "./step-usage-index";

export class StepReferenceProvider implements vscode.ReferenceProvider {
  constructor(
    private readonly resolver: StepResolver,
    private readonly index: StepUsageIndex,
    private readonly stepGlobs: string[],
  ) {}

  public async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.ReferenceContext,
  ): Promise<vscode.Location[] | undefined> {
    const defs = extractStepDefsFromSource(document.getText());
    const localDef = findDefAtLine(defs, position.line);
    if (!localDef) {return undefined;}

    const def = await this.locateDefWithFile(document.uri.fsPath, localDef);
    if (!def) {return [];}

    const usages = await this.index.getUsagesForDef(def);
    return usages.map(
      (u) => new vscode.Location(vscode.Uri.file(u.featurePath), new vscode.Range(u.line, 0, u.line, 0)),
    );
  }

  private async locateDefWithFile(
    filePath: string,
    localDef: ParsedStepDef,
  ): Promise<ParsedStepDefWithFile | undefined> {
    const all = await this.resolver.loadAllStepDefs(this.stepGlobs);
    for (const d of all) {
      if (d.filePath === filePath && d.line === localDef.line) {return d;}
    }
    return undefined;
  }
}

function findDefAtLine(defs: ParsedStepDef[], line: number): ParsedStepDef | undefined {
  for (const def of defs) {
    if (def.line === line) {return def;}
  }
  return undefined;
}
