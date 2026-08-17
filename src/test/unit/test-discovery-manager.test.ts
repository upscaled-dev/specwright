import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ExtensionConfig } from "../../core/extension-config";
import { TestDiscoveryManager } from "../../core/test-discovery-manager";
import { Logger } from "../../utils/logger";

describe("TestDiscoveryManager", () => {
  it("records discovery duration as structured logger data", async () => {
    const logger = Logger.create();
    const info = vi.spyOn(logger, "info");
    vi.spyOn(vscode.workspace, "findFiles").mockResolvedValue([]);
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file("/workspace") },
    ];
    const manager = TestDiscoveryManager.create(logger, ExtensionConfig.create());

    try {
      await manager.discoverTestFiles();

      expect(info).toHaveBeenCalledWith(
        "Test discovery completed",
        expect.objectContaining({ durationMs: expect.any(Number) })
      );
    } finally {
      (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
    }
  });
});
