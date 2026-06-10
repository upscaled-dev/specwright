import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import * as vscode from "vscode";
import { toWorkspaceRelative } from "../../utils/workspace-path";

function setWorkspaceFolders(folders: Array<{ uri: { fsPath: string } }> | undefined): void {
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = folders;
}

describe("toWorkspaceRelative", () => {
  afterEach(() => {
    setWorkspaceFolders(undefined);
  });

  it("returns the relative path when the file is inside a workspace folder", () => {
    const root = path.join(path.sep, "ws");
    setWorkspaceFolders([{ uri: { fsPath: root } }]);
    const filePath = path.join(root, "features", "steps", "x.ts");
    expect(toWorkspaceRelative(filePath)).toBe(path.join("features", "steps", "x.ts"));
  });

  it("returns the absolute path when the file is outside any workspace folder", () => {
    setWorkspaceFolders([{ uri: { fsPath: path.join(path.sep, "ws") } }]);
    const outside = path.join(path.sep, "elsewhere", "file.ts");
    expect(toWorkspaceRelative(outside)).toBe(outside);
  });

  it("returns the absolute path when workspaceFolders is undefined", () => {
    setWorkspaceFolders(undefined);
    const filePath = path.join(path.sep, "any", "file.ts");
    expect(toWorkspaceRelative(filePath)).toBe(filePath);
  });

  it("returns the absolute path when workspaceFolders is empty", () => {
    setWorkspaceFolders([]);
    const filePath = path.join(path.sep, "any", "file.ts");
    expect(toWorkspaceRelative(filePath)).toBe(filePath);
  });

  it("does not strip a root prefix that lacks a trailing separator (substring guard)", () => {
    const root = path.join(path.sep, "ws");
    setWorkspaceFolders([{ uri: { fsPath: root } }]);
    const sibling = path.join(path.sep, "ws-other", "file.ts");
    expect(toWorkspaceRelative(sibling)).toBe(sibling);
  });

  it("matches case-insensitively when asked (Windows drive-letter casing)", () => {
    const root = path.join(path.sep, "Ws", "Project");
    setWorkspaceFolders([{ uri: { fsPath: root } }]);
    const differentCase = path.join(path.sep, "ws", "project", "file.ts");

    expect(toWorkspaceRelative(differentCase, true)).toBe("file.ts");
    expect(toWorkspaceRelative(differentCase, false)).toBe(differentCase);
  });

  it("returns the first matching workspace folder when multiple are configured", () => {
    const first = path.join(path.sep, "a");
    const second = path.join(path.sep, "b");
    setWorkspaceFolders([
      { uri: { fsPath: first } },
      { uri: { fsPath: second } },
    ]);
    const inSecond = path.join(second, "file.ts");
    expect(toWorkspaceRelative(inSecond)).toBe("file.ts");
  });
});
