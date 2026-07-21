import { describe, it, expect } from "vitest";
import { canonicalCwd, isSameOrInsideDir, toPathFilterRegex } from "../../utils/working-dir";

describe("toPathFilterRegex", () => {
  it("relativizes a feature file against the workspace-root working dir (non-monorepo)", () => {
    expect(toPathFilterRegex("/ws", "/ws/features/a.feature")).toBe("features/a\\.feature");
  });

  it("relativizes against the PACKAGE working dir so a monorepo path filter matches its generated specs", () => {
    // The Playwright config lives in packages/ui; relativizing against it (not /ws) yields the short
    // path that appears inside <pkg>/.features-gen/features/a.feature.
    expect(toPathFilterRegex("/ws/packages/ui", "/ws/packages/ui/features/a.feature")).toBe("features/a\\.feature");
  });

  it("relativizes a folder target the same way", () => {
    expect(toPathFilterRegex("/ws/packages/ui", "/ws/packages/ui/features/sub")).toBe("features/sub");
  });

  it("escapes every regex metacharacter so Playwright reads a literal path, not a pattern", () => {
    expect(toPathFilterRegex("/ws", "/ws/a.b+c(1).feature")).toBe("a\\.b\\+c\\(1\\)\\.feature");
  });

  it("falls back to the (forward-slashed, escaped) target when it is outside the working dir", () => {
    expect(toPathFilterRegex("/ws/pkg", "/other/features/a.feature")).toBe("/other/features/a\\.feature");
  });

  it("forward-slashes a backslash-separator target and regex-escapes it (v0.3.9 gotcha)", () => {
    // A Windows-separator path outside the working dir falls back to the target as-is: backslashes
    // become forward slashes (a backslash path reads as regex poison, matching nothing) and every
    // regex metacharacter (the dots) is escaped, so Playwright reads a literal path.
    expect(toPathFilterRegex("/ws/pkg", "C:\\repo\\features\\a.b.feature")).toBe("C:/repo/features/a\\.b\\.feature");
  });
});

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
