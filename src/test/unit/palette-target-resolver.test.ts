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

  // An outline header carries no line: the declaration line has no generated spec line, so the runner
  // greps the outline title and runs every row.
  it("returns a line-less outline target for its header and body", async () => {
    activeFeature(outline, 2);
    await expect(resolvePaletteScenario(makeContext())).resolves.toEqual({
      filePath: "/ws/a.feature", scenarioName: "Divide", outlineName: "Divide",
    });

    activeFeature(outline, 3);
    await expect(resolvePaletteScenario(makeContext())).resolves.toEqual({
      filePath: "/ws/a.feature", scenarioName: "Divide", outlineName: "Divide",
    });
  });

  it("returns the exact populated Examples row", async () => {
    activeFeature(outline, 7);

    await expect(resolvePaletteScenario(makeContext())).resolves.toEqual({
      filePath: "/ws/a.feature", lineNumber: 8, scenarioName: "1: Divide - n: 1", outlineName: "Divide",
    });
  });

  it("returns the outline itself when it has no Examples rows", async () => {
    activeFeature(["Feature: Palette", "Scenario Outline: Empty", "  Given <n>"].join("\n"), 1);

    await expect(resolvePaletteScenario(makeContext())).resolves.toEqual({
      filePath: "/ws/a.feature", scenarioName: "Empty", outlineName: "Empty",
    });
  });

  it("includes leading tags in a regular scenario scope", async () => {
    activeFeature(["Feature: Palette", "", "@fast", "Scenario: Tagged", "  Given a step"].join("\n"), 2);

    await expect(resolvePaletteScenario(makeContext())).resolves.toEqual({
      filePath: "/ws/a.feature", lineNumber: 4, scenarioName: "Tagged",
    });
  });

  it("resolves the scenario at the cursor in a CRLF document", async () => {
    activeFeature([
      "Feature: Palette",
      "",
      "@fast",
      "Scenario: Tagged",
      "  Given a step",
      "",
      "Scenario: Next",
      "  Given another step",
    ].join("\r\n"), 4);

    await expect(resolvePaletteScenario(makeContext())).resolves.toEqual({
      filePath: "/ws/a.feature", lineNumber: 4, scenarioName: "Tagged",
    });
  });

  it("sends a cursor inside a Background block to the scenario picker", async () => {
    activeFeature([
      "Feature: Palette",
      "Background:",
      "  Given a shared step",
      "Scenario: After",
      "  Given a step",
    ].join("\n"), 2);
    const quickPick = vi.spyOn(vscode.window, "showQuickPick").mockImplementation((items) =>
      Promise.resolve((items as Array<unknown>)[0] as never)
    );

    await expect(resolvePaletteScenario(makeContext())).resolves.toEqual({
      filePath: "/ws/a.feature", lineNumber: 4, scenarioName: "After",
    });
    expect(quickPick).toHaveBeenCalledOnce();
  });

  it("ignores a non-feature active editor and picks a discovered feature", async () => {
    window.activeTextEditor = {
      document: fakeDoc("const x = 1;\n", "/ws/a.steps.ts"),
      selection: { active: { line: 0 } },
    };
    const filePath = writeTempFeature("Feature: Palette\n\nScenario: picked\n  Given a step\n");
    const context = makeContext({
      discoveryManager: { discoverTestFiles: vi.fn().mockResolvedValue([filePath]) } as never,
    });
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation((items) =>
      Promise.resolve((items as Array<unknown>)[0] as never)
    );

    try {
      await expect(resolvePaletteScenario(context)).resolves.toEqual({
        filePath, lineNumber: 3, scenarioName: "picked",
      });
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it("tells the user when discovery found no feature files", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const quickPick = vi.spyOn(vscode.window, "showQuickPick");
    const context = makeContext({
      discoveryManager: { discoverTestFiles: vi.fn().mockResolvedValue([]) } as never,
    });

    await expect(resolvePaletteFeature(context)).resolves.toBeUndefined();

    expect(String(info.mock.calls[0]?.[0])).toBe("No feature files were discovered.");
    expect(quickPick).not.toHaveBeenCalled();
  });

  it("saves an unsaved feature buffer before resolving a target from it", async () => {
    const save = vi.fn().mockResolvedValue(true);
    const document = fakeDoc("Feature: Palette\nScenario: Edited\n  Given a step\n");
    window.activeTextEditor = {
      document: { ...document, isDirty: true, save },
      selection: { active: { line: 2 } },
    };

    await expect(resolvePaletteScenario(makeContext())).resolves.toEqual({
      filePath: "/ws/a.feature", lineNumber: 2, scenarioName: "Edited",
    });
    expect(save).toHaveBeenCalledOnce();
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

  // A doc string that never closes must not let the scenario above it claim the lines below. The
  // parser reads everything after the open fence as string content, so the scenario below is not
  // runnable; the cursor there must reach the picker rather than silently run the one above.
  it("stops an unterminated doc string from claiming the lines below it", async () => {
    const feature = [
      "Feature: Palette",
      "Scenario: Broken",
      "  Then the text is:",
      "    \"\"\"",
      "    unterminated",
      "",
      "Scenario: Next",
      "  Given a step",
    ].join("\n");
    const quickPick = vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);

    activeFeature(feature, 4);
    await expect(resolvePaletteScenario(makeContext())).resolves.toEqual({
      filePath: "/ws/a.feature", lineNumber: 2, scenarioName: "Broken",
    });
    expect(quickPick).not.toHaveBeenCalled();

    activeFeature(feature, 7);
    await expect(resolvePaletteScenario(makeContext())).resolves.toBeUndefined();
    expect(quickPick).toHaveBeenCalledOnce();
  });

  it("stops the run when the active buffer refuses to save", async () => {
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    const document = fakeDoc("Feature: Palette\nScenario: Edited\n  Given a step\n");
    window.activeTextEditor = {
      document: { ...document, isDirty: true, save: vi.fn().mockResolvedValue(false) },
      selection: { active: { line: 2 } },
    };

    await expect(resolvePaletteScenario(makeContext())).resolves.toBeUndefined();

    expect(String(warning.mock.calls[0]?.[0])).toContain("could not be saved");
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
    const filePath = writeTempFeature("Feature: Palette\n\nScenario: picked\n  Given a step\n");
    const context = makeContext({
      discoveryManager: { discoverTestFiles: vi.fn().mockResolvedValue([filePath]) } as never,
    });
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    try {
      await expect(resolvePaletteFeature(context)).resolves.toBeUndefined();

      vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(undefined);
      await expect(promptPaletteTags()).resolves.toBeUndefined();
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it("surfaces gateway diagnostics for unreadable and malformed discovered feature files", async () => {
    const missing = "/ws/missing.feature";
    const missingContext = makeContext({
      discoveryManager: { discoverTestFiles: vi.fn().mockResolvedValue([missing]) } as never,
    });
    const quickPick = vi.spyOn(vscode.window, "showQuickPick").mockImplementation((items) =>
      Promise.resolve((items as Array<unknown>)[0] as never)
    );
    await expect(resolvePaletteFeature(missingContext)).rejects.toMatchObject({
      name: "ExecutionDiagnosticError",
      diagnostic: {
        code: "execution.discovery.unreadable-source",
        severity: "warning",
        message: `Could not parse ${missing}.`,
        identity: { engine: "legacy-direct", schemaProfile: "legacy-v1" },
      },
    });

    const malformed = writeTempFeature("not a feature");
    const malformedContext = makeContext({
      discoveryManager: { discoverTestFiles: vi.fn().mockResolvedValue([malformed]) } as never,
    });
    try {
      await expect(resolvePaletteScenario(malformedContext)).rejects.toMatchObject({
        name: "ExecutionDiagnosticError",
        diagnostic: expect.objectContaining({
          code: "execution.discovery.unreadable-source",
          message: `Could not parse ${malformed}.`,
        }),
      });
      expect(quickPick).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(path.dirname(malformed), { recursive: true, force: true });
    }
  });

  it("trims a palette tag expression and corrects blank input in the box", async () => {
    const input = vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("  @smoke  ");
    await expect(promptPaletteTags()).resolves.toBe("@smoke");

    const validate = input.mock.calls[0]?.[0]?.validateInput as (value: string) => string | undefined;
    expect(validate("   ")).toBe("A tag expression is required.");
    expect(validate("@smoke")).toBeUndefined();
  });
});
