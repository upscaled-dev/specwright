import * as vscode from "vscode";
import { Logger } from "../utils/logger";
import { scenarioDropId } from "../traceability/board-data";
import { BulkCreateResult, BulkCreateScenario, runBulkCreate } from "../traceability/bulk-create-flow";
import { TraceabilityAdapter } from "../traceability/contracts";
import { scenarioGherkinSlice } from "../traceability/link-scenario";
import { applyTagInsert } from "../traceability/tag-edit";
import type { TraceabilitySnapshot } from "../traceability/traceability-model";

// Everything here is read at call time: the subsystem is wired and the board opened long after the
// CommandManager builds this.
export interface AuthoringCommandDeps {
  snapshot(): TraceabilitySnapshot | undefined;
  adapter(): TraceabilityAdapter | undefined;
  // The board's Mapping tab selection (scenario drop ids) and its project scope. The palette entry and
  // the board's Create tests button read the same two, so both create in the same place.
  selectedScenarios(): readonly string[];
  targetProject(): string | undefined;
  credentialsPresent(): Promise<boolean>;
  // The normalized site, named in the confirm so the user sees which tracker is about to be written to.
  siteUrl(): string;
  // The additive snapshot merge a created key gets, shared with the single create flow.
  merge(key: string): void;
}

const NO_SELECTION = "Select scenarios on the Coverage Board's Mapping tab first.";

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

// The authoring commands: creating remote tests from local scenarios in bulk. The single-scenario
// create still lives on the link picker's create path.
export class TraceabilityAuthoringCommands {
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly deps: AuthoringCommandDeps
  ) {}

  /**
   * Create one remote test per scenario checked on the Coverage Board, in the board's selected project,
   * tagging each scenario as its test lands. Prechecks run before any remote call: a selection, an
   * authoring-capable connected adapter, and a target project. One modal confirms the whole batch, then
   * the sequential flow runs under a cancellable progress notification.
   *
   * Serialized: the palette entry and the board's button are two doors onto the same writes, and a
   * second batch over the same selection would create duplicate tests for scenarios the first has not
   * tagged yet, so an invocation while one is running joins it instead of starting another.
   */
  public bulkCreateTests(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.createFromSelection().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async createFromSelection(): Promise<void> {
    const ids = this.deps.selectedScenarios();
    if (ids.length === 0) {
      vscode.window.showInformationMessage(NO_SELECTION);
      return;
    }
    const adapter = this.deps.adapter();
    const authoring = adapter?.testAuthoring;
    if (!adapter || !authoring || !(await this.deps.credentialsPresent())) {
      vscode.window.showInformationMessage("Connect to your test tracker before creating tests from scenarios.");
      return;
    }
    const project = this.deps.targetProject();
    if (project === undefined) {
      vscode.window.showInformationMessage("Pick a project on the Coverage Board to create these tests in.");
      return;
    }
    const scenarios = await this.resolveScenarios(ids);
    if (scenarios.length === 0) {
      vscode.window.showWarningMessage("That selection is out of date because the board changed. Pick the scenarios again.");
      return;
    }
    if (!(await this.confirm(project, scenarios.length, adapter.label))) {
      return;
    }
    const result = await this.runBatch(scenarios, project, adapter, authoring);
    // Counted against the selection, not the resolved list, so the scenarios that dropped out above
    // are named in the summary instead of vanishing from it.
    await this.report(result, { selected: ids.length, dropped: ids.length - scenarios.length }, adapter.label);
  }

  // Resolve the board's drop ids against the CURRENT snapshot and read each scenario's verbatim Gherkin
  // up front. A selection staged before a rebuild names a card that is gone, and a feature file can have
  // been deleted since the board painted it; both drop out here with a logged reason and are counted as
  // not attempted, rather than failing the whole batch.
  //
  // Descending line order within a file is load-bearing: an inserted tag line shifts everything below
  // it, so the batch writes bottom-up and no later write sits on a line its own predecessor moved.
  private async resolveScenarios(ids: readonly string[]): Promise<BulkCreateScenario[]> {
    const live = new Map((this.deps.snapshot()?.untraced ?? []).map((item) => [scenarioDropId(item.scenario), item.scenario]));
    const scenarios: BulkCreateScenario[] = [];
    for (const id of ids) {
      const ref = live.get(id);
      if (ref === undefined) {
        this.logger.warn("A selected scenario is no longer on the board", { scenario: id });
        continue;
      }
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(ref.filePath));
        scenarios.push({ ref, gherkin: scenarioGherkinSlice(doc.getText().split("\n"), ref.line) });
      } catch (error) {
        this.logger.warn("A selected scenario's feature file could not be read", {
          scenario: ref.name,
          error: errMsg(error),
        });
      }
    }
    return scenarios.sort((a, b) => a.ref.filePath.localeCompare(b.ref.filePath) || b.ref.line - a.ref.line);
  }

  // The batch wrote each scenario's location down before the confirm, and lines move: this batch's own
  // inserts shift them, and so can an edit from outside. The captured slice starts AT the scenario's
  // keyword line, so the check is that the captured position still reads that same keyword line;
  // anything else is a different scenario and is rejected rather than tagged. Two scenarios sharing an
  // identical heading swapped by an outside edit pass, which is fine: the tag still lands on a scenario
  // whose heading is exactly the one the created test was authored from.
  private async locationHolds(scenario: BulkCreateScenario): Promise<boolean> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(scenario.ref.filePath));
    const current = doc.getText().split("\n")[scenario.ref.line - 1];
    return current !== undefined && stripCr(current) === scenario.gherkin.split("\n")[0];
  }

  private async confirm(project: string, count: number, providerLabel: string): Promise<boolean> {
    const site = this.deps.siteUrl();
    const target = site !== "" ? `project ${project} on ${site}` : `project ${project}`;
    const choice = await vscode.window.showWarningMessage(
      `Create ${count} new ${providerLabel} ${plural(count, "test")} in ${target}, one per selected scenario?`,
      { modal: true },
      "Create tests"
    );
    return choice === "Create tests";
  }

  private runBatch(
    scenarios: readonly BulkCreateScenario[],
    project: string,
    adapter: TraceabilityAdapter,
    authoring: NonNullable<TraceabilityAdapter["testAuthoring"]>
  ): Thenable<BulkCreateResult> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating ${adapter.label} tests in ${project}…`,
        cancellable: true,
      },
      (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return runBulkCreate(
          scenarios,
          project,
          {
            locationHolds: (scenario) => this.locationHolds(scenario),
            createTest: (spec, signal) => authoring.createTest(spec, signal),
            insertTag: (scenario, key) => applyTagInsert(scenario.ref, key, adapter.keyGrammar),
            merge: (key) => this.deps.merge(key),
            report: (scenario, index) => {
              progress.report({
                message: `${index + 1}/${scenarios.length} ${scenario.ref.name}`,
                increment: index === 0 ? 0 : 100 / scenarios.length,
              });
            },
          },
          controller.signal
        );
      }
    );
  }

  // One summary after the loop. A toast cannot carry N reasons, so every anomaly writes its own reason
  // to the log (a failed item here, an entry dropped at resolve time there) and the toast offers the
  // route whenever a reason exists. The scenarios a cancellation never reached are counted from the
  // selection the batch started with, so a stopped batch never reads as a whole one; they log nothing,
  // since there is nothing to say about them beyond the count.
  private async report(
    result: BulkCreateResult,
    counts: { selected: number; dropped: number },
    providerLabel: string
  ): Promise<void> {
    for (const failure of result.failed) {
      this.logger.warn("Creating a test from a scenario failed", {
        scenario: failure.scenario.ref.name,
        reason: failure.reason,
      });
    }
    const notAttempted = counts.selected - result.created.length - result.failed.length;
    const parts = [`Created ${result.created.length} ${providerLabel} ${plural(result.created.length, "test")}`];
    if (result.failed.length > 0) {
      parts.push(`${result.failed.length} ${plural(result.failed.length, "scenario")} failed`);
    }
    if (notAttempted > 0) {
      parts.push(`${notAttempted} not attempted`);
    }
    const summary = `${parts.join(", ")}.`;
    if (parts.length === 1) {
      vscode.window.showInformationMessage(summary);
      return;
    }
    const logged = result.failed.length > 0 || counts.dropped > 0;
    const pick = await vscode.window.showWarningMessage(summary, ...(logged ? ["Show Output"] : []));
    if (pick === "Show Output") {
      this.logger.showOutput();
    }
  }
}
