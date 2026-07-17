import * as fs from "node:fs";
import * as path from "node:path";

const PLAYWRIGHT_CONFIG_NAMES = [
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mts",
  "playwright.config.mjs",
  "playwright.config.cts",
  "playwright.config.cjs",
];

interface FolderLike {
  uri: { fsPath: string };
}

function comparable(p: string, caseInsensitive: boolean): string {
  const normalized = path.normalize(p);
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

/**
 * True when `child` is `root` itself or a directory nested inside it. Compares canonicalized
 * forms (case-insensitively on Windows) so a cwd that `canonicalCwd` uppercased the drive on still
 * matches the raw lowercase-drive `uri.fsPath` VS Code hands back — a case-sensitive `===` there
 * never matches on Windows, dropping multi-root runs back to folders[0].
 */
export function isSameOrInsideDir(
  child: string,
  root: string,
  caseInsensitive: boolean = process.platform === "win32"
): boolean {
  const c = comparable(child, caseInsensitive);
  const r = comparable(root, caseInsensitive);
  return c === r || c.startsWith(`${r}${path.sep}`);
}

/**
 * Canonicalize a path for use as a spawned process's working directory.
 *
 * VS Code's `Uri.fsPath` lowercases the Windows drive letter (`C:\repo` → `c:\repo`),
 * and every cwd the extension infers ultimately derives from a `uri.fsPath`. Node and
 * the filesystem, however, report absolute paths with an uppercase drive. playwright-bdd
 * decides whether each feature lives inside `featuresRoot` by string-comparing resolved
 * paths case-sensitively, so a lowercase-drive cwd makes every feature look "outside the
 * features scope" — but only on Windows, where drive letters exist. `path.normalize`
 * fixes separators but never touches drive-letter case, so we uppercase it here to keep
 * the spawn cwd consistent with the paths bddgen resolves internally.
 */
export function canonicalCwd(
  dir: string,
  isWindows: boolean = process.platform === "win32"
): string {
  // Derive the path implementation from the flag rather than the host module. At runtime the
  // flag always matches the host, so production behavior is identical — but it makes the
  // function (and its unit tests) host-independent: the bare `path.normalize` rewrote the
  // POSIX test paths with backslashes on the windows-latest CI runner.
  const impl = isWindows ? path.win32 : path.posix;
  const normalized = impl.normalize(dir);
  if (isWindows && /^[a-z]:/.test(normalized)) {
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
  return normalized;
}

/** Root of the workspace folder containing the file (multi-root aware), or undefined. */
export function workspaceFolderRootFor(
  filePath: string,
  folders: readonly FolderLike[] | undefined,
  caseInsensitive: boolean = process.platform === "win32"
): string | undefined {
  if (!folders) {return undefined;}
  const file = comparable(filePath, caseInsensitive);
  for (const folder of folders) {
    const root = path.normalize(folder.uri.fsPath);
    if (file.startsWith(`${comparable(root, caseInsensitive)}${path.sep}`)) {
      return root;
    }
  }
  return undefined;
}

/**
 * Directory of the nearest `playwright.config.*` at or above the feature file,
 * walking up to the workspace folder root (inclusive). In a monorepo this finds
 * the package that owns the playwright-bdd setup — the right cwd for `npx` /
 * `pnpm exec` to resolve the `bddgen` and `playwright` binaries, since pnpm links
 * binaries only into the `node_modules/.bin` of the package that declares them
 * (no hoisting to the workspace root).
 */
export function findNearestPlaywrightConfigDir(
  featureFilePath: string,
  stopDir: string,
  caseInsensitive: boolean = process.platform === "win32"
): string | undefined {
  const stop = comparable(stopDir, caseInsensitive);
  let dir = path.dirname(path.resolve(featureFilePath));
  for (;;) {
    if (PLAYWRIGHT_CONFIG_NAMES.some((name) => fs.existsSync(path.join(dir, name)))) {
      return dir;
    }
    if (comparable(dir, caseInsensitive) === stop) {return undefined;}
    const parent = path.dirname(dir);
    if (parent === dir) {return undefined;}
    dir = parent;
  }
}
