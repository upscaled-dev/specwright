import * as vscode from "vscode";
import { Logger } from "../utils/logger";
import { ExtensionConfig } from "../core/extension-config";
import { TestExecutor } from "../core/test-executor";
import { TestDiscoveryManager } from "../core/test-discovery-manager";
import { TestOrganizationManager } from "../core/test-organization";
import { FeatureParser } from "../parsers/feature-parser";
import { PlaywrightJsonParser } from "../utils/playwright-json-parser";
import type { RunProgressObserver } from "../core/run-progress";

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
  /**
   * The scenario's verbatim source slice (`scenarioGherkinSlice`), captured at parse time because the
   * raw lines are only in hand there. This is the local text every remote comparison uses: the drift
   * badge, the create path, and the push path all read the same string, so they cannot contradict each
   * other on an outline, a data table, or a doc-string. Optional only so hand-built test fixtures need
   * not spell it out; the parser always sets it, and a scenario without it is simply never compared.
   * Outline rows share their outline's slice by reference, so a parse retains about one copy of the
   * file's text, not one per example row.
   */
  gherkin?: string | undefined;
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
  /**
   * The outline title with this row's example values substituted for its `<placeholder>` tokens:
   * the exact test title playwright-bdd generates when the outline title carries placeholders.
   * Unset when the title has none (those generated tests are titled "Example #N" instead).
   */
  substitutedName?: string | undefined;
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
  /**
   * Preferred precise target: a `<generatedSpec>:<pwTestLine>` filter that selects exactly one
   * generated test. Resolved from the spec's `bddFileData` (pickleLine→pwTestLine). When set, the
   * command builder uses it INSTEAD of `--grep`, which is the only reliable way to target a single
   * Scenario Outline example row; playwright-bdd substitutes the example values into the test
   * title, so no grep on the source title (with raw `<placeholders>`) can pick one row. Unset →
   * the builder falls back to grepping by scenario/outline name.
   */
  specLineTarget?: string;
  /**
   * Regex positional filter scoping a name-based `--grep` to one generated spec file. Set for
   * whole-outline runs, whose title grep is intentional for every row of THAT outline but must not
   * reach a same-titled outline in another feature file.
   */
  specFileFilter?: string;
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
  /** Aborts the spawned run when the Test Explorer stop button is pressed. */
  signal?: AbortSignal | undefined;
  /** Receives scenario result updates while Playwright is still running. */
  progress?: RunProgressObserver | undefined;
  /** Open run-artifact batch this invocation's shard belongs to; unset → no artifact is captured. */
  artifactBatch?: number | undefined;
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
  executionGateway: import("../core/run-contracts").ExecutionGateway;
  discoveryManager: TestDiscoveryManager;
  organizationManager: TestOrganizationManager;
  featureParser: FeatureParser;
  playwrightJsonParser: PlaywrightJsonParser;
  commandBuilder: import("../core/command-builder").CommandBuilder;
  bddgenDiagnostics?: import("../providers/bddgen-diagnostics-provider").BddgenDiagnosticsProvider | undefined;
  traceabilityAdapter: import("../traceability/contracts").TraceabilityAdapter;
  // Badge-feeding subset of the run-artifact seam (§3.5): the ephemeral JSON report parsed after an
  // extension-launched run lands here so the traceability tree updates without a report on disk.
  runResultStore?: import("../traceability/run-result-store").RunResultStore | undefined;
  // The richer sibling fed at the same capture seams: a Test Explorer batch opens a builder, each
  // executor invocation contributes a shard, and the batch seals one immutable, publishable artifact.
  runArtifactStore?: import("../traceability/run-artifact-store").RunArtifactStore | undefined;
}
