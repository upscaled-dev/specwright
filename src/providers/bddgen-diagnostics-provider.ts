import * as vscode from "vscode";
import * as path from "node:path";
import { parseBddgenErrors, BddgenErrorLocation } from "./bddgen-error-parser";

export class BddgenDiagnosticsProvider implements vscode.Disposable {
  public static readonly DIAGNOSTIC_SOURCE = "Playwright-BDD";
  public static readonly DIAGNOSTIC_CODE = "bddgen-error";

  private readonly collection: vscode.DiagnosticCollection;
  private disposed = false;

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection("playwright-bdd-bddgen");
  }

  /**
   * Parse bddgen output and surface its errors as diagnostics. bddgen prints feature paths
   * relative to the directory it ran in, so `baseDir` (the run's working directory) is needed
   * to anchor them on real files.
   */
  public publish(output: string, baseDir: string): void {
    if (this.disposed) {return;}
    this.collection.clear();
    const errors = parseBddgenErrors(output);
    if (errors.length === 0) {return;}
    const byFile = new Map<string, BddgenErrorLocation[]>();
    for (const err of errors) {
      const filePath = path.isAbsolute(err.filePath)
        ? err.filePath
        : path.resolve(baseDir, err.filePath);
      const list = byFile.get(filePath) ?? [];
      list.push(err);
      byFile.set(filePath, list);
    }
    for (const [filePath, errs] of byFile) {
      const diagnostics = errs.map((e) => this.toDiagnostic(e));
      this.collection.set(vscode.Uri.file(filePath), diagnostics);
    }
  }

  public clear(): void {
    if (this.disposed) {return;}
    this.collection.clear();
  }

  public dispose(): void {
    if (this.disposed) {return;}
    this.disposed = true;
    this.collection.dispose();
  }

  private toDiagnostic(err: BddgenErrorLocation): vscode.Diagnostic {
    const startCol = err.column ?? 0;
    const range = new vscode.Range(err.line, startCol, err.line, Number.MAX_SAFE_INTEGER);
    const diag = new vscode.Diagnostic(range, err.message, vscode.DiagnosticSeverity.Error);
    diag.source = BddgenDiagnosticsProvider.DIAGNOSTIC_SOURCE;
    diag.code = BddgenDiagnosticsProvider.DIAGNOSTIC_CODE;
    return diag;
  }
}
