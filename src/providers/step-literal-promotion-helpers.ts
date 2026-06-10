export interface LiteralCandidate {
  kind: "string" | "int" | "float";
  text: string;
  placeholder: string;
  stepStart: number;
  stepEnd: number;
}

const STRING_LITERAL_RE = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
const NUMERIC_LITERAL_RE = /(?<![A-Za-z0-9_."'])(-?\d+\.\d+|-?\d+)(?![A-Za-z0-9_."'])/g;

export function findLiteralCandidates(stepText: string): LiteralCandidate[] {
  const stringSpans: Array<{ start: number; end: number }> = [];
  const candidates: LiteralCandidate[] = [];

  STRING_LITERAL_RE.lastIndex = 0;
  let strMatch: RegExpExecArray | null = STRING_LITERAL_RE.exec(stepText);
  while (strMatch !== null) {
    const start = strMatch.index;
    const end = start + strMatch[0].length;
    stringSpans.push({ start, end });
    candidates.push({
      kind: "string",
      text: strMatch[0],
      placeholder: "{string}",
      stepStart: start,
      stepEnd: end,
    });
    strMatch = STRING_LITERAL_RE.exec(stepText);
  }

  NUMERIC_LITERAL_RE.lastIndex = 0;
  let numMatch: RegExpExecArray | null = NUMERIC_LITERAL_RE.exec(stepText);
  while (numMatch !== null) {
    const numText = numMatch[1] ?? "";
    const start = numMatch.index;
    const end = start + numText.length;
    numMatch = NUMERIC_LITERAL_RE.exec(stepText);
    if (isInsideAnySpan(start, end, stringSpans)) {continue;}
    const kind: "int" | "float" = numText.includes(".") ? "float" : "int";
    candidates.push({
      kind,
      text: numText,
      placeholder: kind === "float" ? "{float}" : "{int}",
      stepStart: start,
      stepEnd: end,
    });
  }

  candidates.sort((a, b) => a.stepStart - b.stepStart);
  return candidates;
}

export function findLiteralInDefPattern(
  pattern: string,
  literal: string,
  occurrence: number
): { start: number; end: number } | undefined {
  const segments = splitPatternByPlaceholders(pattern);
  let remaining = occurrence;
  for (const segment of segments) {
    let idx = segment.text.indexOf(literal);
    while (idx !== -1) {
      if (remaining === 0) {
        return { start: segment.start + idx, end: segment.start + idx + literal.length };
      }
      remaining -= 1;
      idx = segment.text.indexOf(literal, idx + 1);
    }
  }
  return undefined;
}

/** How many occurrences of `literal` appear in `text` strictly before `literalStart`. */
export function literalOccurrenceOrdinal(
  text: string,
  literal: string,
  literalStart: number
): number {
  let count = 0;
  let idx = text.indexOf(literal);
  while (idx !== -1 && idx < literalStart) {
    count += 1;
    idx = text.indexOf(literal, idx + 1);
  }
  return count;
}

interface PatternSegment {
  text: string;
  start: number;
}

function splitPatternByPlaceholders(pattern: string): PatternSegment[] {
  const segments: PatternSegment[] = [];
  let segStart = 0;
  let buf = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "\\" && (pattern[i + 1] === "{" || pattern[i + 1] === "}")) {
      buf += pattern[i + 1];
      i += 2;
      continue;
    }
    if (ch === "{") {
      const close = pattern.indexOf("}", i + 1);
      if (close !== -1) {
        if (buf.length > 0) {segments.push({ text: buf, start: segStart });}
        buf = "";
        i = close + 1;
        segStart = i;
        continue;
      }
    }
    buf += ch ?? "";
    i += 1;
  }
  if (buf.length > 0) {segments.push({ text: buf, start: segStart });}
  return segments;
}

function isInsideAnySpan(
  start: number,
  end: number,
  spans: Array<{ start: number; end: number }>
): boolean {
  for (const span of spans) {
    if (start >= span.start && end <= span.end) {return true;}
  }
  return false;
}
