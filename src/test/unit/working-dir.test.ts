import { describe, it, expect } from "vitest";
import { canonicalCwd } from "../../utils/working-dir";

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

    it("uppercases the drive regardless of slash style", () => {
      // Assert the drive-casing property only: separator normalization is delegated to
      // path.normalize, whose behavior is platform-dependent (and the test host is POSIX).
      const out = win("c:/repo/packages/ui");
      expect(out.startsWith("C:")).toBe(true);
      expect(out.startsWith("c:")).toBe(false);
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
