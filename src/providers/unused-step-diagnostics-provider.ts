import * as vscode from "vscode";
import * as path from "node:path";
import { Logger } from "../utils/logger";
import { StepResolver, ParsedStepDefWithFile } from "./step-resolver";
import { extractStepDefsFromSource } from "./step-definition-provider";
import { StepUsageIndex } from "./step-usage-index";

const DEBOUNCE_MS = 300;

export class UnusedStepDiagnosticsProvider implements vscode.Disposable {
  public static readonly DIAGNOSTIC_CODE = "unused-step-definition";
  public static readonly DIAGNOSTIC_SOURCE = "Playwright-BDD";

  private readonly resolver: StepResolver;
  private readonly index: StepUsageIndex;
  private readonly logger: Logger;
  private collection: vscode.DiagnosticCollection | undefined;
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private fsWatcher: vscode.FileSystemWatcher | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private indexSubscription: vscode.Disposable | undefined;
  private currentGlobs: readonly string[] = [];
  private disposed = false;

  constructor(
    resolver: StepResolver,
    index: StepUsageIndex,
    stepGlobs: readonly string[],
    logger: Logger
  ) {
    this.resolver = resolver;
    this.index = index;
    this.currentGlobs = stepGlobs;
    this.logger = logger;
  }

  public start(): void {
    if (this.disposed) {return;}
    if (this.collection) {return;}

    this.collection = vscode.languages.createDiagnosticCollection(
      "playwright-bdd-unused-step-definitions"
    );

    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        this.refreshDocument(doc).catch(() => undefined);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => this.scheduleRefresh(e.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.clearDocument(doc.uri))
    );

    this.indexSubscription = this.index.onDidChangeUsages(() => this.scheduleRefreshAll());

    this.installFsWatcher(this.currentGlobs);

    for (const doc of vscode.workspace.textDocuments) {
      this.refreshDocument(doc).catch(() => undefined);
    }
  }

  public setStepGlobs(globs: readonly string[]): void {
    if (this.disposed) {return;}
    this.currentGlobs = globs;
    this.fsWatcher?.dispose();
    this.fsWatcher = undefined;
    this.installFsWatcher(globs);
    this.refreshAllOpenStepDefDocs();
  }

  private installFsWatcher(globs: readonly string[]): void {
    if (globs.length === 0) {return;}
    const first = globs[0];
    if (first === undefined) {return;}
    const pattern = globs.length === 1 ? first : `{${globs.join(",")}}`;
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onAny = (): void => this.refreshAllOpenStepDefDocs();
    watcher.onDidCreate(onAny);
    watcher.onDidDelete(onAny);
    this.fsWatcher = watcher;
  }

  private refreshAllOpenStepDefDocs(): void {
    for (const doc of vscode.workspace.textDocuments) {
      this.refreshDocument(doc).catch(() => undefined);
    }
  }

  private scheduleRefreshAll(): void {
    if (this.disposed) {return;}
    for (const doc of vscode.workspace.textDocuments) {
      this.scheduleRefresh(doc);
    }
  }

  private scheduleRefresh(doc: vscode.TextDocument): void {
    if (this.disposed) {return;}
    if (!hasStepDefExtension(doc)) {return;}
    const key = doc.uri.toString();
    const existing = this.debounceTimers.get(key);
    if (existing) {clearTimeout(existing);}
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      this.refreshDocument(doc).catch(() => undefined);
    }, DEBOUNCE_MS);
    this.debounceTimers.set(key, timer);
  }

  public async refreshDocument(doc: vscode.TextDocument): Promise<void> {
    if (this.disposed || !this.collection) {return;}
    if (!hasStepDefExtension(doc)) {return;}

    const filePath = doc.uri.fsPath;
    const stepFiles = await this.safeFindStepFiles();
    if (stepFiles === undefined) {return;}
    if (this.disposed || !this.collection) {return;}
    if (!stepFiles.includes(filePath)) {return;}

    const diagnostics = await this.buildUnusedDiagnostics(doc, filePath);
    if (diagnostics === undefined) {return;}
    if (this.disposed || !this.collection) {return;}
    this.collection.set(doc.uri, diagnostics);
  }

  private async safeFindStepFiles(): Promise<string[] | undefined> {
    try {
      return await this.resolver.findStepFiles([...this.currentGlobs]);
    } catch (error) {
      this.logger.warn("UnusedStepDiagnosticsProvider: findStepFiles failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async buildUnusedDiagnostics(
    doc: vscode.TextDocument,
    filePath: string
  ): Promise<vscode.Diagnostic[] | undefined> {
    const defs = extractStepDefsFromSource(doc.getText());
    const diagnostics: vscode.Diagnostic[] = [];
    for (const def of defs) {
      const count = await this.safeCountUsages({
        line: def.line,
        regex: def.regex,
        pattern: def.pattern,
        isRegex: def.isRegex,
        filePath,
      });
      if (count === undefined) {return undefined;}
      if (count > 0) {continue;}
      diagnostics.push(buildDiagnostic(doc, def.line, def.pattern));
    }
    return diagnostics;
  }

  private async safeCountUsages(def: ParsedStepDefWithFile): Promise<number | undefined> {
    try {
      return await this.index.countUsagesForDef(def);
    } catch (error) {
      this.logger.warn("UnusedStepDiagnosticsProvider: countUsagesForDef failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private clearDocument(uri: vscode.Uri): void {
    const key = uri.toString();
    const timer = this.debounceTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(key);
    }
    this.collection?.delete(uri);
  }

  public dispose(): void {
    this.disposed = true;
    for (const [, timer] of this.debounceTimers) {clearTimeout(timer);}
    this.debounceTimers.clear();
    this.fsWatcher?.dispose();
    this.fsWatcher = undefined;
    this.indexSubscription?.dispose();
    this.indexSubscription = undefined;
    for (const d of this.disposables) {
      try { d.dispose(); } catch { /* ignore */ }
    }
    this.disposables.length = 0;
    this.collection?.dispose();
    this.collection = undefined;
  }
}

const STEP_DEF_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

function hasStepDefExtension(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== "file") {return false;}
  return STEP_DEF_EXTS.has(path.extname(doc.fileName));
}

function buildDiagnostic(
  doc: vscode.TextDocument,
  line: number,
  pattern: string
): vscode.Diagnostic {
  const lineText = doc.lineAt(line).text;
  const range = new vscode.Range(line, 0, line, lineText.length);
  const diag = new vscode.Diagnostic(
    range,
    `Step definition is never used: \`${pattern}\``,
    vscode.DiagnosticSeverity.Information
  );
  diag.source = UnusedStepDiagnosticsProvider.DIAGNOSTIC_SOURCE;
  diag.code = UnusedStepDiagnosticsProvider.DIAGNOSTIC_CODE;
  return diag;
}
