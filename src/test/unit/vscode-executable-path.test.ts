import { describe, expect, it, vi } from "vitest";
import { resolveVSCodeExecutablePath, resolveVSCodeVersion } from "../integration/vscode-executable-path";

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

describe("resolveVSCodeVersion", () => {
  it("resolves the minimum token from the extension engine range", () => {
    expect(resolveVSCodeVersion("minimum", "^1.99.0")).toBe("1.99.0");
  });

  it("leaves stable and exact versions unchanged", () => {
    expect(resolveVSCodeVersion("stable", "^1.99.0")).toBe("stable");
    expect(resolveVSCodeVersion("1.127.0", "^1.99.0")).toBe("1.127.0");
  });

  it("rejects an engine range without a concrete minimum", () => {
    expect(() => resolveVSCodeVersion("minimum", "latest")).toThrow(/Cannot resolve/u);
  });
});
