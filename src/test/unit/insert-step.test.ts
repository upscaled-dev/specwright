import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import {
  buildInsertStepItems,
  buildStepSnippet,
  quoteStringPlaceholders,
  runInsertStep,
  InsertStepSource,
} from "../../commands/insert-step";

interface MutableWindow {
  activeTextEditor: unknown;
  showQuickPick: (...args: unknown[]) => Promise<unknown>;
  showInformationMessage: (...args: unknown[]) => Promise<unknown>;
}

const win = vscode.window as unknown as MutableWindow;
const originalQuickPick = win.showQuickPick;
const originalInfo = win.showInformationMessage;

afterEach(() => {
  win.activeTextEditor = undefined;
  win.showQuickPick = originalQuickPick;
  win.showInformationMessage = originalInfo;
});

function featureEditor(): { editor: unknown; insertSnippet: ReturnType<typeof vi.fn> } {
  const insertSnippet = vi.fn().mockResolvedValue(true);
  return {
    editor: {
      document: { languageId: "gherkin", fileName: "/ws/features/a.feature" },
      insertSnippet,
    },
    insertSnippet,
  };
}

describe("quoteStringPlaceholders", () => {
  it("wraps a bare {string} placeholder in double quotes", () => {
    expect(quoteStringPlaceholders("I click ${1:string}$0")).toBe('I click "${1:string}"$0');
  });

  it("leaves a placeholder already surrounded by double quotes untouched", () => {
    expect(quoteStringPlaceholders('user "${1:string}"$0')).toBe('user "${1:string}"$0');
  });

  it("leaves a placeholder already surrounded by single quotes untouched", () => {
    expect(quoteStringPlaceholders("say '${1:string}'$0")).toBe("say '${1:string}'$0");
  });

  it("only wraps string placeholders, not other parameter types", () => {
    expect(quoteStringPlaceholders("${1:string} has ${2:int} items$0")).toBe(
      '"${1:string}" has ${2:int} items$0'
    );
  });
});

describe("buildStepSnippet", () => {
  it("quotes the tab-stop for a cucumber {string} parameter", () => {
    expect(buildStepSnippet("I click {string}", false)).toBe('I click "${1:string}"$0');
  });

  it("does not double-quote a regex-derived quoted string capture", () => {
    expect(buildStepSnippet('^user "([^"]*)"$', true)).toBe('user "${1:string}"$0');
  });

  it("passes an unconvertible regex through unchanged", () => {
    expect(buildStepSnippet("^foo|bar$", true)).toBe("^foo|bar$");
  });
});

describe("buildInsertStepItems", () => {
  it("builds sorted quick-pick items with keyword + source description and snippets", () => {
    const defs: InsertStepSource[] = [
      { pattern: "zeta {int}", isRegex: false, keyword: "When", filePath: "/ws/steps/z.steps.ts" },
      { pattern: "alpha {string}", isRegex: false, keyword: "Given", filePath: "/ws/steps/a.steps.ts" },
      { pattern: "middle", isRegex: false, filePath: "/ws/steps/m.steps.ts" },
    ];
    const items = buildInsertStepItems(defs, (fp) => fp.replace("/ws/", ""));

    expect(items.map((i) => i.label)).toEqual(["alpha {string}", "middle", "zeta {int}"]);
    expect(items[0]).toMatchObject({
      description: "Given · steps/a.steps.ts",
      snippet: 'alpha "${1:string}"$0',
    });
    expect(items[1]!.description).toBe("Step · steps/m.steps.ts");
    expect(items[2]!.snippet).toBe("zeta ${1:int}$0");
  });
});

describe("runInsertStep", () => {
  it("shows a clear message and inserts nothing when the active editor is not a .feature file", async () => {
    const insertSnippet = vi.fn();
    win.activeTextEditor = {
      document: { languageId: "typescript", fileName: "/ws/src/app.ts" },
      insertSnippet,
    };
    const info = vi.fn().mockResolvedValue(undefined);
    win.showInformationMessage = info;

    await runInsertStep(() => Promise.resolve([]));

    expect(info).toHaveBeenCalledOnce();
    expect(String(info.mock.calls[0]![0])).toContain(".feature");
    expect(insertSnippet).not.toHaveBeenCalled();
  });

  it("shows a clear message when there is no active editor at all", async () => {
    win.activeTextEditor = undefined;
    const info = vi.fn().mockResolvedValue(undefined);
    win.showInformationMessage = info;

    await runInsertStep(() => Promise.resolve([]));
    expect(info).toHaveBeenCalledOnce();
  });

  it("inserts the preselected definition's snippet without a quick pick", async () => {
    const { editor, insertSnippet } = featureEditor();
    win.activeTextEditor = editor;
    const quickPick = vi.fn();
    win.showQuickPick = quickPick;

    await runInsertStep(
      () => Promise.resolve([]),
      { pattern: "I have {string}", isRegex: false }
    );

    expect(quickPick).not.toHaveBeenCalled();
    expect(insertSnippet).toHaveBeenCalledOnce();
    const snippet = insertSnippet.mock.calls[0]![0] as vscode.SnippetString;
    expect(snippet.value).toBe('I have "${1:string}"$0');
  });

  it("inserts the picked definition's snippet from the quick pick", async () => {
    const { editor, insertSnippet } = featureEditor();
    win.activeTextEditor = editor;
    win.showQuickPick = (items: unknown) =>
      Promise.resolve((items as Array<{ label: string }>).find((i) => i.label === "middle"));

    const defs: InsertStepSource[] = [
      { pattern: "alpha {int}", isRegex: false, keyword: "Given", filePath: "/s.ts" },
      { pattern: "middle", isRegex: false, keyword: "Then", filePath: "/s.ts" },
    ];
    await runInsertStep(() => Promise.resolve(defs));

    expect(insertSnippet).toHaveBeenCalledOnce();
    expect((insertSnippet.mock.calls[0]![0] as vscode.SnippetString).value).toBe("middle");
  });

  it("inserts nothing when the quick pick is cancelled", async () => {
    const { editor, insertSnippet } = featureEditor();
    win.activeTextEditor = editor;
    win.showQuickPick = () => Promise.resolve(undefined);

    await runInsertStep(() =>
      Promise.resolve([{ pattern: "a", isRegex: false, filePath: "/s.ts" }])
    );
    expect(insertSnippet).not.toHaveBeenCalled();
  });

  it("shows the stepDefinitionPaths hint when the index has no definitions", async () => {
    const { editor, insertSnippet } = featureEditor();
    win.activeTextEditor = editor;
    const info = vi.fn().mockResolvedValue(undefined);
    win.showInformationMessage = info;

    await runInsertStep(() => Promise.resolve([]));

    expect(String(info.mock.calls[0]![0])).toContain("stepDefinitionPaths");
    expect(insertSnippet).not.toHaveBeenCalled();
  });
});
