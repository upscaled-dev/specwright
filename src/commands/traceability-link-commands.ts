import * as vscode from "vscode";
import { ExtensionConfig } from "../core/extension-config";
import { scenarioGherkinSlice } from "../parsers/gherkin-slice";
import {
  BoardDropResolution,
  resolveBoardDrop,
  resolveBoardUnlink,
} from "../traceability/board-data";
import { BoardPanel } from "../traceability/board-panel";
import { KeyGrammar, NewTestSpec, TraceabilityAdapter } from "../traceability/contracts";
import { LinkedRow, runLinkPickerFlow } from "../traceability/link-picker-flow";
import {
  authorScenarioTest,
  AuthorScenarioTestUi,
  buildTestTag,
  linkScenarioPicks,
} from "../traceability/link-scenario";
import {
  linkedTestsForScenario,
  ScenarioRef,
  TraceabilitySnapshot,
} from "../traceability/traceability-model";
import {
  applyTagInsert as insertTag,
  applyTagRemove as removeTag,
  TagWrite,
} from "../traceability/tag-edit";
import { Logger } from "../utils/logger";
import { errMsg } from "../utils/text";

const REJECTED_WRITE = "the feature file edit was not applied";

// Carries its own toast text out of the create flow. The remote test exists, so the generic create
// failure wording would invite a duplicate-creating retry.
class TagWriteRejected extends Error {}

export interface TraceabilityLinkCommandDeps {
  readonly config: ExtensionConfig;
  readonly fallbackAdapter: () => TraceabilityAdapter;
  readonly activeAdapter: () => TraceabilityAdapter | undefined;
  readonly snapshot: () => TraceabilitySnapshot | undefined;
  readonly board: () => BoardPanel;
  readonly siteUrl: () => string;
  readonly merge: (adapter: TraceabilityAdapter | undefined, key: string) => void;
}

function issueKeyFromArg(arg: unknown): string | undefined {
  if (typeof arg === "string") {return arg;}
  const key = (arg as { testKey?: unknown } | undefined)?.testKey;
  return typeof key === "string" ? key : undefined;
}

// The traceability tree passes its untraced or mapped node; a palette invocation has none.
export function scenarioRefFromArg(arg: unknown): ScenarioRef | undefined {
  const node = arg as
    | { kind?: string; item?: { scenario?: ScenarioRef }; link?: { scenario?: ScenarioRef } }
    | undefined;
  if (node?.kind === "untraced") {return node.item?.scenario;}
  if (node?.kind === "link") {return node.link?.scenario;}
  return undefined;
}

export class TraceabilityLinkCommands {
  constructor(
    private readonly logger: Logger,
    private readonly deps: TraceabilityLinkCommandDeps
  ) {}

  public async openIssueInTracker(...args: unknown[]): Promise<void> {
    const key = issueKeyFromArg(args[0]);
    if (!key) {
      vscode.window.showErrorMessage("Open in tracker: no issue key on this item.");
      return;
    }
    await this.browseIssue(this.deps.fallbackAdapter(), key);
  }

  public async browseIssue(adapter: TraceabilityAdapter, key: string): Promise<void> {
    const url = adapter.browseUrl({ key });
    if (!url) {
      vscode.window.showWarningMessage(
        "Set playwrightBddRunner.xray.siteUrl to open issues in the browser."
      );
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  public async copyIssueKey(...args: unknown[]): Promise<void> {
    const key = issueKeyFromArg(args[0]);
    if (!key) {
      vscode.window.showErrorMessage("Copy issue key: no issue key on this item.");
      return;
    }
    await vscode.env.clipboard.writeText(key);
    vscode.window.showInformationMessage(`Copied ${key}`);
  }

  public async linkScenario(...args: unknown[]): Promise<void> {
    const scenario = scenarioRefFromArg(args[0]);
    if (!scenario) {
      vscode.window.showInformationMessage(
        "Link Scenario: run this from a scenario row in the Traceability view."
      );
      return;
    }
    await this.linkScenarioForRef(scenario);
  }

  // Shared by the context-menu command and the preflight flow's repair outcome.
  public async linkScenarioForRef(scenario: ScenarioRef): Promise<void> {
    const adapter = this.deps.activeAdapter() ?? this.deps.fallbackAdapter();
    const metadata = adapter.metadata;
    if (!metadata) {
      vscode.window.showInformationMessage(
        "Connect to your test tracker and run Sync before linking scenarios."
      );
      return;
    }
    const picks = linkScenarioPicks(metadata.snapshot());
    if (picks.length === 0 && !adapter.remoteSearch) {
      vscode.window.showInformationMessage("No synced tests to link yet. Run Sync first.");
      return;
    }

    const snapshot = this.deps.snapshot();
    const linkedTests: LinkedRow[] = linkedTestsForScenario(
      snapshot?.links ?? [],
      scenario
    ).map((link) => ({
      key: link.testKey,
      ...(link.meta?.summary !== undefined ? { summary: link.meta.summary } : {}),
      ...(link.remoteMissing ? { remoteMissing: true } : {}),
    }));
    const ui = this.deps.board().link.begin({
      title: `Link scenario to ${adapter.label} test`,
      searchPlaceholder: `Search ${adapter.label} tests`,
    });
    await runLinkPickerFlow({
      ui,
      linkedTests,
      orphanSuggestions: (snapshot?.orphans ?? []).map((orphan) => ({
        key: orphan.testKey,
        summary: orphan.meta.summary,
      })),
      localCandidates: picks,
      syncedKeys: new Set(picks.map((pick) => pick.key)),
      ...(adapter.testAuthoring
        ? { createLabel: `Create new ${adapter.label} test from this scenario…` }
        : {}),
      ...(adapter.remoteSearch ? { remoteSearch: adapter.remoteSearch } : {}),
      linkExisting: (key, synced) => this.linkExisting(scenario, key, synced, adapter),
      createNew: () => this.createTestFromScenario(adapter, scenario),
      openLinked: (key) => {
        this.browseIssue(adapter, key).catch((error) => {
          this.logger.warn("Opening the linked issue failed", { error: errMsg(error) });
        });
      },
      unlink: async (key) => {
        if ((await this.applyTagRemove(scenario, key, adapter.keyGrammar)) === "rejected") {
          throw new Error(REJECTED_WRITE);
        }
      },
      logSearchError: (error) =>
        this.logger.warn("Xray remote search failed", { error: errMsg(error) }),
      logUnlinkError: (error) => {
        this.logger.warn("Unlinking the scenario's test tag failed", { error: errMsg(error) });
        vscode.window.showErrorMessage(`Could not unlink the test tag: ${errMsg(error)}`);
      },
    });
  }

  private async linkExisting(
    scenario: ScenarioRef,
    key: string,
    synced: boolean,
    adapter: TraceabilityAdapter
  ): Promise<void> {
    const outcome = await this.applyTagInsert(scenario, key, adapter.keyGrammar);
    if (outcome === "unchanged") {
      vscode.window.showInformationMessage(`Scenario already linked to ${key}.`);
      return;
    }
    if (outcome === "rejected") {
      vscode.window.showErrorMessage(`Could not link ${key}: ${REJECTED_WRITE}.`);
      return;
    }
    if (!synced && adapter.remoteSearch) {
      adapter.remoteSearch.mergeKeys([key]).catch((error) => {
        this.logger.warn("Xray metadata merge for a newly linked test failed", {
          error: errMsg(error),
        });
      });
    }
  }

  // These delegates are deliberate spy seams proving that every caller shares tag-edit.
  private applyTagInsert(
    scenario: ScenarioRef,
    key: string,
    grammar: KeyGrammar
  ): Promise<TagWrite<"inserted">> {
    return insertTag(scenario, key, grammar);
  }

  private applyTagRemove(
    scenario: ScenarioRef,
    key: string,
    grammar: KeyGrammar
  ): Promise<TagWrite<"removed">> {
    return removeTag(scenario, key, grammar);
  }

  private async createTestFromScenario(
    adapter: TraceabilityAdapter,
    scenario: ScenarioRef
  ): Promise<void> {
    const authoring = adapter.testAuthoring;
    if (!authoring) {return;}
    const project = await this.resolveProjectForCreate();
    if (project === undefined) {return;}

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(scenario.filePath));
    const spec: NewTestSpec = {
      project,
      summary: scenario.name,
      gherkin: scenarioGherkinSlice(doc.getText().split("\n"), scenario.line),
    };
    const ui: AuthorScenarioTestUi = {
      confirm: () =>
        this.confirmCreateTest(project, this.deps.siteUrl(), scenario.name, adapter.label),
      info: (message) => {
        vscode.window.showInformationMessage(message);
      },
      error: (message) => {
        vscode.window.showErrorMessage(message);
      },
    };
    const merge = (key: string): void => this.deps.merge(adapter, key);
    try {
      await authorScenarioTest(spec, adapter.label, ui, {
        createTest: (input, signal) => authoring.createTest(input, signal),
        insertTag: async (key) => {
          if ((await this.applyTagInsert(scenario, key, adapter.keyGrammar)) === "rejected") {
            merge(key);
            throw new TagWriteRejected(
              `${key} was created, but ${REJECTED_WRITE}. Add ${buildTestTag(adapter.keyGrammar, key)} to the scenario by hand, or link it to ${key} from the picker.`
            );
          }
        },
        merge,
      });
    } catch (error) {
      this.logger.error("Create test from scenario failed", { error: errMsg(error) });
      vscode.window.showErrorMessage(
        error instanceof TagWriteRejected
          ? error.message
          : `Could not create the ${adapter.label} test: ${errMsg(error)}`
      );
    }
  }

  public mergeCreatedKey(key: string): void {
    this.deps.merge(this.deps.activeAdapter(), key);
  }

  private async resolveProjectForCreate(): Promise<string | undefined> {
    const configured = this.deps.config.xrayDefaultProjectKey.trim().toUpperCase();
    if (configured !== "") {return configured;}
    const input = await vscode.window.showInputBox({
      prompt: "Project key for the new test",
      placeHolder: "e.g. CALC",
      validateInput: (value) => (value.trim() === "" ? "Enter a project key." : undefined),
    });
    return input === undefined ? undefined : input.trim().toUpperCase();
  }

  private async confirmCreateTest(
    project: string,
    site: string,
    scenarioName: string,
    providerLabel: string
  ): Promise<boolean> {
    const target = site !== "" ? `project ${project} on ${site}` : `project ${project}`;
    const choice = await vscode.window.showWarningMessage(
      `Create a new ${providerLabel} test in ${target} from "${scenarioName}"?`,
      { modal: true },
      "Create test"
    );
    return choice === "Create test";
  }

  public async applyBoardDrop(dropId: string, key: string): Promise<void> {
    const adapter = this.deps.activeAdapter();
    if (!adapter) {return;}
    await this.applyBoardMutation(
      resolveBoardDrop(this.deps.snapshot(), dropId, key),
      adapter.keyGrammar,
      (ref, resolvedKey, grammar) => this.applyTagInsert(ref, resolvedKey, grammar),
      {
        stale: "That link is out of date because the board changed. Try the drag again.",
        failLog: "Board drag-to-link write failed",
        failToast: (resolvedKey, error) => `Could not link ${resolvedKey}: ${error}`,
      }
    );
  }

  public async applyBoardUnlink(dropId: string, key: string): Promise<void> {
    const adapter = this.deps.activeAdapter();
    if (!adapter) {return;}
    await this.applyBoardMutation(
      resolveBoardUnlink(this.deps.snapshot(), dropId, key),
      adapter.keyGrammar,
      (ref, resolvedKey, grammar) => this.applyTagRemove(ref, resolvedKey, grammar),
      {
        stale: "That link is out of date because the board changed. Try again.",
        failLog: "Board unlink write failed",
        failToast: (resolvedKey, error) => `Could not unlink ${resolvedKey}: ${error}`,
      }
    );
  }

  private async applyBoardMutation(
    resolved: BoardDropResolution | undefined,
    grammar: KeyGrammar,
    apply: (
      ref: ScenarioRef,
      key: string,
      grammar: KeyGrammar
    ) => Promise<TagWrite<"inserted" | "removed">>,
    messages: {
      stale: string;
      failLog: string;
      failToast: (key: string, error: string) => string;
    }
  ): Promise<void> {
    if (!resolved) {
      vscode.window.showWarningMessage(messages.stale);
      return;
    }
    try {
      if ((await apply(resolved.ref, resolved.key, grammar)) === "rejected") {
        throw new Error(REJECTED_WRITE);
      }
    } catch (error) {
      this.logger.error(messages.failLog, { error: errMsg(error) });
      vscode.window.showErrorMessage(messages.failToast(resolved.key, errMsg(error)));
    }
  }
}
