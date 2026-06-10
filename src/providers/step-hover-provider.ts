import * as vscode from "vscode";
import { Logger } from "../utils/logger";
import { StepResolver, ParsedStepDefWithFile, ParsedFeatureStep } from "./step-resolver";
import { STEP_KEYWORDS } from "./step-keywords";
import { computeSkipRanges } from "./feature-skip-ranges";
import { toWorkspaceRelative } from "../utils/workspace-path";

const STEP_LINE_RE = new RegExp(String.raw`^\s*(${STEP_KEYWORDS})\s+`);

export class StepHoverProvider implements vscode.HoverProvider {
  private readonly stepGlobs: string[];
  private readonly resolver: StepResolver;
  private readonly logger: Logger;

  constructor(stepGlobs: string[], resolver: StepResolver, logger?: Logger) {
    this.stepGlobs = stepGlobs;
    this.resolver = resolver;
    this.logger = logger ?? Logger.create();
  }

  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    const lineText = document.lineAt(position.line).text;
    if (!STEP_LINE_RE.test(lineText)) {return undefined;}

    const skipRanges = computeSkipRanges(document.getText());
    if (skipRanges.has(position.line)) {return undefined;}

    const step = findFeatureStep(this.resolver.parseFeatureSteps(document.getText()), position.line);
    if (!step) {return undefined;}

    const defs = await this.safeLoadDefs();
    if (!defs) {return undefined;}

    const matches = this.resolver.findStepMatches(step.text, defs);
    if (matches.length === 0) {return undefined;}

    const md = buildHoverMarkdown(matches);
    return new vscode.Hover(md);
  }

  private async safeLoadDefs(): Promise<ParsedStepDefWithFile[] | undefined> {
    try {
      return await this.resolver.loadAllStepDefs(this.stepGlobs);
    } catch (error) {
      this.logger.warn("StepHoverProvider: failed to load step defs", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}

function findFeatureStep(steps: ParsedFeatureStep[], line: number): ParsedFeatureStep | undefined {
  for (const s of steps) {
    if (s.line === line) {return s;}
  }
  return undefined;
}

function buildHoverMarkdown(matches: ParsedStepDefWithFile[]): vscode.MarkdownString {
  // No command links are emitted and step-file content is interpolated raw,
  // so the markdown must stay untrusted.
  const md = new vscode.MarkdownString();
  const suffix = matches.length > 1 ? "es" : "";
  md.appendMarkdown(`**Playwright-BDD step** — ${matches.length} match${suffix}\n\n`);
  for (const match of matches) {
    const rel = toWorkspaceRelative(match.filePath);
    md.appendMarkdown(`- \`${match.pattern}\` — ${rel}:${match.line + 1}\n`);
  }
  return md;
}
