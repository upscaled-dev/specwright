import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ExtensionConfig } from "../../core/extension-config";
import { DetailBudget } from "../../core/execution-limits";
import type { RunProgressObserver } from "../../core/run-progress";

vi.mock("../../core/live-run-session", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../core/live-run-session")>();
  return { ...original, openLiveRunSession: vi.fn(() => undefined) };
});

import { openLiveRunSession } from "../../core/live-run-session";
import { TestExecutor, type ShellRunner } from "../../core/test-executor";
import { CommandBuilder } from "../../core/command-builder";
import { Logger } from "../../utils/logger";
import type { PlaywrightBddExtensionContext } from "../../types";

function makeConfig(): ExtensionConfig {
  const stub = {
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      if (key === "preRunCommand") {return "" as unknown as T;}
      if (key === "workingDirectory") {return "/tmp" as unknown as T;}
      if (key === "bddgenCommand") {return "" as unknown as T;}
      return defaultValue;
    },
    update: (): Promise<void> => Promise.resolve(),
  } as unknown as vscode.WorkspaceConfiguration;
  return ExtensionConfig.create(stub, false);
}

// The one run budget hops from the gateway's progress observer through the executor into the live
// session; a fresh budget minted on that seam would let live retention ignore the run's cap.
describe("live detail budget hop", () => {
  it("hands the run's budget through progress into the live session", async () => {
    const shell: ShellRunner = async () =>
      ({ success: true, output: "{}", error: "", returnCode: 0 });
    const config = makeConfig();
    const executor = TestExecutor.create(
      undefined,
      undefined,
      undefined,
      config,
      undefined,
      undefined,
      shell
    );
    executor.setContext({
      commandBuilder: CommandBuilder.create(config, Logger.create()),
      traceabilityAdapter: {},
    } as unknown as PlaywrightBddExtensionContext);
    const detailBudget = new DetailBudget();

    await executor.runScenarioWithOutput({
      filePath: "/tmp/x.feature",
      outlineName: "Divide",
      specLineTargets: [".features-gen/x.feature.spec.js:6"],
      progress: { detailBudget } as RunProgressObserver,
    });

    const opened = vi.mocked(openLiveRunSession);
    expect(opened).toHaveBeenCalledOnce();
    expect(opened.mock.calls[0]![0].detailBudget).toBe(detailBudget);
  });
});
