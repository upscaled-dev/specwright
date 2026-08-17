import { AuthoredTest, KeyGrammar, NewTestSpec, RemoteMetadataSnapshot } from "./contracts";
import { keyForPrefix, stateless } from "./tag-extraction";
import { stripCr } from "../parsers/gherkin-slice";
import { TAG_TOKEN_PATTERN } from "../parsers/tag-regex";
import { providerWarnings } from "./provider-warnings";

export interface LinkScenarioPick {
  readonly key: string;
  readonly summary?: string | undefined;
}

function tagFor(prefix: string, key: string): string {
  return `@${prefix}${key}`;
}

export function buildTestTag(grammar: KeyGrammar, key: string): string {
  return tagFor(grammar.testPrefix, key);
}

// The picker only ever offers keys already in the snapshot; free-text key entry is never a path
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

function tagOnLine(
  line: string,
  prefix: string,
  grammar: KeyGrammar
): { token: string; key: string } | undefined {
  const keyShape = stateless(grammar.keyShape);
  for (const match of line.matchAll(new RegExp(TAG_TOKEN_PATTERN, "g"))) {
    const token = match[0];
    const key = keyForPrefix(token, prefix, keyShape, grammar.canonicalizeKey);
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
 * Idempotent placement of a provider tag above a scenario's keyword line. Re-running with the same
 * key is a no-op; a different key replaces the existing tag of that prefix in place (re-map); a
 * scenario with no such tag gets the tag appended to its nearest tag line, or a fresh tag line if it
 * has none. `prefix` selects which tag family is written and read, and defaults to the grammar's test
 * prefix. `scenarioLine` is 1-based (the tree's `ScenarioRef.line`).
 */
export function computeLinkEdit(
  lines: readonly string[],
  scenarioLine: number,
  key: string,
  grammar: KeyGrammar,
  prefix: string = grammar.testPrefix
): LinkEdit {
  const scenIdx = scenarioLine - 1;
  const newTag = tagFor(prefix, key);
  const newKey = grammar.canonicalizeKey(key);

  const tagLineIndices: number[] = [];
  for (let i = scenIdx - 1; i >= 0 && (lines[i] ?? "").trim().startsWith("@"); i--) {
    tagLineIndices.unshift(i);
  }

  for (const idx of tagLineIndices) {
    // The caller splits on "\n", so a CRLF line keeps a trailing "\r"; strip it here so replaceLine
    // text is EOL-free and the caller writes it in front of the document's own "\r\n".
    const line = stripCr(lines[idx] ?? "");
    const existing = tagOnLine(line, prefix, grammar);
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

export type UnlinkEdit =
  | { kind: "unchanged" }
  | { kind: "replaceLine"; line: number; text: string }
  | { kind: "deleteLine"; line: number };

function tagForKey(
  line: string,
  key: string,
  prefix: string,
  grammar: KeyGrammar
): { token: string; at: number } | undefined {
  const keyShape = stateless(grammar.keyShape);
  const target = grammar.canonicalizeKey(key);
  for (const match of line.matchAll(new RegExp(TAG_TOKEN_PATTERN, "g"))) {
    const token = match[0];
    if (keyForPrefix(token, prefix, keyShape, grammar.canonicalizeKey) === target && match.index !== undefined) {
      return { token, at: match.index };
    }
  }
  return undefined;
}

/**
 * The removal twin of `computeLinkEdit`: strips the `@TEST_<key>` tag from a scenario's tag lines
 * (`prefix` selects the tag family, defaulting to the grammar's test prefix). When the tag shares its
 * line with other tags the token and one adjoining space go; when it is the only tag on the line the
 * whole line (and its terminator) goes; a key that isn't tagged is a no-op. `scenarioLine` is 1-based
 * (the tree's `ScenarioRef.line`).
 */
export function computeUnlinkEdit(
  lines: readonly string[],
  scenarioLine: number,
  key: string,
  grammar: KeyGrammar,
  prefix: string = grammar.testPrefix
): UnlinkEdit {
  const scenIdx = scenarioLine - 1;

  const tagLineIndices: number[] = [];
  for (let i = scenIdx - 1; i >= 0 && (lines[i] ?? "").trim().startsWith("@"); i--) {
    tagLineIndices.unshift(i);
  }

  for (const idx of tagLineIndices) {
    // The caller splits on "\n", so a CRLF line keeps a trailing "\r"; strip it here so replaceLine
    // text is EOL-free and the caller writes it in front of the document's own "\r\n".
    const line = stripCr(lines[idx] ?? "");
    const found = tagForKey(line, key, prefix, grammar);
    if (found === undefined) {
      continue;
    }
    const after = found.at + found.token.length;
    if ((line.slice(0, found.at) + line.slice(after)).trim() === "") {
      return { kind: "deleteLine", line: idx };
    }
    // Take one adjoining space with the token: the following space when there is one (so a leading or
    // interior tag closes up), otherwise the preceding space (a trailing tag).
    let start = found.at;
    let end = after;
    if (line[end] === " ") {
      end += 1;
    } else if (found.at > 0 && line[found.at - 1] === " ") {
      start -= 1;
    }
    return { kind: "replaceLine", line: idx, text: line.slice(0, start) + line.slice(end) };
  }

  return { kind: "unchanged" };
}

export interface AuthorScenarioTestUi {
  // The pre-confirm modal: resolves true only on the explicit affirmative. NO authoring write fires
  // before this resolves true (a unit test pins the dismiss → no-mutation contract).
  confirm(): Promise<boolean>;
  info(message: string): void;
  error(message: string): void;
}

export interface AuthorScenarioTestDeps {
  createTest(spec: NewTestSpec, signal?: AbortSignal): Promise<AuthoredTest>;
  insertTag(key: string): Promise<void>;
  merge(key: string): void;
}

/**
 * One scenario's create-and-tag sequence, shared by the single create flow and the bulk one. Order is
 * load-bearing: create → (only with a readable key) insert the tag → additive merge. A create that
 * returns no key still happened remotely, so it comes back untagged and unmerged for the caller to
 * report rather than tagged with a key we can't trust.
 */
export async function createAndTagTest(
  spec: NewTestSpec,
  deps: AuthorScenarioTestDeps,
  signal?: AbortSignal
): Promise<AuthoredTest> {
  const created = await deps.createTest(spec, signal);
  if (created.key !== undefined) {
    await deps.insertTag(created.key);
    deps.merge(created.key);
  }
  return created;
}

/**
 * The create-from-scenario flow, isolated from VS Code so the confirm gate and the keyless-response
 * handling are unit-testable. Nothing is written before the confirm resolves true; the create itself
 * runs through `createAndTagTest`. A create that returns no key is surfaced (with the issue id if
 * present) rather than dropped.
 */
export async function authorScenarioTest(
  spec: NewTestSpec,
  providerLabel: string,
  ui: AuthorScenarioTestUi,
  deps: AuthorScenarioTestDeps,
  signal?: AbortSignal
): Promise<AuthoredTest | undefined> {
  if (!(await ui.confirm())) {
    return undefined;
  }
  const created = await createAndTagTest(spec, deps, signal);
  if (created.key === undefined) {
    const idNote = created.issueId !== undefined ? ` (issue id ${created.issueId})` : "";
    ui.error(
      `The ${providerLabel} test was created${idNote} but its key could not be read back, so the tag was not inserted: add it by hand.`
    );
    return created;
  }
  const base = `Created ${created.key} and linked this scenario.`;
  const warnings = providerWarnings(created.warnings);
  ui.info(warnings.count > 0 ? `${base} ${warnings.summary} logged.` : base);
  return created;
}
