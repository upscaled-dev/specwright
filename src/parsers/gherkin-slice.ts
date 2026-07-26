// "Example:" and "Scenario Template:" are standard Gherkin synonyms — keep in
// sync with SCENARIO_BOUNDARY_RE in providers/scenario-boundary.ts.
export const SCENARIO_KEYWORDS = [
  "Scenario Outline:",
  "Scenario Template:",
  "Scenario:",
  "Example:",
] as const;

// `Example` is a scenario keyword the parser accepts, so a slice must stop at one or it would run to
// the end of the file. The trailing `\b` is what keeps `Examples:` out of this set: the `s` blocks the
// word boundary, so an outline's tables stay inside their outline.
const NEXT_SCENARIO_BLOCK = /^(Feature|Rule|Background|Scenario Outline|Scenario Template|Scenario|Example)\b/;
const EXAMPLES_BLOCK = /^(Examples|Scenarios)\b/;

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Does this line still open exactly the scenario called `name`? A structural keyword line whose title
 * is that name, and nothing else: a comment, a `Rule:`, an `Examples:` header, or a neighbouring
 * scenario all fail it. Every write that targets a recorded line re-checks it here first, so a file
 * edited since the line was recorded can never be tagged or pushed on someone else's behalf.
 */
export function opensScenario(line: string | undefined, name: string): boolean {
  const trimmed = stripCr(line ?? "").trim();
  const keyword = SCENARIO_KEYWORDS.find((candidate) => trimmed.startsWith(candidate));
  return keyword !== undefined && trimmed.slice(keyword.length).trim() === name;
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

/**
 * THE local text of a scenario, verbatim from source: its keyword line through the end of its block —
 * steps, doc-strings, data tables, and every Examples block (including tagged ones) — stopping before
 * the next scenario's tags or any following structural keyword. The preceding tag lines are excluded
 * because the slice starts AT the keyword line. `scenarioLine` is 1-based.
 *
 * One text serves every consumer: the parser stamps it on each scenario (so the drift badge compares
 * it), the create path authors from it, and the push path writes it. Comparing anything else against
 * the remote would make the badge and the push contradict each other on any outline, data table, or
 * doc-string.
 */
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
