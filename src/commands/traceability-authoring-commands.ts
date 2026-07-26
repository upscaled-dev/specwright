import * as vscode from "vscode";
import { Logger } from "../utils/logger";
import { errMsg, plural } from "../utils/text";
import { resolveBoardLink, scenarioDropId } from "../traceability/board-data";
import { BulkCreateResult, BulkCreateScenario, runBulkCreate } from "../traceability/bulk-create-flow";
import { runContainerCreate } from "../traceability/container-create-flow";
import { opensScenario, scenarioGherkinSlice } from "../parsers/gherkin-slice";
import {
  AuthoredTest,
  KeyGrammar,
  NewContainerSpec,
  RemoteSearchCapability,
  TestAuthoringCapability,
  TestCaseMetadata,
  TraceabilityAdapter,
} from "../traceability/contracts";
import { PushGherkinOutcome, runPushGherkin } from "../traceability/push-gherkin";
import type { ScenarioRef } from "../traceability/scenario-ref";
import { applyTagInsert } from "../traceability/tag-edit";
import type { TraceabilitySnapshot } from "../traceability/traceability-model";

// Everything here is read at call time: the subsystem is wired and the board opened long after the
// CommandManager builds this.
export interface AuthoringCommandDeps {
  snapshot(): TraceabilitySnapshot | undefined;
  adapter(): TraceabilityAdapter | undefined;
  // The board's Mapping tab selections (scenario drop ids, test keys) and its project scope. The palette
  // entries and the board's own buttons read the same ones, so both create in the same place.
  selectedScenarios(): readonly string[];
  selectedTests(): readonly string[];
  targetProject(): string | undefined;
  credentialsPresent(): Promise<boolean>;
  // The normalized site, named in the confirm so the user sees which tracker is about to be written to.
  siteUrl(): string;
  // The additive snapshot merge a created key gets, shared with the single create flow.
  merge(key: string): void;
  // Records a standalone execution create in the publish ledger, so the Executions tab shows it and a
  // later publish can append to it. The site and account stamps live with the ledger wiring, not here.
  recordExecution(key: string, summary: string): Promise<void>;
}

const NO_SELECTION = "Select scenarios on the Coverage Board's Mapping tab first.";
const NO_TEST_SELECTION = "Select tests on the Coverage Board's Mapping tab first.";
const NO_ROW = "Push Scenario Text: use the Push button on a linked scenario row on the Coverage Board.";
const NOT_CONNECTED_FOR_PUSH = "Connect to your test tracker before pushing scenario text.";
const STALE_ROW = "That link is out of date because the board changed. Try again.";
const EXAMPLE_ROW =
  "Pushing text is not available for an example-row link. Link the outline itself to push its text.";
const RESYNC = "Sync traceability, then try again.";

// Where a create is about to land, named the way every confirm names it: with the site when one is
// configured, so the user reads which tracker is being written to.
function projectTarget(site: string, project: string): string {
  return site !== "" ? `project ${project} on ${site}` : `project ${project}`;
}

// The remote issue id the last sync recorded for a test key, from wherever the board's card came from: a
// mapped test carries it on its link's metadata, an available one on the orphan's.
function issueIdFor(snapshot: TraceabilitySnapshot | undefined, key: string): string | undefined {
  const link = snapshot?.links.find((item) => item.testKey === key);
  return link?.meta?.issueId ?? snapshot?.orphans.find((item) => item.testKey === key)?.meta.issueId;
}

// The write one container verb runs, and how that verb reads its own seam off a capability that need
// not expose it. Bound at read time so an adapter implementing the seam as a class method keeps its
// receiver, like the push path does.
type ContainerSeam = (spec: NewContainerSpec) => Promise<AuthoredTest>;
type SeamOf = (authoring: TestAuthoringCapability) => ContainerSeam | undefined;

// The authoring commands: creating remote tests from local scenarios in bulk, pushing a scenario's text
// to its test, and gathering picked tests into a new container. The single-scenario create still lives
// on the link picker's create path.
export class TraceabilityAuthoringCommands {
  private inFlight: Promise<void> | undefined;
  private containerInFlight: Promise<void> | undefined;
  private pushInFlight: Promise<void> | undefined;

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

  /**
   * Create one remote Test Set / Test Plan holding the tests checked on the Coverage Board, in the
   * board's selected project. Prechecks run before any remote call: a selection, an adapter exposing
   * that seam, credentials, and a target project; then the name prompt and one modal. The write itself
   * is all-or-nothing (`runContainerCreate`), so a checked test the snapshot has no issue id for stops
   * the batch before anything is created.
   */
  public createTestSet(): Promise<void> {
    return this.createContainer("Test Set", (authoring) => authoring.createTestSet?.bind(authoring));
  }

  public createTestPlan(): Promise<void> {
    return this.createContainer("Test Plan", (authoring) => authoring.createTestPlan?.bind(authoring));
  }

  /**
   * Create one EMPTY remote Test Execution in the board's selected project and record it in the publish
   * ledger, so the Executions tab shows it as created-not-published and a later publish can append to it.
   * It holds no tests and no environments, so it reads no selection: the same prechecks as the container
   * verbs minus the selection, then the name prompt and one modal. A response with no readable key writes
   * no ledger entry, since there would be nothing to show or append to.
   */
  public createTestExecution(): Promise<void> {
    return this.guarded(() => this.executionInScope());
  }

  private createContainer(kind: string, seamOf: SeamOf): Promise<void> {
    return this.guarded(() => this.containerFromSelection(kind, seamOf));
  }

  // One guard for every container verb: they write to the same project from the same board, so a second
  // invocation joins whichever create is running rather than authoring a duplicate. The flow is a thunk,
  // so a joined invocation never even opens its prompts.
  private guarded(run: () => Promise<void>): Promise<void> {
    if (this.containerInFlight) {
      return this.containerInFlight;
    }
    this.containerInFlight = run().finally(() => {
      this.containerInFlight = undefined;
    });
    return this.containerInFlight;
  }

  private async containerFromSelection(kind: string, seamOf: SeamOf): Promise<void> {
    const keys = this.deps.selectedTests();
    if (keys.length === 0) {
      vscode.window.showInformationMessage(NO_TEST_SELECTION);
      return;
    }
    const target = await this.containerTarget(kind, seamOf);
    if (target === undefined) {
      return;
    }
    const { adapter, seam, project } = target;
    const summary = (await this.containerSummary(kind, project, `${keys.length} ${plural(keys.length, "test")}`))?.trim();
    if (summary === undefined || summary === "") {
      return;
    }
    const holding = `holding ${keys.length} selected ${plural(keys.length, "test")}`;
    if (!(await this.confirmContainer(kind, project, holding, adapter.label))) {
      return;
    }
    const snapshot = this.deps.snapshot();
    try {
      const outcome = await runContainerCreate(keys, project, summary, {
        issueIdFor: (key) => issueIdFor(snapshot, key),
        create: seam,
      });
      if (outcome.kind === "unresolved") {
        const unresolved = outcome.keys.join(", ");
        this.logger.warn(`Creating a ${kind} was blocked by tests with no synced issue id`, { keys: unresolved });
        vscode.window.showWarningMessage(
          `Nothing was created: there is no synced issue id for ${unresolved}, which is the only handle a ${kind} takes. ${RESYNC}`
        );
        return;
      }
      this.reportCreated(
        outcome.created,
        kind,
        adapter.label,
        (key) => `Created ${kind} ${key} holding ${keys.length} ${plural(keys.length, "test")}.`
      );
    } catch (error) {
      this.reportCreateFailure(kind, project, error);
    }
  }

  private async executionInScope(): Promise<void> {
    const kind = "Test Execution";
    const target = await this.containerTarget(kind, (authoring) => authoring.createTestExecution?.bind(authoring));
    if (target === undefined) {
      return;
    }
    const { adapter, seam, project } = target;
    const today = new Date().toISOString().slice(0, 10);
    const summary = (await this.containerSummary(kind, project, today))?.trim();
    if (summary === undefined || summary === "") {
      return;
    }
    if (!(await this.confirmContainer(kind, project, "with no tests yet", adapter.label))) {
      return;
    }
    try {
      const created = await seam({ project, summary });
      if (created.key !== undefined) {
        await this.recordExecution(created.key, summary);
      }
      this.reportCreated(created, kind, adapter.label, (key) => `Created ${kind} ${key} in ${project}.`);
    } catch (error) {
      this.reportCreateFailure(kind, project, error);
    }
  }

  // The shared precheck behind every container verb: a connected adapter exposing this one's seam, and a
  // project to land in. Generic over the seam, since an execution takes a different spec than a container.
  private async containerTarget<T>(
    kind: string,
    seamOf: (authoring: TestAuthoringCapability) => T | undefined
  ): Promise<{ adapter: TraceabilityAdapter; seam: T; project: string } | undefined> {
    const adapter = this.deps.adapter();
    const authoring = adapter?.testAuthoring;
    const seam = authoring ? seamOf(authoring) : undefined;
    if (!adapter || seam === undefined || !(await this.deps.credentialsPresent())) {
      vscode.window.showInformationMessage(`Connect to your test tracker before creating a ${kind}.`);
      return undefined;
    }
    const project = this.deps.targetProject();
    if (project === undefined) {
      vscode.window.showInformationMessage(`Pick a project on the Coverage Board to create this ${kind} in.`);
      return undefined;
    }
    return { adapter, seam, project };
  }

  // The execution exists remotely by now, so a ledger write that fails costs only the Executions row: it
  // is logged, never turned into a failed create.
  private async recordExecution(key: string, summary: string): Promise<void> {
    try {
      await this.deps.recordExecution(key, summary);
    } catch (error) {
      this.logger.warn("Recording the created execution in the publish ledger failed", {
        key,
        error: errMsg(error),
      });
    }
  }

  private containerSummary(kind: string, project: string, detail: string): Thenable<string | undefined> {
    return vscode.window.showInputBox({
      title: `Create ${kind}`,
      prompt: `Name the ${kind} to create in ${project}.`,
      value: `${project} ${kind} (${detail})`,
      validateInput: (text) => (text.trim() === "" ? `The ${kind} needs a name.` : undefined),
    });
  }

  private async confirmContainer(
    kind: string,
    project: string,
    holding: string,
    providerLabel: string
  ): Promise<boolean> {
    const target = projectTarget(this.deps.siteUrl(), project);
    const action = `Create ${kind}`;
    const choice = await vscode.window.showWarningMessage(
      `Create a new ${providerLabel} ${kind} in ${target} ${holding}?`,
      { modal: true },
      action
    );
    return choice === action;
  }

  // Every container create reports the same way: warnings logged verbatim and appended to the line, and a
  // response that carried no key reported as an honest gap rather than a failure, since the issue exists
  // remotely either way. `landed` is the sentence for the readable case, which only the caller can word.
  private reportCreated(
    created: AuthoredTest,
    kind: string,
    providerLabel: string,
    landed: (key: string) => string
  ): void {
    if (created.warnings.length > 0) {
      this.logger.warn(`${providerLabel} returned warnings creating a ${kind}`, { warnings: created.warnings.join("; ") });
    }
    if (created.key === undefined) {
      const idNote = created.issueId !== undefined ? ` (issue id ${created.issueId})` : "";
      vscode.window.showWarningMessage(
        `The ${kind} was created${idNote} but its key could not be read back, so it could not be named here.`
      );
      return;
    }
    const base = landed(created.key);
    vscode.window.showInformationMessage(
      created.warnings.length > 0 ? `${base} Warnings: ${created.warnings.join("; ")}` : base
    );
  }

  private reportCreateFailure(kind: string, project: string, error: unknown): void {
    this.logger.error(`Creating a ${kind} failed`, { project, error: errMsg(error) });
    vscode.window.showErrorMessage(`Could not create this ${kind}: ${errMsg(error)}`);
  }

  /**
   * Push one mapped scenario's local Gherkin to its remote test. The board's row passes its
   * {scenario, key}; a palette invocation has neither and is pointed at the row. Nothing is written
   * before a fresh read of the remote text agrees with the synced baseline (`runPushGherkin`), and one
   * modal names the test before that write.
   *
   * Serialized like the bulk create: the palette entry and every row button are doors onto the same
   * remote writes, so an invocation while one is running joins it instead of starting a second.
   */
  public pushScenarioText(scenario?: string, key?: string): Promise<void> {
    if (this.pushInFlight) {
      return this.pushInFlight;
    }
    this.pushInFlight = this.pushRow(scenario, key).finally(() => {
      this.pushInFlight = undefined;
    });
    return this.pushInFlight;
  }

  private async pushRow(dropId: string | undefined, key: string | undefined): Promise<void> {
    if (dropId === undefined || key === undefined) {
      vscode.window.showInformationMessage(NO_ROW);
      return;
    }
    const adapter = this.deps.adapter();
    const remoteSearch = adapter?.remoteSearch;
    // Bound here so an adapter implementing the seam as a class method keeps its receiver.
    const pushGherkin = adapter?.testAuthoring?.pushGherkin?.bind(adapter.testAuthoring);
    if (!adapter || !pushGherkin || !remoteSearch || !(await this.deps.credentialsPresent())) {
      vscode.window.showInformationMessage(NOT_CONNECTED_FOR_PUSH);
      return;
    }
    const link = resolveBoardLink(this.deps.snapshot(), dropId, key);
    if (!link) {
      vscode.window.showWarningMessage(STALE_ROW);
      return;
    }
    // An Examples-block link names a table, not a scenario: there is no text of its own to send, and
    // sending the whole outline would overwrite a test that only covers one block.
    if (link.scenario.kind === "examplesBlock") {
      vscode.window.showInformationMessage(EXAMPLE_ROW);
      return;
    }
    try {
      const local = await this.localGherkin(link.scenario);
      if (local === undefined) {
        this.logger.warn("The scenario a push named no longer opens at its recorded line", {
          scenario: link.scenario.name,
          key,
        });
        vscode.window.showWarningMessage(STALE_ROW);
        return;
      }
      if (!(await this.confirmPush(key, adapter.label))) {
        return;
      }
      const binding = adapter.automationBinding;
      const outcome = await runPushGherkin(link.meta ?? { key }, local, {
        readRemote: (target) => this.readRemote(remoteSearch, adapter.keyGrammar, target),
        pushGherkin,
        refresh: (target) => remoteSearch.mergeKeys([target]),
        ...(binding ? { classifyBinding: (meta: TestCaseMetadata) => binding.classify(meta) } : {}),
      });
      this.reportPush(outcome, adapter.label);
    } catch (error) {
      this.logger.error("Pushing scenario text failed", { key, error: errMsg(error) });
      vscode.window.showErrorMessage(`Could not push this scenario's text to ${key}: ${errMsg(error)}`);
    }
  }

  // The scenario's verbatim source, read fresh from disk, and refused when the recorded line no longer
  // opens that scenario: the snapshot can predate an edit, and text sliced from a neighbouring scenario
  // would overwrite the remote test with someone else's steps.
  private async localGherkin(ref: ScenarioRef): Promise<string | undefined> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(ref.filePath));
    const lines = doc.getText().split("\n");
    return opensScenario(lines[ref.line - 1], ref.name) ? scenarioGherkinSlice(lines, ref.line) : undefined;
  }

  // The fresh single-key read behind every push decision: the adapter's own key lookup, unmerged, so a
  // blocked push leaves the stored baseline exactly as the last sync left it.
  private async readRemote(
    remoteSearch: RemoteSearchCapability,
    grammar: KeyGrammar,
    key: string
  ): Promise<TestCaseMetadata | undefined> {
    const canonical = grammar.canonicalizeKey(key);
    const result = await remoteSearch.search(key);
    return result.tests.find((test) => grammar.canonicalizeKey(test.key) === canonical);
  }

  private async confirmPush(key: string, providerLabel: string): Promise<boolean> {
    const site = this.deps.siteUrl();
    const target = site !== "" ? `${key} on ${site}` : key;
    const choice = await vscode.window.showWarningMessage(
      `Replace the text of ${providerLabel} test ${target} with this scenario's Gherkin?`,
      { modal: true },
      "Push text"
    );
    return choice === "Push text";
  }

  // A toast carries one line, so every outcome except the two clean ones (a push that landed and
  // refreshed, and a no-op) writes its own line to the log. Each blocked outcome names what actually
  // stopped the write, and only the one a sync can fix asks for one; a landed write is never reported as
  // a failure, even when the follow-up refresh could not run.
  private reportPush(outcome: PushGherkinOutcome, providerLabel: string): void {
    const clean = outcome.kind === "unchanged" || (outcome.kind === "pushed" && outcome.refreshError === undefined);
    if (!clean) {
      this.logger.warn("Pushing scenario text did not complete cleanly", {
        key: outcome.key,
        outcome: outcome.kind,
        ...("reason" in outcome ? { reason: outcome.reason } : {}),
        ...("refreshError" in outcome && outcome.refreshError !== undefined
          ? { refreshError: outcome.refreshError }
          : {}),
      });
    }
    if (outcome.kind === "pushed") {
      const message = `Pushed this scenario's text to ${outcome.key}.`;
      if (outcome.refreshError === undefined) {
        vscode.window.showInformationMessage(message);
      } else {
        vscode.window.showWarningMessage(
          `${message} The local baseline could not refresh, so sync to clear the drift badge.`
        );
      }
      return;
    }
    if (outcome.kind === "unchanged") {
      vscode.window.showInformationMessage(`${outcome.key} already matches this scenario's text.`);
      return;
    }
    if (outcome.kind === "unverified") {
      vscode.window.showErrorMessage(
        `The text was sent to ${outcome.key}, but ${providerLabel} did not read it back unchanged. Check the test before relying on it.`
      );
      return;
    }
    vscode.window.showWarningMessage(this.blockedMessage(outcome, providerLabel));
  }

  private blockedMessage(
    outcome: Extract<PushGherkinOutcome, { kind: "drift" | "no-baseline" | "no-remote-test" | "no-issue-id" | "wrong-test-type" }>,
    providerLabel: string
  ): string {
    if (outcome.kind === "drift") {
      return `Nothing was pushed: ${outcome.key} changed in ${providerLabel} since the last sync. ${RESYNC}`;
    }
    if (outcome.kind === "no-baseline") {
      return `Nothing was pushed: there is no synced copy of ${outcome.key} to compare against. ${RESYNC}`;
    }
    if (outcome.kind === "no-remote-test") {
      return `Nothing was pushed: ${providerLabel} has no test ${outcome.key} to write to.`;
    }
    if (outcome.kind === "no-issue-id") {
      return `Nothing was pushed: ${providerLabel} returned no issue id for ${outcome.key}, which is the only handle the write takes.`;
    }
    const testType = outcome.testType !== undefined ? `a ${outcome.testType} test` : "not a Gherkin test";
    return `Nothing was pushed: ${outcome.key} is ${testType} in ${providerLabel}, and only Gherkin tests can hold scenario text.`;
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
  // inserts shift them, and so can an edit from outside. The same predicate the push path uses decides
  // it: the captured position must still open this very scenario, or the tag is refused rather than
  // written onto whatever moved there. Two scenarios sharing an identical heading swapped by an outside
  // edit pass, which is fine: the tag still lands on a scenario whose heading is exactly the one the
  // created test was authored from.
  private async locationHolds(scenario: BulkCreateScenario): Promise<boolean> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(scenario.ref.filePath));
    return opensScenario(doc.getText().split("\n")[scenario.ref.line - 1], scenario.ref.name);
  }

  private async confirm(project: string, count: number, providerLabel: string): Promise<boolean> {
    const target = projectTarget(this.deps.siteUrl(), project);
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
