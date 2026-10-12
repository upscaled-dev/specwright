import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandManager } from "../../commands/command-manager";
import { captureHandlers, makeContext } from "./helpers/command-manager-harness";
import { GenerateStepsCommand } from "../../commands/generate-steps";
import { ExtensionConfig } from "../../core/extension-config";
import { WorkspaceTrust } from "../../core/workspace-trust";
import { StepResolver } from "../../providers/step-resolver";
import { Logger } from "../../utils/logger";
import { applyWsEdit, type EditEntry } from "./helpers/workspace-edit";

let root: string;
let feature: string;
let destination: string;
let resolver: StepResolver;
let command: GenerateStepsCommand;
let save: ReturnType<typeof vi.fn>;
const source = "Feature: Checkout\n  Scenario: Pay\n    Given a basket\n    When I pay 12 dollars\n";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "specwright-generate-"));
  feature = path.join(root, "checkout.feature");
  destination = path.join(root, "checkout.steps.ts");
  fs.writeFileSync(feature, source);
  fs.writeFileSync(destination, "import { createBdd } from 'playwright-bdd';\nconst { Given, When } = createBdd();\nGiven('a basket', async () => {});\n");
  resolver = new StepResolver();
  vi.spyOn(resolver, "findStepFiles").mockImplementation(async () => fs.existsSync(destination) ? [destination] : []);
  command = new GenerateStepsCommand(resolver, ExtensionConfig.create(), Logger.create(), new WorkspaceTrust(() => true));
  vi.spyOn(vscode.workspace, "getWorkspaceFolder").mockReturnValue({ uri: vscode.Uri.file(root), name: "shop", index: 0 });
  vi.spyOn(vscode.workspace, "workspaceFolders", "get").mockReturnValue(undefined);
  vi.spyOn(vscode.workspace, "fs", "get").mockReturnValue({
    ...vscode.workspace.fs,
    createDirectory: async (uri) => { await fs.promises.mkdir(uri.fsPath, { recursive: true }); },
  });
  vi.spyOn(vscode.window, "activeTextEditor", "get").mockReturnValue(undefined);
  vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue({ label: "checkout.steps.ts", filePath: destination } as never);
  vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(undefined);
  vi.spyOn(vscode.window, "showTextDocument").mockResolvedValue({} as vscode.TextEditor);
  save = vi.fn(async () => true);
  vi.spyOn(vscode.workspace, "openTextDocument").mockImplementation(async (input) => {
    const uri = input as vscode.Uri;
    return {
      uri, getText: () => fs.readFileSync(uri.fsPath, "utf-8"),
      get lineCount() { return fs.readFileSync(uri.fsPath, "utf-8").split("\n").length; },
      lineAt: (line: number) => ({ range: { end: new vscode.Position(line, 0) } }), save,
    } as unknown as vscode.TextDocument;
  });
  vi.spyOn(vscode.workspace, "applyEdit").mockImplementation(async (edit) => {
    const entries = (edit as unknown as { __entries: (EditEntry & { uri: vscode.Uri })[] }).__entries;
    for (const entry of entries) {
      fs.writeFileSync(entry.uri.fsPath, applyWsEdit(fs.readFileSync(entry.uri.fsPath, "utf-8"), [entry]));
    }
    return true;
  });
});

afterEach(() => {
  resolver.dispose();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("generate step definitions workflow", () => {
  it("reuses the registered generator without duplicating saved definitions on a second invocation", async () => {
    vi.spyOn(vscode.workspace, "findFiles").mockResolvedValue([vscode.Uri.file(destination)]);
    let manager!: CommandManager;
    const handlers = captureHandlers(makeContext(), (value) => {manager = value;});
    const generate = handlers.get("playwrightBddRunner.generateStepDefinitions")!;
    try {
      await generate(feature);
      const generated = fs.readFileSync(destination, "utf8");
      expect(resolver.findUnmatchedSteps(source, resolver.parseStepFile(destination))).toEqual([]);
      await generate(feature);
      expect(fs.readFileSync(destination, "utf8")).toBe(generated);
      expect(save).toHaveBeenCalledOnce();
    } finally {manager.dispose();}
  });

  it("turns only unmatched parsed steps into saved definitions the resolver can find", async () => {
    await command.execute(feature);
    expect(save).toHaveBeenCalledOnce();
    expect(resolver.findUnmatchedSteps(source, resolver.parseStepFile(destination))).toEqual([]);
    expect(fs.readFileSync(destination, "utf-8").match(/Given\(/g)).toHaveLength(1);
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ uri: expect.objectContaining({ fsPath: destination }) }),
      expect.objectContaining({ selection: expect.any(vscode.Range) }),
    );
  });

  it("uses the active feature and reports when all steps are already defined", async () => {
    fs.appendFileSync(destination, "When('I pay {int} dollars', async () => {});\n");
    vi.spyOn(vscode.window, "activeTextEditor", "get").mockReturnValue({ document: { uri: vscode.Uri.file(feature) } } as vscode.TextEditor);
    const information = vi.spyOn(vscode.window, "showInformationMessage");
    await command.execute();
    expect(information).toHaveBeenCalledWith("All steps are already defined.");
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  });

  it("does nothing without a feature and explains an unsupported editor file", async () => {
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    await command.execute();
    await command.execute(vscode.Uri.file(destination));
    expect(warning).toHaveBeenCalledWith("Generate Step Definitions only works on .feature files.");
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it("does not edit when there is no unmatched step or no workspace", async () => {
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    await command.executeForSteps(vscode.Uri.file(feature), []);
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined);
    await command.execute(feature);
    expect(warning).toHaveBeenCalledWith("Generate Step Definitions requires an open workspace folder.");
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  });

  it.each([undefined, { label: "separator" }])("leaves files unchanged after dismissing the destination: %j", async (pick) => {
    const original = fs.readFileSync(destination, "utf-8");
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(pick as never);
    await command.execute(feature);
    expect(fs.readFileSync(destination, "utf-8")).toBe(original);
    expect(save).not.toHaveBeenCalled();
  });

  it("does not save or reveal a rejected edit", async () => {
    vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(false);
    await command.execute(feature);
    expect(save).not.toHaveBeenCalled();
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
  });

  it("warns and reveals generated definitions when saving fails", async () => {
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    save.mockRejectedValue(new Error("disk full"));
    await command.execute(feature);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Save manually"));
    expect(resolver.findUnmatchedSteps(source, resolver.parseStepFile(destination))).toEqual([]);
    expect(vscode.window.showTextDocument).toHaveBeenCalledOnce();
  });

  it("cancels creation before writing a file", async () => {
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ isCreateNew: true } as never);
    await command.execute(feature);
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(["relative", "absolute"])("creates a %s destination whose generated steps resolve the feature", async (kind) => {
    fs.unlinkSync(destination);
    destination = path.join(root, "steps", "new.steps.ts");
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined);
    vi.spyOn(vscode.workspace, "workspaceFolders", "get").mockReturnValue([
      { uri: vscode.Uri.file(root), name: "shop", index: 0 },
    ]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ isCreateNew: true } as never);
    vi.mocked(vscode.window.showInputBox).mockImplementation(async (options) => {
      expect(await options?.validateInput?.("../outside.ts")).toContain("workspace");
      return kind === "absolute" ? destination : path.relative(root, destination);
    });
    await command.execute(feature);
    expect(fs.readFileSync(destination, "utf-8")).toContain("createBdd");
    expect(resolver.findUnmatchedSteps(source, resolver.parseStepFile(destination))).toEqual([]);
    expect(save).toHaveBeenCalledOnce();
  });

  it("does not overwrite a destination created while the input dialog was open", async () => {
    const original = fs.readFileSync(destination, "utf-8");
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ isCreateNew: true } as never);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(destination);
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    await expect(command.execute(feature)).rejects.toThrow("already exists");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("already exists"));
    expect(fs.readFileSync(destination, "utf-8")).toBe(original);
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  });

  it("propagates a filesystem failure before applying generated definitions", async () => {
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ isCreateNew: true } as never);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(path.join(root, "new.steps.ts"));
    const failure = new Error("read-only filesystem");
    vi.spyOn(fs.promises, "writeFile").mockRejectedValue(failure);
    await expect(command.execute(feature)).rejects.toBe(failure);
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  });

  it("avoids duplicate stubs if the destination already defines the supplied unmatched step", async () => {
    const information = vi.spyOn(vscode.window, "showInformationMessage");
    await command.executeForSteps(vscode.Uri.file(feature), [{
      line: 2, keyword: "Given", effectiveKeyword: "Given", text: "a basket",
    }]);
    expect(information).toHaveBeenCalledWith("All steps are already defined.");
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  });
});
