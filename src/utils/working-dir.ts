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
