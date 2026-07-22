import { AuthoredTest, KeyGrammar, NewTestSpec, RemoteMetadataSnapshot } from "./contracts";
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

export type UnlinkEdit =
  | { kind: "unchanged" }
  | { kind: "replaceLine"; line: number; text: string }
  | { kind: "deleteLine"; line: number };

function testTagForKey(
  line: string,
  key: string,
  grammar: KeyGrammar
): { token: string; at: number } | undefined {
  const target = grammar.canonicalizeKey(key);
  for (const match of line.matchAll(new RegExp(TAG_TOKEN_PATTERN, "g"))) {
    const token = match[0];
    if (extractKeys([token], grammar).testKeys[0] === target && match.index !== undefined) {
      return { token, at: match.index };
    }
  }
  return undefined;
}

/**
 * The removal twin of `computeLinkEdit`: strips the `@TEST_<key>` tag from a scenario's tag lines.
 * When the tag shares its line with other tags the token and one adjoining space go; when it is the
 * only tag on the line the whole line (and its terminator) goes; a key that isn't tagged is a no-op.
 * `scenarioLine` is 1-based (the tree's `ScenarioRef.line`).
 */
export function computeUnlinkEdit(
  lines: readonly string[],
  scenarioLine: number,
  key: string,
  grammar: KeyGrammar
): UnlinkEdit {
  const scenIdx = scenarioLine - 1;

  const tagLineIndices: number[] = [];
  for (let i = scenIdx - 1; i >= 0 && (lines[i] ?? "").trim().startsWith("@"); i--) {
    tagLineIndices.unshift(i);
  }

  for (const idx of tagLineIndices) {
    // The caller splits on "\n", so a CRLF line keeps a trailing "\r"; strip it here so replaceLine
    // text is EOL-free and the caller writes it in front of the document's own "\r\n".
    const raw = lines[idx] ?? "";
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const found = testTagForKey(line, key, grammar);
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

const NEXT_SCENARIO_BLOCK = /^(Feature|Rule|Background|Scenario Outline|Scenario Template|Scenario)\b/;
const EXAMPLES_BLOCK = /^(Examples|Scenarios)\b/;

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

// Skipping blank and tag lines from `from`, does the next structural line open an Examples block?
// (i.e. do these tags belong to an Examples block of the current outline, not the next scenario).
function tagsLeadIntoExamples(lines: readonly string[], from: number): boolean {
  let j = from;
  while (j < lines.length) {
    const ahead = stripCr(lines[j] ?? "").trim();
    if (ahead === "" || ahead.startsWith("@")) {
      j++;
      continue;
    }
    break;
  }
  return EXAMPLES_BLOCK.test(stripCr(lines[j] ?? "").trim());
}

/**
 * Verbatim source slice for authoring a NEW remote test: from the scenario's keyword line through the
 * end of its block — steps, doc-strings, data tables, and every Examples block (including tagged
 * ones) — stopping before the next scenario's tags or any following structural keyword. The preceding
 * tag lines are excluded because the slice starts AT the keyword line. `scenarioLine` is 1-based.
 *
 * Deliberately NOT `reconstructScenarioGherkin` (traceability-model.ts) — that is lossy, dropping
 * tags/Examples/doc-strings/data-tables. Adjudicated: for a CREATE this generous slice is safe.
 * There is no remote content to overwrite, and the local `@TEST_<key>` tag we are about to add would
 * be stale remotely, so tags are omitted. A freshly created outline may then read as drifted against
 * the lossy local reconstruction the drift indicator uses — accepted; drift is display-only until the
 * push-text path lands.
 */
// Advances doc-string fence state for one line. `inString` is true when the line is inside or
// bounding a fence (`"""` or ```` ``` ````), so the boundary scan skips it — a body line that trims
// to a block keyword or a `@tag` inside a fence must NOT terminate the slice, or an embedded
// `Scenario: ...` would truncate the gherkin mid-string. The closer is a line whose trimmed text
// starts with the same delimiter that opened the fence.
function fenceState(current: string | undefined, trimmed: string): { fence: string | undefined; inString: boolean } {
  if (current !== undefined) {
    return { fence: trimmed.startsWith(current) ? undefined : current, inString: true };
  }
  if (trimmed.startsWith('"""') || trimmed.startsWith("```")) {
    return { fence: trimmed.startsWith('"""') ? '"""' : "```", inString: true };
  }
  return { fence: undefined, inString: false };
}

// Scans forward from the scenario keyword line to the first block boundary (the next scenario's tags
// or a following structural keyword), returning the exclusive end index. `openFence` reports an
// unterminated doc-string at scan end (malformed source).
function findSliceEnd(lines: readonly string[], start: number): { end: number; openFence: boolean } {
  let fence: string | undefined;
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = stripCr(lines[i] ?? "").trim();
    const state = fenceState(fence, trimmed);
    fence = state.fence;
    if (state.inString) {
      continue;
    }
    // Tags leading into an Examples block belong to THIS outline — keep scanning. Tags leading into a
    // scenario/rule, or any following structural keyword, end the slice before them.
    if (trimmed.startsWith("@") && tagsLeadIntoExamples(lines, i)) {
      continue;
    }
    if (trimmed.startsWith("@") || NEXT_SCENARIO_BLOCK.test(trimmed)) {
      return { end: i, openFence: false };
    }
  }
  return { end: lines.length, openFence: fence !== undefined };
}

export function scenarioGherkinSlice(lines: readonly string[], scenarioLine: number): string {
  const start = scenarioLine - 1;
  const scan = findSliceEnd(lines, start);
  let end = scan.end;
  // Drop trailing blank or comment-only lines so a stray comment sitting between scenarios never rides
  // into the created gherkin. `#`-lines are only comments OUTSIDE a fence — an unterminated doc-string
  // keeps its `#` body, trimming trailing blanks only.
  const dropComments = !scan.openFence;
  while (end > start + 1) {
    const tail = stripCr(lines[end - 1] ?? "").trim();
    if (tail === "" || (dropComments && tail.startsWith("#"))) {
      end--;
    } else {
      break;
    }
  }
  return lines.slice(start, end).map(stripCr).join("\n");
}

export interface AuthorScenarioTestUi {
  // The pre-confirm modal — resolves true only on the explicit affirmative. NO authoring write fires
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
 * The create-from-scenario flow, isolated from VS Code so the confirm gate and the keyless-response
 * handling are unit-testable. Order is load-bearing: confirm → create → (only with a readable key)
 * insert the tag → additive merge. A create that returns no key still happened remotely, so it is
 * surfaced (with the issue id if present) rather than dropped or tagged with a key we can't trust.
 */
export async function authorScenarioTest(
  spec: NewTestSpec,
  providerLabel: string,
  ui: AuthorScenarioTestUi,
  deps: AuthorScenarioTestDeps,
  signal?: AbortSignal
): Promise<void> {
  if (!(await ui.confirm())) {
    return;
  }
  const created = await deps.createTest(spec, signal);
  if (created.key === undefined) {
    const idNote = created.issueId !== undefined ? ` (issue id ${created.issueId})` : "";
    ui.error(
      `The ${providerLabel} test was created${idNote} but its key could not be read back, so the tag was not inserted — add it by hand.`
    );
    return;
  }
  await deps.insertTag(created.key);
  deps.merge(created.key);
  const base = `Created ${created.key} and linked this scenario.`;
  ui.info(created.warnings.length > 0 ? `${base} Warnings: ${created.warnings.join("; ")}` : base);
}
