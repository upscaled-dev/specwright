import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { WorkspaceTrust } from "../../core/workspace-trust";
import { XrayCredentialStore } from "../../xray/xray-credential-store";
import { captureHandlers, makeContext } from "./helpers/command-manager-harness";

describe("workspace trust UI boundaries", () => {
  it("blocks a programmatic run command and offers the trust action once", async () => {
    const execute = vi.fn();
    const gateway = {
      running: false,
      execute,
    } as unknown as import("../../core/run-contracts").ExecutionGateway;
    const handlers = captureHandlers(makeContext({
      workspaceTrust: new WorkspaceTrust(() => false),
      executionGateway: gateway,
    }));
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Manage Workspace Trust" as never);
    const manage = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);

    await handlers.get("playwrightBddRunner.runAllTests")!();

    expect(execute).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce();
    expect(manage).toHaveBeenCalledWith("workbench.trust.manage");
  });

  it("reads no project secret while trust admission is unavailable", async () => {
    const secrets = {
      get: vi.fn(),
      store: vi.fn(),
      delete: vi.fn(),
      onDidChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    } as unknown as vscode.SecretStorage;
    const store = new XrayCredentialStore(secrets, new WorkspaceTrust(() => false));

    await expect(store.getCredentials("example.atlassian.net")).rejects.toMatchObject({
      code: "WORKSPACE_TRUST_REQUIRED",
    });
    expect((secrets as unknown as { get: ReturnType<typeof vi.fn> }).get).not.toHaveBeenCalled();
  });
});
