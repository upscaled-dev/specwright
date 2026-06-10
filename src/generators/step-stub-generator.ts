export type InferredCucumberType = "{string}" | "{int}" | "{float}";
export type InferredTsType = "string" | "number";

export interface InferredParam {
  name: string;
  type: InferredTsType;
  cucumberType: InferredCucumberType;
}

export interface InferredStep {
  pattern: string;
  params: InferredParam[];
}

interface RawMatch {
  start: number;
  end: number;
  cucumberType: InferredCucumberType;
  tsType: InferredTsType;
  baseName: string;
}

const QUOTED_RE = /"[^"]*"|'[^']*'/g;
const FLOAT_RE = /-?\d+\.\d+/g;
const INT_RE = /-?\d+/g;
const PLACEHOLDER_RE = /<([^>]+)>/g;
const VALID_KEYWORDS = new Set(["Given", "When", "Then"]);

export function inferParameters(stepText: string): InferredStep {
  const claimed: boolean[] = new Array(stepText.length).fill(false);
  const floatDigitRanges: boolean[] = new Array(stepText.length).fill(false);
  const matches: RawMatch[] = [];

  collectQuoted(stepText, claimed, matches);
  collectPlaceholders(stepText, claimed, matches);
  collectFloats(stepText, claimed, floatDigitRanges, matches);
  collectInts(stepText, claimed, floatDigitRanges, matches);

  matches.sort((a, b) => a.start - b.start);

  const { pattern, params } = buildPatternAndParams(stepText, matches);
  resolveNameCollisions(params);
  return { pattern, params };
}

export function formatStub(keyword: "Given" | "When" | "Then", stepText: string): string {
  if (!VALID_KEYWORDS.has(keyword)) {
    throw new Error(`formatStub: keyword must be Given/When/Then, got: ${keyword}`);
  }
  const { pattern, params } = inferParameters(stepText);
  const paramList = params.map((p) => `${p.name}: ${p.type}`).join(", ");
  const paramSegment = paramList.length > 0 ? `, ${paramList}` : "";
  // The pattern lands inside a double-quoted JS string literal: without escaping,
  // `\{` collapses to `{` (losing the cucumber-expression escape) and a `"` breaks the stub.
  const emitted = pattern.replaceAll("\\", "\\\\").replaceAll(`"`, `\\"`);
  return `${keyword}("${emitted}", async ({}${paramSegment}) => {\n  // TODO: implement\n});`;
}

export function buildFileHeader(): string {
  return [
    'import { createBdd } from "playwright-bdd";',
    "",
    "const { Given, When, Then } = createBdd();",
    "",
    "",
  ].join("\n");
}

function collectQuoted(stepText: string, claimed: boolean[], matches: RawMatch[]): void {
  for (const m of stepText.matchAll(QUOTED_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    markClaimed(claimed, start, end);
    matches.push({ start, end, cucumberType: "{string}", tsType: "string", baseName: "str" });
  }
}

function collectPlaceholders(stepText: string, claimed: boolean[], matches: RawMatch[]): void {
  for (const m of stepText.matchAll(PLACEHOLDER_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (rangeOverlapsClaimed(claimed, start, end)) {continue;}
    markClaimed(claimed, start, end);
    const inner = (m[1] ?? "").trim();
    const baseName = safeIdentifier(inner);
    matches.push({ start, end, cucumberType: "{string}", tsType: "string", baseName });
  }
}

function collectFloats(
  stepText: string,
  claimed: boolean[],
  floatDigitRanges: boolean[],
  matches: RawMatch[]
): void {
  for (const m of stepText.matchAll(FLOAT_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    markClaimed(floatDigitRanges, start, end);
    if (rangeOverlapsClaimed(claimed, start, end)) {continue;}
    if (!isNumberBoundaryAt(stepText, start, end)) {continue;}
    markClaimed(claimed, start, end);
    matches.push({ start, end, cucumberType: "{float}", tsType: "number", baseName: "value" });
  }
}

function collectInts(
  stepText: string,
  claimed: boolean[],
  floatDigitRanges: boolean[],
  matches: RawMatch[]
): void {
  for (const m of stepText.matchAll(INT_RE)) {
    const rawStart = m.index ?? 0;
    const end = rawStart + m[0].length;
    if (rangeOverlapsClaimed(floatDigitRanges, rawStart, end)) {continue;}
    if (rangeOverlapsClaimed(claimed, rawStart, end)) {continue;}
    const adjustedStart = adjustIntStart(stepText, rawStart, end, m[0].startsWith("-"));
    if (adjustedStart === undefined) {continue;}
    markClaimed(claimed, adjustedStart, end);
    matches.push({
      start: adjustedStart,
      end,
      cucumberType: "{int}",
      tsType: "number",
      baseName: "count",
    });
  }
}

function adjustIntStart(
  text: string,
  start: number,
  end: number,
  hasLeadingSign: boolean
): number | undefined {
  if (isNumberBoundaryAt(text, start, end)) {return start;}
  if (!hasLeadingSign) {return undefined;}
  const trimmed = start + 1;
  if (trimmed >= end) {return undefined;}
  if (!isNumberBoundaryAt(text, trimmed, end)) {return undefined;}
  return trimmed;
}

function buildPatternAndParams(
  stepText: string,
  matches: RawMatch[]
): { pattern: string; params: InferredParam[] } {
  const params: InferredParam[] = [];
  let pattern = "";
  let cursor = 0;
  for (const m of matches) {
    pattern += escapeBraces(stepText.slice(cursor, m.start));
    pattern += m.cucumberType;
    cursor = m.end;
    params.push({ name: m.baseName, type: m.tsType, cucumberType: m.cucumberType });
  }
  pattern += escapeBraces(stepText.slice(cursor));
  return { pattern, params };
}

function escapeBraces(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "{") {out += "\\{";}
    else if (ch === "}") {out += "\\}";}
    else {out += ch;}
  }
  return out;
}

function markClaimed(claimed: boolean[], start: number, end: number): void {
  for (let i = start; i < end; i++) {claimed[i] = true;}
}

function rangeOverlapsClaimed(claimed: boolean[], start: number, end: number): boolean {
  for (let i = start; i < end; i++) {if (claimed[i]) {return true;}}
  return false;
}

function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) {return false;}
  return /[A-Za-z0-9_]/.test(ch);
}

function isNumberBoundaryAt(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : undefined;
  const after = end < text.length ? text[end] : undefined;
  const startsWithSign = text[start] === "-";
  const leftOk = startsWithSign ? isSignLeftBoundaryOk(before) : !isWordChar(before);
  const rightOk = !isWordChar(after);
  return leftOk && rightOk;
}

function isSignLeftBoundaryOk(before: string | undefined): boolean {
  if (before === undefined) {return true;}
  if (/\s/.test(before)) {return true;}
  return !isWordChar(before) && before !== "-";
}

function resolveNameCollisions(params: InferredParam[]): void {
  const baseCounts = new Map<string, number>();
  for (const p of params) {
    baseCounts.set(p.name, (baseCounts.get(p.name) ?? 0) + 1);
  }
  const counters = new Map<string, number>();
  for (const p of params) {
    const total = baseCounts.get(p.name) ?? 0;
    if (total <= 1) {continue;}
    const base = p.name;
    const idx = (counters.get(base) ?? 0) + 1;
    counters.set(base, idx);
    p.name = `${base}${idx}`;
  }
}

function safeIdentifier(raw: string): string {
  const parts = raw.split(/[^A-Za-z0-9]+/).filter((s) => s.length > 0);
  if (parts.length === 0) {return "str";}
  const first = (parts[0] ?? "").toLowerCase();
  const rest = parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
  const joined = first + rest.join("");
  if (joined.length === 0) {return "str";}
  if (/^\d/.test(joined)) {return "str";}
  return joined;
}
