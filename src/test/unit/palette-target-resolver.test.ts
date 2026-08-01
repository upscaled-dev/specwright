import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { promptPaletteTags, resolvePaletteFeature, resolvePaletteScenario } from "../../commands/palette-target-resolver";
import { fakeDoc, makeContext, writeTempFeature } from "./helpers/command-manager-harness";

const window = vscode.window as unknown as { activeTextEditor: unknown };

function activeFeature(text: string, line: number): void {
  window.activeTextEditor = {
    document: fakeDoc(text),
    selection: { active: { line } },
  };
}

afterEach(() => {
  window.activeTextEditor = undefined;
  vi.restoreAllMocks();
});

describe("palette target resolver", () => {
  const outline = [
    "Feature: Palette",
    "",
    "Scenario Outline: Divide",
    "  Given <n>",
    "",
    "  Examples:",
    "    | n |",
    "    | 1 |",
    "    | 2 |",
  ].join("\n");

  it("returns an outline target for its header and body", async () => {
    activeFeature(outline, 2);
    await expect(resolvePaletteScenario(makeContext())).resolves.toEqual({
      filePath: "/ws/a.feature", lineNumber: 3, scenarioName: "Divide", outlineName: "Divide",
    });

    activeFeature(outline, 3);
    await expect(resolvePaletteScenario(makeContext())).resolves.toEqual({
      filePath: "/ws/a.feature", lineNumber: 3, scenarioName: "Divide", outlineName: "Divide",
    });
  });

  it("returns the exact populated Examples row", async () => {
    activeFeature(outline, 7);

    await expect(resolvePaletteScenario(makeContext())).resolves.toEqual({
      filePath: "/ws/a.feature", lineNumber: 8, scenarioName: "1: Divide - n: 1", outlineName: "Divide",
    });
  });

  it("includes leading tags in a regular scenario scope", async () => {
    activeFeature(["Feature: Palette", "", "@fast", "Scenario: Tagged", "  Given a step"].join("\n"), 2);

    await expect(resolvePaletteScenario(makeContext())).resolves.toEqual({
      filePath: "/ws/a.feature", lineNumber: 4, scenarioName: "Tagged",
    });
  });

  it("keeps Scenario-looking doc-string text inside its containing scenario", async () => {
    activeFeature([
      "Feature: Palette",
      "Scenario: Actual",
      "  Then the text is:",
      "    \"\"\"",
      "    Scenario: not a scenario",
      "    \"\"\"",
      "Scenario: Next",
    ].join("\n"), 4);

    await expect(resolvePaletteScenario(makeContext())).resolves.toEqual({
      filePath: "/ws/a.feature", lineNumber: 2, scenarioName: "Actual",
    });
  });

  it("uses the scenario picker at an adjacent scenario boundary and treats cancellation as no selection", async () => {
    activeFeature([
      "Feature: Palette",
      "Scenario: First",
      "  Given first",
      "",
      "Scenario: Second",
      "  Given second",
    ].join("\n"), 3);
    const quickPick = vi.spyOn(vscode.window, "showQuickPick").mockImplementation((items) =>
      Promise.resolve((items as Array<unknown>)[1] as never)
    );

    await expect(resolvePaletteScenario(makeContext())).resolves.toEqual({
      filePath: "/ws/a.feature", lineNumber: 5, scenarioName: "Second",
    });
    expect(quickPick).toHaveBeenCalledOnce();

    quickPick.mockResolvedValue(undefined);
    await expect(resolvePaletteScenario(makeContext())).resolves.toBeUndefined();
  });

  it("uses undefined only for feature and tag-picker cancellation", async () => {
    const context = makeContext({
      discoveryManager: { discoverTestFiles: vi.fn().mockResolvedValue(["/ws/a.feature"]) } as never,
    });
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    await expect(resolvePaletteFeature(context)).resolves.toBeUndefined();

    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(undefined);
    await expect(promptPaletteTags()).resolves.toBeUndefined();
  });

  it("rejects unreadable and malformed selected feature files", async () => {
    const missing = "/ws/missing.feature";
    const missingContext = makeContext({
      discoveryManager: { discoverTestFiles: vi.fn().mockResolvedValue([missing]) } as never,
    });
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation((items) =>
      Promise.resolve((items as Array<unknown>)[0] as never)
    );
    await expect(resolvePaletteFeature(missingContext)).rejects.toThrow(`Unable to read feature file: ${missing}`);

    const malformed = writeTempFeature("not a feature");
    const malformedContext = makeContext({
      discoveryManager: { discoverTestFiles: vi.fn().mockResolvedValue([malformed]) } as never,
    });
    try {
      await expect(resolvePaletteScenario(malformedContext)).rejects.toThrow(`Unable to parse feature file: ${malformed}`);
    } finally {
      fs.rmSync(path.dirname(malformed), { recursive: true, force: true });
    }
  });

  it("trims a palette tag expression and rejects empty input", async () => {
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("  @smoke  ");
    await expect(promptPaletteTags()).resolves.toBe("@smoke");

    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("   ");
    await expect(promptPaletteTags()).rejects.toThrow("Tags are required");
  });
});
