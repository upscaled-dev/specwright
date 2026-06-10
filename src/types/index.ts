import * as vscode from "vscode";
import { Logger } from "../utils/logger";
import { ExtensionConfig } from "../core/extension-config";
import { TestExecutor } from "../core/test-executor";
import { TestDiscoveryManager } from "../core/test-discovery-manager";
import { TestOrganizationManager } from "../core/test-organization";
import { FeatureParser } from "../parsers/feature-parser";
import { PlaywrightJsonParser } from "../utils/playwright-json-parser";

/**
 * Represents a parsed feature file with its scenarios
 */
export interface ParsedFeature {
  feature: string;
  scenarios: Scenario[];
  filePath: string;
  featureLineNumber?: number;
}

interface ScenarioBase {
  name: string;
  line: number;
  range: vscode.Range;
  lineNumber: number;
  steps: string[];
  tags?: string[] | undefined;
  filePath: string;
  featureLineNumber?: number | undefined;
  ruleName?: string | undefined;
  backgroundSteps?: string[] | undefined;
}

export interface RegularScenario extends ScenarioBase {
  isScenarioOutline: false;
}

export interface OutlineExampleRow extends ScenarioBase {
  isScenarioOutline: true;
  outlineLineNumber: number;
  outlineName: string;
  examplesBlockLineNumber: number;
  examplesBlockName?: string | undefined;
  examplesBlockTags?: string[] | undefined;
}

export interface OutlineStub extends ScenarioBase {
  isScenarioOutline: true;
  outlineLineNumber: number;
  outlineName: string;
}

export type Scenario = RegularScenario | OutlineExampleRow | OutlineStub;

/**
 * Result of running a test
 */
export interface TestRunResult {
  success: boolean;
  output: string;
  error?: string;
  duration: number;
}

/**
 * Test execution options
 */
export interface TestExecutionOptions {
  filePath: string;
  lineNumber?: number;
  scenarioName?: string;
  outlineName?: string;
  debug?: boolean;
  waitForSessionEnd?: boolean | undefined;
  /**
   * When set, a debug run writes Playwright's JSON report to this file (the debugged command
   * runs in a terminal, so stdout capture isn't available). Unset → no JSON reporter is added.
   */
  jsonReportPath?: string | undefined;
  tags?: string;
  parallel?: boolean;
  reporter?: string;
  dryRun?: boolean;
}

/**
 * Parallel execution options
 */
export interface ParallelExecutionOptions {
  featureFiles: string[];
  maxProcesses: number;
  tags?: string;
}

/**
 * Feature file execution options
 */
export interface FeatureExecutionOptions {
  filePath: string;
  /**
   * The Feature title (the text after `Feature:`). When provided, runs grep by this exact title
   * instead of the filename, so a feature run can't accidentally match a different feature whose
   * scenario titles happen to contain the filename.
   */
  featureName?: string;
  tags?: string;
  parallel?: boolean;
  reporter?: string;
  dryRun?: boolean;
}

export type CommandArguments = unknown[];

export type CommandHandler = (
  ...args: CommandArguments
) => Promise<void> | void;

export type LogData =
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null
  | undefined;

export interface TestOrganizationStrategy {
  readonly strategyType: string;
  organizeTests(scenarios: Scenario[]): TestGroup[];
  getGroupLabel(group: TestGroup): string;
  getGroupDescription(group: TestGroup): string;
  getDescription(): string;
}

export interface TestGroup {
  id: string;
  label: string;
  description: string;
  scenarios: Scenario[];
}

export interface CacheEntry<T> {
  timestamp: number;
  data: T;
}

export interface DiscoveryOptions {
  pattern?: string;
  maxCacheAge?: number;
  forceRefresh?: boolean;
}

export type ConfigurationChangeListener = () => void;

/**
 * Context object containing all dependencies for the Specwright extension
 */
export interface PlaywrightBddExtensionContext {
  logger: Logger;
  config: ExtensionConfig;
  testExecutor: TestExecutor;
  discoveryManager: TestDiscoveryManager;
  organizationManager: TestOrganizationManager;
  featureParser: FeatureParser;
  playwrightJsonParser: PlaywrightJsonParser;
  commandBuilder: import("../core/command-builder").CommandBuilder;
  bddgenDiagnostics?: import("../providers/bddgen-diagnostics-provider").BddgenDiagnosticsProvider | undefined;
}
