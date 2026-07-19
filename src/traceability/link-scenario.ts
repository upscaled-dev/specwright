import { KeyGrammar, RemoteMetadataSnapshot } from "./contracts";
import { extractKeys } from "./tag-extraction";
import { TAG_TOKEN_PATTERN } from "../parsers/tag-regex";

export interface LinkScenarioPick {
  readonly key: string;
  readonly summary?: string | undefined;
}

export function buildTestTag(grammar: KeyGrammar, key: string): string {
  return `@${grammar.testPrefix}${key}`;
}

// The picker only ever offers keys already in the snapshot — free-text key entry is never a path
// here, so a missing/empty snapshot is the caller's cue to prompt for connect/sync instead.
export function linkScenarioPicks(snapshot: RemoteMetadataSnapshot): LinkScenarioPick[] {
  return [...snapshot.tests.values()]
    .map((test) => ({ key: test.key, summary: test.summary }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export type LinkEdit =
  | { kind: "unchanged" }
  | { kind: "replaceLine"; line: number; text: string }
  | { kind: "insertLine"; line: number; text: string };

function testTagOnLine(
  line: string,
  grammar: KeyGrammar
): { token: string; key: string } | undefined {
  for (const match of line.matchAll(new RegExp(TAG_TOKEN_PATTERN, "g"))) {
    const token = match[0];
    const key = extractKeys([token], grammar).testKeys[0];
    if (key !== undefined) {
      return { token, key };
    }
  }
  return undefined;
}

function leadingWhitespace(line: string): string {
  return /^\s*/.exec(line)?.[0] ?? "";
}

/**
 * Idempotent placement of the provider test tag above a scenario's keyword line. Re-running with the
 * same key is a no-op; a different key replaces the existing test tag in place (re-map); a scenario
 * with no test tag gets the tag appended to its nearest tag line, or a fresh tag line if it has none.
 * `scenarioLine` is 1-based (the tree's `ScenarioRef.line`).
 */
export function computeLinkEdit(
  lines: readonly string[],
  scenarioLine: number,
  key: string,
  grammar: KeyGrammar
): LinkEdit {
  const scenIdx = scenarioLine - 1;
  const newTag = buildTestTag(grammar, key);
  const newKey = grammar.canonicalizeKey(key);

  const tagLineIndices: number[] = [];
  for (let i = scenIdx - 1; i >= 0 && (lines[i] ?? "").trim().startsWith("@"); i--) {
    tagLineIndices.unshift(i);
  }

  for (const idx of tagLineIndices) {
    // The caller splits on "\n", so a CRLF line keeps a trailing "\r"; strip it here so replaceLine
    // text is EOL-free and the caller writes it in front of the document's own "\r\n".
    const raw = lines[idx] ?? "";
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const existing = testTagOnLine(line, grammar);
    if (existing) {
      if (grammar.canonicalizeKey(existing.key) === newKey) {
        return { kind: "unchanged" };
      }
      const at = line.indexOf(existing.token);
      const text = line.slice(0, at) + newTag + line.slice(at + existing.token.length);
      return { kind: "replaceLine", line: idx, text };
    }
  }

  const nearest = tagLineIndices.at(-1);
  if (nearest !== undefined) {
    return { kind: "replaceLine", line: nearest, text: `${(lines[nearest] ?? "").trimEnd()} ${newTag}` };
  }

  return { kind: "insertLine", line: scenIdx, text: `${leadingWhitespace(lines[scenIdx] ?? "")}${newTag}` };
}
