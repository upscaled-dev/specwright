import { existsSync } from "node:fs";
import * as path from "node:path";

export function resolveVSCodeExecutablePath(
  downloadedPath: string,
  platform: NodeJS.Platform = process.platform,
  pathExists: (filePath: string) => boolean = existsSync
): string {
  if (platform !== "darwin" || pathExists(downloadedPath)) {return downloadedPath;}

  // Recent macOS archives declare Code while @vscode/test-electron still returns Electron.
  const codePath = path.posix.join(path.posix.dirname(downloadedPath), "Code");
  return pathExists(codePath) ? codePath : downloadedPath;
}
