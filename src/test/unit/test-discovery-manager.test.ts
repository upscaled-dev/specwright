import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ExtensionConfig } from "../../core/extension-config";
import { TestDiscoveryManager } from "../../core/test-discovery-manager";
import { Logger } from "../../utils/logger";

describe("TestDiscoveryManager", () => {
  it("evicts old patterns and expires cached files before rediscovery", async () => {
    const folders = vscode.workspace.workspaceFolders;
    const logger = Logger.create();
    const debug = vi.spyOn(logger, "debug");
    const find = vi.spyOn(vscode.workspace, "findFiles").mockResolvedValue([vscode.Uri.file("/workspace/features/checkout.feature")]);
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: vscode.Uri.file("/workspace") }];
    vi.useFakeTimers();
    try {
      const manager = TestDiscoveryManager.create(logger, ExtensionConfig.create());
      for (let index = 0; index <= 100; index += 1) {
        vi.setSystemTime(index);
        await manager.discoverTestFiles({ pattern: `features/checkout-${index}.feature` });
      }
      await manager.discoverTestFiles({ pattern: "features/checkout-1.feature" });
      expect(find).toHaveBeenCalledTimes(101);
      await manager.discoverTestFiles({ pattern: "features/checkout-0.feature" });
      expect(find).toHaveBeenCalledTimes(102);
      vi.setSystemTime(300_102);
      await expect(manager.discoverTestFiles({ pattern: "features/checkout-100.feature" }))
        .resolves.toEqual(["/workspace/features/checkout.feature"]);
      expect(find).toHaveBeenCalledTimes(103);
      expect(debug).toHaveBeenCalledWith("Cache cleanup completed", expect.objectContaining({ deletedEntries: 99, remainingEntries: 1 }));
    } finally {
      vi.useRealTimers();
      (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = folders;
      find.mockRestore();
      debug.mockRestore();
    }
  });
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
