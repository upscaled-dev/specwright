import { describe, expect, it, vi } from "vitest";
import { resolveVSCodeExecutablePath } from "../integration/vscode-executable-path";

describe("resolveVSCodeExecutablePath", () => {
  const electronPath = "/cache/Visual Studio Code.app/Contents/MacOS/Electron";
  const codePath = "/cache/Visual Studio Code.app/Contents/MacOS/Code";

  it("uses the executable returned by the downloader when it exists", () => {
    expect(resolveVSCodeExecutablePath(electronPath, "darwin", () => true)).toBe(electronPath);
  });

  it("uses the declared Code executable when Electron is absent on macOS", () => {
    expect(resolveVSCodeExecutablePath(
      electronPath,
      "darwin",
      (candidate) => candidate === codePath
    )).toBe(codePath);
  });

  it("leaves non-macOS executable paths unchanged", () => {
    const pathExists = vi.fn(() => false);

    expect(resolveVSCodeExecutablePath("C:/VSCode/Code.exe", "win32", pathExists))
      .toBe("C:/VSCode/Code.exe");
    expect(pathExists).not.toHaveBeenCalled();
  });
});
