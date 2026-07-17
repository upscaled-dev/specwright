import * as vscode from "vscode";
import * as path from "node:path";
import { StepUsageIndex } from "./step-usage-index";
import { UnmatchedStep } from "./step-resolver";
import { humanizeRegexSource } from "./pattern-humanizer";
import { ExtensionConfig } from "../core/extension-config";
import { toWorkspaceRelative } from "../utils/workspace-path";

type Keyword = "Given" | "When" | "Then";

const KEYWORDS: Keyword[] = ["Given", "When", "Then"];

interface InfoNode {
  kind: "info";
  label: string;
}

interface SectionNode {
  kind: "section";
  section: "definitions" | "unmatched";
}

interface KeywordNode {
  kind: "keyword";
  keyword: Keyword;
}

export interface StepDefinitionNode {
  kind: "stepDefinition";
  keyword: Keyword;
  humanized: string;
  usageCount: number;
  filePath: string;
  line: number;
  pattern: string;
  isRegex: boolean;
}

export interface UnmatchedFileNode {
  kind: "unmatchedFile";
  featurePath: string;
  steps: UnmatchedStep[];
}

export interface UnmatchedStepNode {
  kind: "unmatchedStep";
  featurePath: string;
  step: UnmatchedStep;
}

export type StepsNode =
  | InfoNode
  | SectionNode
  | KeywordNode
  | StepDefinitionNode
  | UnmatchedFileNode
  | UnmatchedStepNode;

const NO_DEFS_MESSAGE =
  "No step definitions found — check playwrightBddRunner.stepDefinitionPaths.";
const NO_UNMATCHED_MESSAGE = "No unmatched steps.";
const DISABLED_MESSAGE =
  "Steps panel is disabled. Set playwrightBddRunner.enableStepsPanel to true to use it.";

function keywordsFor(keyword: StepDefinitionNode["keyword"] | "Step" | undefined): Keyword[] {
  return keyword === "Given" || keyword === "When" || keyword === "Then" ? [keyword] : KEYWORDS;
}

export class StepsTreeDataProvider
  implements vscode.TreeDataProvider<StepsNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<StepsNode | undefined>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly index: StepUsageIndex,
    private readonly config: ExtensionConfig,
  ) {
    this.subscription = this.index.onDidChangeUsages(() =>
      this._onDidChangeTreeData.fire(undefined),
    );
  }

  public dispose(): void {
    this.subscription.dispose();
    this._onDidChangeTreeData.dispose();
  }

  public getTreeItem(node: StepsNode): vscode.TreeItem {
    switch (node.kind) {
      case "info": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("info");
        return item;
      }
      case "section": {
        const label = node.section === "definitions" ? "Step definitions" : "Unmatched steps";
        return new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
      }
      case "keyword":
        return new vscode.TreeItem(node.keyword, vscode.TreeItemCollapsibleState.Collapsed);
      case "stepDefinition": {
        const item = new vscode.TreeItem(node.humanized, vscode.TreeItemCollapsibleState.None);
        const uses = node.usageCount === 1 ? "1 use" : `${node.usageCount} uses`;
        item.description = `${uses} · ${path.basename(node.filePath)}`;
        item.tooltip = node.pattern;
        item.contextValue = "stepDefinition";
        item.iconPath = new vscode.ThemeIcon(
          node.usageCount === 0 ? "warning" : "symbol-method",
        );
        item.command = navigateCommand(node.filePath, node.line);
        return item;
      }
      case "unmatchedFile": {
        const item = new vscode.TreeItem(
          path.basename(node.featurePath),
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description = toWorkspaceRelative(node.featurePath);
        item.resourceUri = vscode.Uri.file(node.featurePath);
        item.contextValue = "unmatchedFile";
        item.iconPath = new vscode.ThemeIcon("file");
        return item;
      }
      case "unmatchedStep": {
        const item = new vscode.TreeItem(node.step.text, vscode.TreeItemCollapsibleState.None);
        item.description = `${node.step.keyword} · line ${node.step.line + 1}`;
        item.contextValue = "unmatchedStep";
        item.iconPath = new vscode.ThemeIcon("warning");
        item.command = navigateCommand(node.featurePath, node.step.line);
        return item;
      }
    }
  }

  public async getChildren(node?: StepsNode): Promise<StepsNode[]> {
    if (!this.config.enableStepsPanel) {
      return node ? [] : [{ kind: "info", label: DISABLED_MESSAGE }];
    }
    if (!node) {
      return [
        { kind: "section", section: "definitions" },
        { kind: "section", section: "unmatched" },
      ];
    }
    if (node.kind === "section") {
      return node.section === "definitions" ? this.keywordGroups() : this.unmatchedFiles();
    }
    if (node.kind === "keyword") {
      return (await this.defsByKeyword())[node.keyword];
    }
    if (node.kind === "unmatchedFile") {
      return node.steps.map((step) => ({
        kind: "unmatchedStep",
        featurePath: node.featurePath,
        step,
      }));
    }
    return [];
  }

  private async keywordGroups(): Promise<StepsNode[]> {
    const groups = await this.defsByKeyword();
    const nodes: StepsNode[] = KEYWORDS.filter((k) => groups[k].length > 0).map((keyword) => ({
      kind: "keyword",
      keyword,
    }));
    return nodes.length > 0 ? nodes : [{ kind: "info", label: NO_DEFS_MESSAGE }];
  }

  private async unmatchedFiles(): Promise<StepsNode[]> {
    const map = await this.index.getUnmatchedSteps();
    const entries = [...map.entries()]
      .filter(([, steps]) => steps.length > 0)
      .sort((a, b) => a[0].localeCompare(b[0]));
    if (entries.length === 0) {
      return [{ kind: "info", label: NO_UNMATCHED_MESSAGE }];
    }
    return entries.map(([featurePath, steps]) => ({ kind: "unmatchedFile", featurePath, steps }));
  }

  private async defsByKeyword(): Promise<Record<Keyword, StepDefinitionNode[]>> {
    const usages = await this.index.getAllUsages();
    const groups: Record<Keyword, StepDefinitionNode[]> = { Given: [], When: [], Then: [] };
    for (const [def, uses] of usages) {
      const { label } = humanizeRegexSource(def.pattern, def.isRegex);
      for (const keyword of keywordsFor(def.keyword)) {
        groups[keyword].push({
          kind: "stepDefinition",
          keyword,
          humanized: label,
          usageCount: uses.length,
          filePath: def.filePath,
          line: def.line,
          pattern: def.pattern,
          isRegex: def.isRegex,
        });
      }
    }
    for (const keyword of KEYWORDS) {
      groups[keyword].sort((a, b) => a.humanized.localeCompare(b.humanized));
    }
    return groups;
  }
}

function navigateCommand(filePath: string, line: number): vscode.Command {
  return {
    command: "vscode.open",
    title: "Open",
    arguments: [vscode.Uri.file(filePath), { selection: new vscode.Range(line, 0, line, 0) }],
  };
}
