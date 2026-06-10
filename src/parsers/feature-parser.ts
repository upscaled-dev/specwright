import * as fs from "fs";
import * as vscode from "vscode";
import { OutlineExampleRow, OutlineStub, ParsedFeature, RegularScenario, Scenario } from "../types/index";
import { Logger } from "../utils/logger";
import { TAG_TOKEN_PATTERN } from "./tag-regex";

export function isOutlineExampleRow(s: Scenario): s is OutlineExampleRow {
  return s.isScenarioOutline && "examplesBlockLineNumber" in s;
}

// "Example:" and "Scenario Template:" are standard Gherkin synonyms — keep in
// sync with SCENARIO_BOUNDARY_RE in providers/scenario-boundary.ts.
const SCENARIO_KEYWORDS = [
  "Scenario Outline:",
  "Scenario Template:",
  "Scenario:",
  "Example:",
] as const;

/**
 * Parser for Gherkin feature files
 */
export class FeatureParser {
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? Logger.create();
  }

  public static create(logger?: Logger): FeatureParser {
    return new FeatureParser(logger);
  }
  /**
   * Parse a feature file and extract scenarios
   * @param filePath - Path to the feature file
   * @returns Parsed feature data
   */
  public parseFeatureFile(filePath: string): ParsedFeature | null {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return this.parseFeatureContent(content);
    } catch (error) {
      this.logger.error("Error parsing feature file:", { error });
      return null;
    }
  }

  /**
   * Parse feature content and extract scenarios
   * @param content - Feature file content
   * @returns Parsed feature data with line number information
   */
  public parseFeatureContent(content: string): ParsedFeature | null {
    try {
      const lines = content.split("\n");
      const featureInfo = this.extractFeatureInfo(lines);

      // Return null if no valid feature name was found
      if (featureInfo.name === "Unknown Feature") {
        return null;
      }

      // Pass featureLineNumber to extractScenarios
      const scenarios = this.extractScenarios(lines, featureInfo.lineNumber);

      return {
        feature: featureInfo.name,
        scenarios,
        filePath: "", // Will be set by caller
        featureLineNumber: featureInfo.lineNumber,
      };
    } catch (error) {
      this.logger.error("Error parsing feature content:", { error });
      return null;
    }
  }

  /**
   * Extract feature name and line number from content
   * @param lines - Feature file lines
   * @returns Feature info with name and line number
   */
  private extractFeatureInfo(lines: string[]): {
    name: string;
    lineNumber: number;
  } {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line) {
        const trimmed = line.trim();
        if (trimmed.startsWith("Feature:")) {
          return {
            name: trimmed.substring(8).trim(),
            lineNumber: i + 1, // 1-based line number
          };
        }
      }
    }
    return { name: "Unknown Feature", lineNumber: 1 };
  }

  /**
   * Extract scenarios from content. Supports:
   * - Background (feature-level and rule-level — steps attached to each child scenario)
   * - Rule (Gherkin 6+ — scenarios inside a Rule carry its name)
   * - Scenario Outline with one or more (named, tagged) Examples blocks
   * @param lines - Feature file lines
   * @returns Array of scenarios with expanded examples
   */
  private extractScenarios(lines: string[], featureLineNumber: number): Scenario[] {
    interface ExamplesBlock {
      name?: string;
      tags: string[];
      headers: string[];
      data: string[][];
      lineNumbers: number[];
      blockLineNumber: number;
    }
    interface ScenarioDraft {
      name: string;
      line: number;
      range: vscode.Range;
      lineNumber: number;
      steps: string[];
      tags: string[];
      filePath: string;
      isScenarioOutline: boolean;
      featureLineNumber: number;
      ruleName?: string;
      backgroundSteps?: string[];
    }
    interface OutlineCollect {
      scenario: ScenarioDraft;
      examplesBlocks: ExamplesBlock[];
      outlineLineNumber: number;
    }

    const isStepLine = (s: string): boolean =>
      /^(Given|When|Then|And|But|\*) /.test(s);
    const isTableRow = (s: string): boolean =>
      s.startsWith("|") && s.endsWith("|");
    // Empty cells must survive so values stay aligned with their headers.
    const parseTableRow = (s: string): string[] =>
      s.substring(1, s.length - 1).split("|").map((c) => c.trim());

    const regularDrafts: ScenarioDraft[] = [];
    const scenarioOutlines: OutlineCollect[] = [];

    let pendingTags: string[] = [];
    let featureTags: string[] = [];
    let docStringDelimiter: string | null = null;
    let currentScenario: ScenarioDraft | null = null;
    let currentOutline: OutlineCollect | null = null;
    let currentExamplesBlock: ExamplesBlock | null = null;

    let featureBackgroundSteps: string[] = [];
    let ruleBackgroundSteps: string[] = [];
    let currentRuleName: string | undefined;
    let backgroundTarget: "feature" | "rule" | null = null; // active Background collection

    const flushCurrentScenario = (): void => {
      if (!currentScenario) {return;}
      if (currentOutline) {
        if (currentExamplesBlock) {
          currentOutline.examplesBlocks.push(currentExamplesBlock);
          currentExamplesBlock = null;
        }
        scenarioOutlines.push(currentOutline);
        currentOutline = null;
      } else {
        regularDrafts.push(currentScenario);
      }
      currentScenario = null;
    };

    const consumeTags = (): string[] => {
      const t = pendingTags;
      pendingTags = [];
      return t;
    };

    const combinedBackgroundSteps = (): string[] => {
      return [...featureBackgroundSteps, ...ruleBackgroundSteps];
    };

    let lineNumber = 1;
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();

      // Docstring content must never be parsed as steps, scenarios, or tags.
      if (docStringDelimiter) {
        if (trimmed.startsWith(docStringDelimiter)) {
          docStringDelimiter = null;
        }
        lineNumber++;
        continue;
      }
      if (trimmed.startsWith(`"""`) || trimmed.startsWith("```")) {
        docStringDelimiter = trimmed.startsWith(`"""`) ? `"""` : "```";
        lineNumber++;
        continue;
      }

      if (trimmed === "" || trimmed.startsWith("#")) {
        lineNumber++;
        continue;
      }

      if (trimmed.startsWith("@")) {
        for (const m of trimmed.matchAll(new RegExp(TAG_TOKEN_PATTERN, "g"))) {
          pendingTags.push(m[0]);
        }
        lineNumber++;
        continue;
      }

      if (trimmed.startsWith("Feature:")) {
        featureTags = consumeTags();
        lineNumber++;
        continue;
      }

      if (trimmed.startsWith("Rule:")) {
        flushCurrentScenario();
        currentRuleName = trimmed.substring(5).trim() || undefined;
        ruleBackgroundSteps = [];
        backgroundTarget = null;
        if (pendingTags.length > 0) {
          this.logger.warn(
            `Tags ${pendingTags.join(" ")} above 'Rule:' on line ${lineNumber} were dropped — rule-level tags don't auto-propagate to child scenarios. Apply them on the scenario or examples block where you want them to take effect.`
          );
        }
        pendingTags = [];
        lineNumber++;
        continue;
      }

      if (trimmed.startsWith("Background:")) {
        flushCurrentScenario();
        backgroundTarget = currentRuleName ? "rule" : "feature";
        if (backgroundTarget === "feature") {
          featureBackgroundSteps = [];
        } else {
          ruleBackgroundSteps = [];
        }
        pendingTags = []; // Background can't be tagged
        lineNumber++;
        continue;
      }

      const scenarioKeyword = SCENARIO_KEYWORDS.find((k) => trimmed.startsWith(k));
      if (scenarioKeyword) {
        flushCurrentScenario();
        backgroundTarget = null;

        const isOutline =
          scenarioKeyword === "Scenario Outline:" || scenarioKeyword === "Scenario Template:";
        const name = trimmed.substring(scenarioKeyword.length).trim();
        if (!name) {
          this.logger.warn(`Empty ${isOutline ? "scenario outline" : "scenario"} name at line ${lineNumber}`);
        }

        const scenario: ScenarioDraft = {
          name: name || (isOutline ? "Unnamed Scenario Outline" : "Unnamed Scenario"),
          line: lineNumber,
          range: new vscode.Range(lineNumber - 1, 0, lineNumber - 1, 0),
          lineNumber,
          steps: [],
          tags: [...featureTags, ...consumeTags()],
          filePath: "",
          isScenarioOutline: isOutline,
          featureLineNumber,
        };
        if (currentRuleName) {scenario.ruleName = currentRuleName;}
        const bg = combinedBackgroundSteps();
        if (bg.length > 0) {scenario.backgroundSteps = bg;}

        if (isOutline) {
          currentOutline = { scenario, examplesBlocks: [], outlineLineNumber: lineNumber };
        }
        currentScenario = scenario;
        lineNumber++;
        continue;
      }

      if (trimmed.startsWith("Examples:") && currentOutline) {
        if (currentExamplesBlock) {
          currentOutline.examplesBlocks.push(currentExamplesBlock);
        }
        const blockName = trimmed.substring(9).trim() || undefined;
        currentExamplesBlock = {
          ...(blockName ? { name: blockName } : {}),
          tags: consumeTags(),
          headers: [],
          data: [],
          lineNumbers: [],
          blockLineNumber: lineNumber,
        };
        lineNumber++;
        continue;
      }

      if (currentExamplesBlock && isTableRow(trimmed)) {
        const cells = parseTableRow(trimmed);
        if (currentExamplesBlock.headers.length === 0) {
          currentExamplesBlock.headers = cells;
        } else {
          currentExamplesBlock.data.push(cells);
          currentExamplesBlock.lineNumbers.push(lineNumber);
        }
        lineNumber++;
        continue;
      }

      if (isStepLine(trimmed)) {
        if (backgroundTarget === "feature") {
          featureBackgroundSteps.push(trimmed);
        } else if (backgroundTarget === "rule") {
          ruleBackgroundSteps.push(trimmed);
        } else if (currentScenario) {
          currentScenario.steps.push(trimmed);
        }
        lineNumber++;
        continue;
      }

      // Data tables are step arguments, so they continue a Background; any other
      // non-step line terminates Background collection.
      if (backgroundTarget && !isTableRow(trimmed)) {
        backgroundTarget = null;
      }

      lineNumber++;
    }

    flushCurrentScenario();

    const finalScenarios: Scenario[] = [];

    for (const draft of regularDrafts) {
      const regular: RegularScenario = {
        name: draft.name,
        line: draft.line,
        range: draft.range,
        lineNumber: draft.lineNumber,
        steps: draft.steps,
        tags: draft.tags,
        filePath: draft.filePath,
        isScenarioOutline: false,
        featureLineNumber: draft.featureLineNumber,
      };
      if (draft.ruleName) {regular.ruleName = draft.ruleName;}
      if (draft.backgroundSteps) {regular.backgroundSteps = draft.backgroundSteps;}
      finalScenarios.push(regular);
    }

    for (const outline of scenarioOutlines) {
      const allRows = outline.examplesBlocks.reduce((sum, b) => sum + b.data.length, 0);
      if (allRows === 0) {
        this.logger.warn(
          `Scenario Outline '${outline.scenario.name}' has no Examples rows; it will appear in the Test Explorer but cannot be run.`
        );
        const stubScenario: OutlineStub = {
          name: outline.scenario.name,
          line: outline.scenario.line,
          range: outline.scenario.range,
          lineNumber: outline.scenario.lineNumber,
          steps: outline.scenario.steps,
          tags: outline.scenario.tags,
          filePath: outline.scenario.filePath,
          isScenarioOutline: true,
          featureLineNumber: outline.scenario.featureLineNumber,
          outlineLineNumber: outline.outlineLineNumber,
          outlineName: outline.scenario.name,
        };
        if (outline.scenario.ruleName) {stubScenario.ruleName = outline.scenario.ruleName;}
        if (outline.scenario.backgroundSteps) {stubScenario.backgroundSteps = outline.scenario.backgroundSteps;}
        finalScenarios.push(stubScenario);
        continue;
      }

      let exampleIndex = 0;
      for (const block of outline.examplesBlocks) {
        for (let i = 0; i < block.data.length; i++) {
          const row = block.data[i];
          if (!row) {continue;}
          exampleIndex++;
          const exampleLine = block.lineNumbers[i] ?? outline.scenario.line + exampleIndex;
          const exampleValues = row
            .map((value, idx) => {
              const header = block.headers[idx];
              if (!header) {return `param${idx}: ${value}`;}
              return `${header}: ${value}`;
            })
            .join(", ");

          const mergedTags = [...(outline.scenario.tags ?? []), ...block.tags];
          const exampleScenario: OutlineExampleRow = {
            name: `${exampleIndex}: ${outline.scenario.name} - ${exampleValues}`,
            line: exampleLine,
            range: new vscode.Range(exampleLine - 1, 0, exampleLine - 1, 0),
            lineNumber: exampleLine,
            steps: outline.scenario.steps,
            tags: mergedTags,
            filePath: "",
            isScenarioOutline: true,
            outlineLineNumber: outline.outlineLineNumber,
            outlineName: outline.scenario.name,
            featureLineNumber,
            examplesBlockLineNumber: block.blockLineNumber,
          };
          if (block.name) {exampleScenario.examplesBlockName = block.name;}
          if (block.tags.length > 0) {exampleScenario.examplesBlockTags = block.tags;}
          if (outline.scenario.ruleName) {exampleScenario.ruleName = outline.scenario.ruleName;}
          if (outline.scenario.backgroundSteps) {exampleScenario.backgroundSteps = outline.scenario.backgroundSteps;}
          finalScenarios.push(exampleScenario);
        }
      }
    }

    return finalScenarios;
  }

  /**
   * Extract all unique tags from a feature file
   * @param content - Feature file content
   * @returns Array of unique tags
   */
  private extractTags(content: string): string[] {
    const tags = new Set<string>();
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("@")) {
        for (const m of trimmed.matchAll(new RegExp(TAG_TOKEN_PATTERN, "g"))) {
          tags.add(m[0]);
        }
      }
    }

    return Array.from(tags).sort();
  }

  /**
   * Calculate the range for a scenario (from scenario line to next scenario or end of file)
   * @param lines - Array of file lines
   * @param scenarioLineNumber - 1-based line number of the scenario
   * @returns Range object spanning the scenario
   */
  private getScenarioRange(
    lines: string[],
    scenarioLineNumber: number
  ): vscode.Range {
    const startLine = scenarioLineNumber - 1; // Convert to 0-based
    let endLine = startLine;

    // Find the end of this scenario (next scenario or end of file)
    for (let i = scenarioLineNumber; i < lines.length; i++) {
      const line = lines[i]?.trim() ?? "";
      // Stop at next scenario, scenario outline, or feature
      if (
        line.startsWith("Scenario:") ||
        line.startsWith("Scenario Outline:") ||
        line.startsWith("Feature:")
      ) {
        break;
      }
      endLine = i;
    }

    return new vscode.Range(startLine, 0, endLine, 0);
  }

  /**
   * Provide CodeLens for scenarios in a feature file
   * @param content - Feature file content
   * @param filePath - Path to the feature file
   * @returns Array of CodeLens
   */
  public provideScenarioCodeLenses(
    content: string,
    filePath: string
  ): vscode.CodeLens[] {
    const codeLenses: vscode.CodeLens[] = [];
    const lines = content.split("\n");
    let lineNumber = 1;

    // Extract all available tags from the feature file
    const allTags = this.extractTags(content);

    // Parse scenarios to get scenario outline examples
    const parsedFeature = this.parseFeatureContent(content);
    const scenarioOutlineExamples =
      parsedFeature?.scenarios.filter(isOutlineExampleRow) ?? [];

    for (const line of lines) {
      const trimmed = line.trim();

      if (
        trimmed.startsWith("Scenario:") ||
        trimmed.startsWith("Scenario Outline:")
      ) {
        const isScenarioOutline = trimmed.startsWith("Scenario Outline:");
        const scenarioName = isScenarioOutline
          ? trimmed.substring(17).trim()
          : trimmed.substring(9).trim();

        // Calculate the range for this scenario (multiline)
        const scenarioRange = this.getScenarioRange(lines, lineNumber);

        // Add Run Scenario CodeLens
        codeLenses.push(
          new vscode.CodeLens(scenarioRange, {
            title: isScenarioOutline
              ? "▶️ Run Scenario Outline"
              : "▶️ Run Scenario",
            command: "playwrightBddRunner.runScenario",
            arguments: [filePath, lineNumber, scenarioName],
          })
        );

        // Add Debug Scenario CodeLens
        codeLenses.push(
          new vscode.CodeLens(scenarioRange, {
            title: isScenarioOutline
              ? "🐛 Debug Scenario Outline"
              : "🐛 Debug Scenario",
            command: "playwrightBddRunner.debugScenario",
            arguments: [filePath, lineNumber, scenarioName],
          })
        );
      }

      lineNumber++;
    }

    // Add CodeLens for individual scenario outline examples
    for (const example of scenarioOutlineExamples) {
      const exampleRange = new vscode.Range(
        example.lineNumber - 1,
        0,
        example.lineNumber - 1,
        0
      );

      // Add Run Example CodeLens
      codeLenses.push(
        new vscode.CodeLens(exampleRange, {
          title: "▶️ Run Example",
          command: "playwrightBddRunner.runScenario",
          arguments: [filePath, example.lineNumber, example.name],
        })
      );

      // Add Debug Example CodeLens
      codeLenses.push(
        new vscode.CodeLens(exampleRange, {
          title: "🐛 Debug Example",
          command: "playwrightBddRunner.debugScenario",
          arguments: [filePath, example.lineNumber, example.name],
        })
      );
    }

    // Add feature-level CodeLens at the top of the file
    if (lines.length > 0) {
      // Find the Feature: line (it might be after tags)
      let featureLineIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (typeof line === "string" && line.trim().startsWith("Feature:")) {
          featureLineIndex = i;
          break;
        }
      }

      if (featureLineIndex >= 0) {
        // Calculate feature range (from feature line to first scenario or end of file)
        let featureEndLine = featureLineIndex;
        for (let i = featureLineIndex + 1; i < lines.length; i++) {
          const line = lines[i]?.trim() ?? "";
          if (
            line.startsWith("Scenario:") ||
            line.startsWith("Scenario Outline:")
          ) {
            break;
          }
          featureEndLine = i;
        }
        const featureRange = new vscode.Range(0, 0, featureEndLine, 0);

        // Add Run Feature File CodeLens
        codeLenses.push(
          new vscode.CodeLens(featureRange, {
            title: "📁 Run Feature File",
            command: "playwrightBddRunner.runFeatureFile",
            arguments: [filePath],
          })
        );

        // Add individual tag CodeLenses for all unique tags
        for (const tag of allTags) {
          codeLenses.push(
            new vscode.CodeLens(featureRange, {
              title: `🏷️ Run with ${tag}`,
              command: "playwrightBddRunner.runFeatureFileWithTags",
              arguments: [filePath, tag],
            })
          );
        }
      }
    }

    return codeLenses;
  }

}
