import { describe, it, expect, afterEach } from "vitest";
import * as vscode from "vscode";
import {
  buildExcludeGlob,
  excludedDirFragments,
  isUnderExcludedDir,
  normalizeDirFragment,
  workspaceExcludeFragments,
} from "../../utils/discovery-excludes";

const originalGetConfiguration = vscode.workspace.getConfiguration;
const originalFolders = vscode.workspace.workspaceFolders;

afterEach(() => {
  (vscode.workspace as { getConfiguration: unknown }).getConfiguration =
    originalGetConfiguration;
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = originalFolders;
});

function mockFeaturesGenDir(byResource: Record<string, string>, fallback = ".features-gen"): void {
  (vscode.workspace as { getConfiguration: unknown }).getConfiguration = (
    _ns: string,
    resource?: vscode.Uri
  ) => ({
    get: <T>(key: string, def: T): T => {
      if (key !== "featuresGenDir") {return def;}
      const value = resource ? byResource[resource.fsPath] : undefined;
      return (value ?? fallback) as unknown as T;
    },
  });
}

describe("discovery-excludes", () => {
  describe("normalizeDirFragment", () => {
    it("normalizes backslashes and strips leading ./ and trailing slashes", () => {
      expect(normalizeDirFragment("build\\.bdd-gen\\")).toBe("build/.bdd-gen");
      expect(normalizeDirFragment("./.features-gen/")).toBe(".features-gen");
      expect(normalizeDirFragment(".features-gen")).toBe(".features-gen");
    });
  });

  describe("excludedDirFragments", () => {
    it("includes the built-in dirs plus the configured featuresGenDir", () => {
      mockFeaturesGenDir({});
      const fragments = excludedDirFragments(undefined);
      expect(fragments).toContain("node_modules");
      expect(fragments).toContain("playwright-report");
      expect(fragments).toContain("test-results");
      expect(fragments).toContain(".features-gen");
    });

    it("does not duplicate a featuresGenDir that matches a built-in", () => {
      mockFeaturesGenDir({}, "test-results");
      const fragments = excludedDirFragments(undefined);
      expect(fragments.filter((f) => f === "test-results")).toHaveLength(1);
    });
  });

  describe("workspaceExcludeFragments", () => {
    it("unions per-folder featuresGenDir overrides across all folders", () => {
      const app = { name: "app", index: 0, uri: vscode.Uri.file("/repo/app") };
      const lib = { name: "lib", index: 1, uri: vscode.Uri.file("/repo/lib") };
      (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [app, lib];
      mockFeaturesGenDir({
        [app.uri.fsPath]: ".features-gen",
        [lib.uri.fsPath]: "build/.bdd-gen",
      });

      const fragments = workspaceExcludeFragments();
      expect(fragments).toContain(".features-gen");
      expect(fragments).toContain("build/.bdd-gen");
      expect(fragments).toContain("node_modules");
    });
  });

  describe("buildExcludeGlob", () => {
    it("builds a brace glob from fragments and extra globs", () => {
      const glob = buildExcludeGlob(["node_modules", ".features-gen"], ["**/reports/**"]);
      expect(glob).toBe("{**/node_modules/**,**/.features-gen/**,**/reports/**}");
    });
  });

  describe("isUnderExcludedDir", () => {
    const fragments = ["node_modules", ".features-gen", "playwright-report"];

    it("matches posix paths under an excluded dir", () => {
      expect(isUnderExcludedDir("/ws/.features-gen/features/a.spec.js", fragments)).toBe(true);
      expect(isUnderExcludedDir("/ws/features/steps/a.steps.ts", fragments)).toBe(false);
    });

    it("matches Windows paths regardless of separator", () => {
      expect(isUnderExcludedDir("C:\\ws\\.features-gen\\features\\a.spec.js", fragments)).toBe(
        true
      );
      expect(isUnderExcludedDir("C:\\ws\\playwright-report\\data\\x.ts", fragments)).toBe(true);
      expect(isUnderExcludedDir("C:\\ws\\tests\\steps\\a.steps.ts", fragments)).toBe(false);
    });

    it("does not match a directory whose name merely contains a fragment", () => {
      expect(isUnderExcludedDir("/ws/my-node_modules-backup/a.ts", fragments)).toBe(false);
    });
  });
});
