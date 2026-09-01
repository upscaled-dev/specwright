import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { affectsBoard } from "../../traceability/board-panel";

// The board is rebuilt from settings, so it has to know which ones it renders: a rebuild per keystroke in
// an unrelated setting would thrash it.
describe("affectsBoard", () => {
  const event = (...changed: string[]): vscode.ConfigurationChangeEvent => ({
    affectsConfiguration: (key: string) => changed.includes(key),
  });

  it("claims the settings a board build reads: its project universe and its site", () => {
    expect(affectsBoard(event("playwrightBddRunner.xray.syncProjectKeys"))).toBe(true);
    expect(affectsBoard(event("playwrightBddRunner.xray.defaultProjectKey"))).toBe(true);
    expect(affectsBoard(event("playwrightBddRunner.xray.siteUrl"))).toBe(true);
  });

  // These are read when a publish runs, not when the board is built, so a rebuild would show nothing new.
  it("leaves the publish-time settings alone", () => {
    expect(affectsBoard(event("playwrightBddRunner.xray.executionIssueType"))).toBe(false);
    expect(affectsBoard(event("playwrightBddRunner.xray.reportGlob"))).toBe(false);
    expect(affectsBoard(event("playwrightBddRunner.xray.attachTo"))).toBe(false);
  });

  it("ignores config noise, including the rest of the extension's own namespace", () => {
    expect(affectsBoard(event())).toBe(false);
    expect(affectsBoard(event("editor.fontSize"))).toBe(false);
    expect(affectsBoard(event("playwrightBddRunner.playwrightCommand"))).toBe(false);
  });
});
