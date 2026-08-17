import * as vscode from "vscode";
import { TAG_TOKEN_PATTERN } from "../parsers/tag-regex";
import { workspaceExcludeGlob } from "../utils/discovery-excludes";
import { errMsg } from "../utils/text";
import type { Logger } from "../utils/logger";

export interface TraceabilityEvidenceConfig {
  readonly testFilePattern: string;
  readonly traceabilityTestTagPrefix: string;
  readonly traceabilityReqTagPrefix: string;
}

/**
 * Finds the first configured traceability tag without building the session-wide tag index.
 * Feature files are read one at a time and the scan stops at the first match.
 */
export async function hasTraceabilityTagEvidence(
  config: TraceabilityEvidenceConfig,
  logger: Logger
): Promise<boolean> {
  const prefixes = [
    config.traceabilityTestTagPrefix.toUpperCase(),
    config.traceabilityReqTagPrefix.toUpperCase(),
  ];
  const files = await vscode.workspace.findFiles(
    config.testFilePattern,
    workspaceExcludeGlob()
  );
  for (const file of files) {
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(file);
    } catch (error) {
      logger.warn(`Traceability evidence: could not read ${file.fsPath}`, {
        error: errMsg(error),
      });
      continue;
    }
    const content = Buffer.from(bytes).toString("utf-8");
    for (const line of content.split("\n")) {
      if (!line.trimStart().startsWith("@")) {continue;}
      for (const match of line.matchAll(new RegExp(TAG_TOKEN_PATTERN, "g"))) {
        const tag = match[0].slice(1).toUpperCase();
        if (prefixes.some((prefix) => tag.startsWith(prefix))) {
          return true;
        }
      }
    }
  }
  return false;
}
