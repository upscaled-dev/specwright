import { describe, it, expect } from "vitest";
import { canonicalCwd, isSameOrInsideDir } from "../../utils/working-dir";

describe("canonicalCwd", () => {
  describe("on Windows", () => {
    const win = (p: string) => canonicalCwd(p, /*isWindows*/ true);

    it("uppercases a lowercase drive letter (VS Code's uri.fsPath quirk)", () => {
      // VS Code's Uri.fsPath returns `c:\repo`; the filesystem reports `C:\repo`.
      // playwright-bdd compares these case-sensitively, so the cwd must match.
      expect(win("c:\\repo\\packages\\api")).toBe("C:\\repo\\packages\\api");
    });

    it("leaves an already-uppercase drive letter untouched", () => {
      expect(win("C:\\repo")).toBe("C:\\repo");
    });

    it("uppercases the drive and normalizes separators regardless of slash style", () => {
      // canonicalCwd picks path.win32/path.posix from the isWindows flag, so the full
      // normalized output is deterministic on every test host.
      expect(win("c:/repo/packages/ui")).toBe("C:\\repo\\packages\\ui");
    });

    it("does not alter UNC paths (no drive letter)", () => {
      expect(win("\\\\server\\share\\repo")).toBe("\\\\server\\share\\repo");
    });
  });

  describe("on POSIX", () => {
    const posix = (p: string) => canonicalCwd(p, /*isWindows*/ false);

    it("leaves absolute paths unchanged (no drive letters)", () => {
      expect(posix("/Users/dev/repo/packages/api")).toBe(
        "/Users/dev/repo/packages/api"
      );
    });

    it("does not mistake a leading letter+colon for a drive", () => {
      // A path that merely starts with a letter is normalized but not drive-cased.
      expect(posix("/srv/c:weird")).toBe("/srv/c:weird");
    });
  });
});

describe("isSameOrInsideDir", () => {
  // Forward-slash inputs + an explicit caseInsensitive flag keep these host-independent:
  // path.normalize rewrites both operands the same way on POSIX and win32 CI runners.
  it("is true for the root directory itself", () => {
    expect(isSameOrInsideDir("/repo/pkg", "/repo/pkg", /*caseInsensitive*/ false)).toBe(true);
  });

  it("is true for a directory nested inside the root", () => {
    expect(isSameOrInsideDir("/repo/pkg/e2e", "/repo/pkg", /*caseInsensitive*/ false)).toBe(true);
  });

  it("is false for a sibling that merely shares a name prefix", () => {
    expect(isSameOrInsideDir("/repo/pkg-other", "/repo/pkg", /*caseInsensitive*/ false)).toBe(false);
  });

  it("matches case-insensitively — the canonicalCwd uppercase-drive vs lowercase-fsPath case", () => {
    // On Windows the cwd is canonicalized to an uppercase drive while the workspace folder's
    // uri.fsPath keeps the lowercase drive VS Code produced; the two must still match.
    expect(isSameOrInsideDir("/Repo/pkg/e2e", "/repo/pkg", /*caseInsensitive*/ true)).toBe(true);
  });

  it("respects case when comparing case-sensitively (POSIX)", () => {
    expect(isSameOrInsideDir("/Repo/pkg/e2e", "/repo/pkg", /*caseInsensitive*/ false)).toBe(false);
  });
});
