import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { ExtensionConfig } from "../core/extension-config";
import { Logger } from "../utils/logger";
import { StepResolver, UnmatchedStep } from "../providers/step-resolver";
import {
  extractStepDefsFromSource,
  patternToRegexSource,
} from "../providers/step-definition-provider";
import {
  buildFileHeader,
  formatStub,
  inferParameters,
} from "../generators/step-stub-generator";

const DEFAULT_BASE_DIR = "features/steps";
const DEFAULT_NEW_FILE_NAME = "generated.steps.ts";

export interface CreateNewFilePromptInput {
  candidatePath: string;
  workspaceRoot: string;
}

export function inferDefaultStepsDir(globs: string[], workspaceRoot: string): string {
  for (const glob of globs) {
    const stripped = stripGlobTail(glob);
    if (stripped.length === 0) {continue;}
    if (path.isAbsolute(stripped)) {return stripped;}
    return path.join(workspaceRoot, stripped);
  }
  return path.join(workspaceRoot, DEFAULT_BASE_DIR);
}

export function defaultNewFilePath(globs: string[], workspaceRoot: string): string {
  return path.join(inferDefaultStepsDir(globs, workspaceRoot), DEFAULT_NEW_FILE_NAME);
}

export function validateNewFilePath(
  rawInput: string,
  workspaceRoot: string,
  fileExists: (p: string) => boolean
): string | undefined {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {return "Path is required";}
  const resolved = path.isAbsolute(trimmed) ? trimmed : path.join(workspaceRoot, trimmed);
  const rel = path.relative(workspaceRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return "Path must be inside the workspace";
  }
  if (!resolved.endsWith(".ts") && !resolved.endsWith(".js")) {
    return "File must end in .ts or .js";
  }
  if (fileExists(resolved)) {
    return "File already exists";
  }
  return undefined;
}

function stripGlobTail(glob: string): string {
  const parts = glob.split("/");
  const idx = parts.findIndex((p) => p.includes("*"));
  if (idx === -1) {return glob;}
  return parts.slice(0, idx).join("/");
}

export function compilePatternForDedup(pattern: string): RegExp | undefined {
  try {
    return new RegExp(`^${patternToRegexSource(pattern)}$`);
  } catch {
    return undefined;
  }
}

export function buildStubsForUnmatched(
  unmatched: UnmatchedStep[],
  existingDefs: { regex: RegExp }[]
): string[] {
  const out: string[] = [];
  const newlyEmittedRegexes: RegExp[] = [];
  for (const step of unmatched) {
    if (existingDefs.some((d) => d.regex.test(step.text))) {continue;}
    if (newlyEmittedRegexes.some((r) => r.test(step.text))) {continue;}
    const { pattern } = inferParameters(step.text);
    out.push(formatStub(step.effectiveKeyword, step.text));
    const emittedRegex = compilePatternForDedup(pattern);
    if (emittedRegex) {newlyEmittedRegexes.push(emittedRegex);}
  }
  return out;
}

interface QuickPickFileEntry extends vscode.QuickPickItem {
  filePath?: string;
  isCreateNew?: boolean;
}

export class GenerateStepsCommand {
  private readonly resolver: StepResolver;
  private readonly config: ExtensionConfig;
  private readonly logger: Logger;

  constructor(resolver: StepResolver, config: ExtensionConfig, logger: Logger) {
    this.resolver = resolver;
    this.config = config;
    this.logger = logger;
  }

  public async execute(arg?: vscode.Uri | string): Promise<void> {
    const featureUri = this.resolveFeatureUri(arg);
    if (!featureUri) {return;}
    if (!featureUri.fsPath.endsWith(".feature")) {
      vscode.window.showWarningMessage("Generate Step Definitions only works on .feature files.");
      return;
    }

    const doc = await vscode.workspace.openTextDocument(featureUri);
    const featureText = doc.getText();

    const globs = this.config.stepDefinitionPaths;
    const defs = await this.resolver.loadAllStepDefs(globs);
    const unmatched = this.resolver.findUnmatchedSteps(featureText, defs);

    if (unmatched.length === 0) {
      vscode.window.showInformationMessage("All steps are already defined.");
      return;
    }

    await this.executeForSteps(featureUri, unmatched);
  }

  public async executeForSteps(
    featureUri: vscode.Uri,
    unmatched: UnmatchedStep[]
  ): Promise<void> {
    if (unmatched.length === 0) {return;}

    const workspaceRoot = this.getWorkspaceRoot(featureUri);
    if (!workspaceRoot) {
      vscode.window.showWarningMessage("Generate Step Definitions requires an open workspace folder.");
      return;
    }

    const globs = this.config.stepDefinitionPaths;
    const destination = await this.pickDestination(globs, workspaceRoot, unmatched.length);
    if (!destination) {return;}

    const destPath = destination.filePath;
    const isNewFile = destination.isNew;
    let existingDefs: { regex: RegExp }[];

    if (isNewFile) {
      await this.createFileWithHeader(destPath);
      existingDefs = extractStepDefsFromSource(buildFileHeader());
    } else {
      existingDefs = this.resolver.parseStepFile(destPath);
    }

    const stubs = buildStubsForUnmatched(unmatched, existingDefs);
    if (stubs.length === 0) {
      vscode.window.showInformationMessage("All steps are already defined.");
      return;
    }

    const destUri = vscode.Uri.file(destPath);
    const destDoc = await vscode.workspace.openTextDocument(destUri);
    const insertOffset = isNewFile ? "" : "\n";
    const insertText = `${insertOffset}${stubs.join("\n\n")}\n`;
    const endPos = destDoc.lineAt(destDoc.lineCount - 1).range.end;
    const lineCountBeforeEdit = destDoc.lineCount;

    const edit = new vscode.WorkspaceEdit();
    edit.insert(destUri, endPos, insertText);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      this.logger.warn("Generate Steps: workspace edit was rejected", { destPath });
      return;
    }

    try {
      await destDoc.save();
    } catch (error) {
      this.logger.warn("Generate Steps: destination file save failed", {
        destPath,
        error: error instanceof Error ? error.message : String(error),
      });
      vscode.window.showWarningMessage(
        "Stubs were written but the destination file could not be saved (it may be open with unsaved changes). Save manually to use the new step definitions."
      );
    }
    this.resolver.invalidate(destPath);

    const revealLine = Math.min(lineCountBeforeEdit, Math.max(0, destDoc.lineCount - 1));
    const revealPos = new vscode.Position(revealLine, 0);
    const revealRange = new vscode.Range(revealPos, revealPos);
    await vscode.window.showTextDocument(destDoc, { selection: revealRange });
  }

  private resolveFeatureUri(arg?: vscode.Uri | string): vscode.Uri | undefined {
    if (arg) {
      if (typeof arg === "string") {return vscode.Uri.file(arg);}
      return arg;
    }
    return vscode.window.activeTextEditor?.document.uri;
  }

  private getWorkspaceRoot(featureUri: vscode.Uri): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(featureUri);
    if (folder) {return folder.uri.fsPath;}
    const folders = vscode.workspace.workspaceFolders;
    return folders?.[0]?.uri.fsPath;
  }

  private async pickDestination(
    globs: string[],
    workspaceRoot: string,
    undefinedCount: number
  ): Promise<{ filePath: string; isNew: boolean } | undefined> {
    const files = await this.resolver.findStepFiles(globs);
    const sorted = files
      .map((f) => ({ file: f, mtimeMs: this.safeMtime(f) }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const items: QuickPickFileEntry[] = sorted.map((entry) => ({
      label: path.relative(workspaceRoot, entry.file),
      description: this.describeFile(entry.file),
      filePath: entry.file,
    }));

    if (items.length > 0) {
      items.push({
        label: "",
        kind: vscode.QuickPickItemKind.Separator,
      });
    }
    items.push({
      label: "$(new-file) Create new file…",
      isCreateNew: true,
    });

    const picked = await vscode.window.showQuickPick(items, {
      title: "Where to write the generated step definitions?",
      placeHolder: `${undefinedCount} undefined step${undefinedCount === 1 ? "" : "s"} will be generated`,
      ignoreFocusOut: true,
    });
    if (!picked) {return undefined;}

    if (picked.isCreateNew) {
      const newPath = await this.promptForNewFile(globs, workspaceRoot);
      if (!newPath) {return undefined;}
      return { filePath: newPath, isNew: true };
    }

    if (!picked.filePath) {return undefined;}
    return { filePath: picked.filePath, isNew: false };
  }

  private async promptForNewFile(globs: string[], workspaceRoot: string): Promise<string | undefined> {
    const suggested = defaultNewFilePath(globs, workspaceRoot);
    const relSuggested = path.relative(workspaceRoot, suggested);
    const baseStart = relSuggested.length - path.basename(relSuggested).length;
    const baseEnd = relSuggested.length - path.extname(relSuggested).length;

    const input = await vscode.window.showInputBox({
      title: "Create new step definition file",
      prompt: "Path for new step file (relative or absolute)",
      value: relSuggested,
      valueSelection: [baseStart, baseEnd],
      ignoreFocusOut: true,
      validateInput: (value: string): string | undefined =>
        validateNewFilePath(value, workspaceRoot, (p) => fs.existsSync(p)),
    });
    if (input === undefined) {return undefined;}
    const trimmed = input.trim();
    return path.isAbsolute(trimmed) ? trimmed : path.join(workspaceRoot, trimmed);
  }

  private async createFileWithHeader(destPath: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destPath)));
    try {
      await fs.promises.writeFile(destPath, buildFileHeader(), { flag: "wx" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        const message = `Cannot create step file: ${destPath} already exists.`;
        vscode.window.showErrorMessage(message);
        throw new Error(message);
      }
      throw error;
    }
  }

  private safeMtime(filePath: string): number {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private describeFile(filePath: string): string {
    const defs = this.resolver.parseStepFile(filePath);
    const n = defs.length;
    return `${n} step${n === 1 ? "" : "s"}`;
  }
}
