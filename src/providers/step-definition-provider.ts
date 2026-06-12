import * as vscode from "vscode";
import { Logger } from "../utils/logger";
import { StepResolver } from "./step-resolver";
import { STEP_KEYWORDS } from "./step-keywords";

/**
 * Definition provider that jumps from a Gherkin step in a .feature file to its matching
 * playwright-bdd step definition in a TypeScript/JavaScript file.
 *
 * Playwright-bdd step definitions look like:
 *   import { createBdd } from 'playwright-bdd';
 *   const { Given, When, Then } = createBdd();
 *
 *   Given('I am on the home page', async ({ page }) => { ... });
 *   When('I click {string}', async ({ page }, label: string) => { ... });
 *   Then(/^the count is (\d+)$/, async ({ page }, count) => { ... });
 *
 * We support all three call shapes:
 *   - Plain string:  Given('text', ...)         -> wildcard expansion of {param} placeholders
 *   - Template lit:  Given(`text`, ...)         -> same as plain string
 *   - Regex literal: Given(/^pattern$/, ...)    -> compiled as-is
 *
 * And/But in feature files are matched permissively against any keyword.
 */
export class StepDefinitionProvider implements vscode.DefinitionProvider {
  private readonly stepGlobs: string[];
  private readonly resolver: StepResolver;

  constructor(stepGlobs: string[], logger?: Logger, resolver?: StepResolver) {
    this.stepGlobs = stepGlobs;
    this.resolver = resolver ?? new StepResolver(logger);
  }

  public async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Location[] | undefined> {
    const line = document.lineAt(position.line).text;
    const stepText = extractStepText(line);
    if (!stepText) {return undefined;}

    const files = await this.resolver.findStepFiles(this.stepGlobs);
    const matches: vscode.Location[] = [];

    for (const file of files) {
      const defs = this.resolver.parseStepFile(file);
      for (const def of defs) {
        if (def.regex.test(stepText)) {
          matches.push(new vscode.Location(
            vscode.Uri.file(file),
            new vscode.Range(def.line, 0, def.line, 0)
          ));
        }
      }
    }

    return matches.length > 0 ? matches : undefined;
  }
}

export interface ParsedStepDef {
  /** 0-based line number of the step definition call. */
  line: number;
  regex: RegExp;
  /** Original pattern text (for debugging). */
  pattern: string;
  /** True when the source was a regex literal (`/.../`), false for Cucumber-expression strings. */
  isRegex: boolean;
}

const STEP_LINE_RE = new RegExp(`^\\s*(?:${STEP_KEYWORDS})\\s+(.+?)\\s*$`);

/** Matches: `Given(...`, `When(...`, `Then(...`, `Step(...` (case-sensitive — that's how playwright-bdd exposes them). */
const STEP_CALL_RE = /(^|[^A-Za-z0-9_$.])(Given|When|Then|Step)\s*\(\s*([\s\S]*)$/;

/**
 * A step *definition* registers its handler synchronously: `Given('text', handler)`.
 * bddgen-generated specs (and code copied into reports) *invoke* steps instead:
 * `await Given('text')`. An awaited/returned/yielded call can never be a definition,
 * so such lines are skipped — generated output is ignored no matter where it lives.
 */
const INVOCATION_PREFIX_RE = /\b(?:await|return|yield)\s*$/;

/** True when the call at this position cannot be a definition: commented out, or invoked. */
function isNonDefinitionPrefix(prefix: string): boolean {
  return prefix.includes("//") || INVOCATION_PREFIX_RE.test(prefix);
}

/** bddgen stamps generated specs with this header; copies of them (e.g. in reports) keep it. */
const GENERATED_FILE_HEADER = "// Generated from:";

/**
 * A definition always passes a handler after the pattern — `Given('x', fn)` or
 * `Given('x', {options}, fn)`. Invocations never do: bddgen emits `Given('x')` or
 * `Given('x', null, { fixtures })`. So a call whose argument list ends after the
 * pattern, or whose next argument is `null`/`undefined`, cannot be a definition.
 * An empty/comma-only tail means the call continues on the next line (Prettier);
 * we assume definition there rather than risk dropping real steps.
 */
function hasDefinitionShape(tail: string): boolean {
  const t = tail.trimStart();
  if (t.startsWith(")")) {return false;}
  if (!t.startsWith(",")) {return true;}
  const afterComma = t.slice(1).trimStart();
  if (afterComma.length === 0) {return true;}
  return !/^(?:null|undefined)\s*[,)]/.test(afterComma);
}

/** From a feature-file line like `  Given I have 5 users`, return `I have 5 users`. */
export function extractStepText(line: string): string | undefined {
  const match = STEP_LINE_RE.exec(line);
  return match?.[1];
}

/**
 * Extract all step definitions from a TypeScript/JavaScript source file.
 */
export function extractStepDefsFromSource(content: string): ParsedStepDef[] {
  // A bddgen-generated spec (or a copy of one, e.g. inside a report directory)
  // contains only step invocations — never definitions. Skip the whole file.
  if (content.startsWith(GENERATED_FILE_HEADER)) {return [];}

  const defs: ParsedStepDef[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const callMatch = STEP_CALL_RE.exec(line);
    if (!callMatch) {continue;}

    const keywordStart = callMatch.index + (callMatch[1]?.length ?? 0);
    if (isNonDefinitionPrefix(line.slice(0, keywordStart))) {continue;}

    const parsed = parseCallArgument(lines, i, callMatch[3] ?? "");
    if (!parsed) {continue;}
    if (!hasDefinitionShape(parsed.tail)) {continue;}

    const regex = parsed.isRegex
      ? safeCompileRegex(anchorIfNeeded(parsed.text), parsed.flags)
      : safeCompileRegex(`^${patternToRegexSource(parsed.text)}$`);
    if (!regex) {continue;}

    defs.push({ line: i, regex, pattern: parsed.text, isRegex: parsed.isRegex });
  }

  return defs;
}

interface StepArg {
  text: string;
  isRegex: boolean;
  flags?: string;
  /** Remainder of the line after the first argument — used to detect handler-less invocations. */
  tail: string;
}

/**
 * Parse the pattern argument of a step call, looking at the following lines when
 * Prettier broke the call so the pattern lands on the next non-blank line.
 */
function parseCallArgument(lines: string[], i: number, rest: string): StepArg | undefined {
  const parsed = parseFirstArgument(rest);
  if (parsed || rest.trim().length > 0) {return parsed;}
  for (let j = i + 1; j < lines.length; j++) {
    const continuation = (lines[j] ?? "").trim();
    if (continuation.length === 0) {continue;}
    return parseFirstArgument(continuation);
  }
  return undefined;
}

/**
 * Parse the first argument of a Given/When/Then call. Handles:
 *   - 'single-quoted'
 *   - "double-quoted"
 *   - `template literal` (rejected when it contains `${...}` interpolation —
 *     we cannot know the runtime pattern, and a mangled matcher is worse than none)
 *   - /regex literal/flags
 */
function parseFirstArgument(rest: string): StepArg | undefined {
  const trimmed = rest.trimStart();
  if (trimmed.length === 0) {return undefined;}
  const first = trimmed[0];

  if (first === "'" || first === '"' || first === "`") {
    const m = FIRST_STRING_RE.exec(trimmed);
    const str = m?.[2];
    if (m === null || str === undefined) {return undefined;}
    if (first === "`" && /(?<!\\)\$\{/.test(str)) {return undefined;}
    return { text: str, isRegex: false, tail: trimmed.slice(m[0].length) };
  }

  if (first === "/") {
    const re = extractFirstRegex(trimmed);
    if (!re) {return undefined;}
    return { text: re.source, isRegex: true, flags: re.flags, tail: trimmed.slice(re.consumed) };
  }

  return undefined;
}

const FIRST_STRING_RE = /^(['"`])((?:\\.|(?!\1).)*)\1/;

/**
 * Pull the first quoted string from a JS/TS expression. Supports `'`, `"`, and `` ` ``
 * (no interpolation handling — template literals with `${...}` will not parse).
 */
export function extractFirstString(expr: string): string | undefined {
  const m = FIRST_STRING_RE.exec(expr);
  return m?.[2];
}

/**
 * Pull the first regex literal from a JS/TS expression. Returns the pattern source
 * (without surrounding slashes) and any flags. We preserve flags so `Given(/foo/i, …)`
 * stays case-insensitive — the `g` flag is dropped because the matcher uses .test().
 */
function extractFirstRegex(
  expr: string
): { source: string; flags: string; consumed: number } | undefined {
  // Character classes may contain unescaped `/`, so they are consumed as a unit.
  const m = /^\/((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\[\n])+)\/([dgimsuvy]*)/.exec(expr);
  if (!m?.[1]) {return undefined;}
  return { source: m[1], flags: (m[2] ?? "").replaceAll("g", ""), consumed: m[0].length };
}

const REGEX_SPECIALS_RE = /[.*+?^$|(){}[\]\\]/;

const PARAM_TYPE_SOURCES: Record<string, string> = {
  int: String.raw`-?\d+`,
  float: String.raw`-?\d*\.?\d+`,
  word: String.raw`\S+`,
  string: `(?:"[^"]*"|'[^']*')`,
};

interface LiteralChar {
  ch: string;
  escaped: boolean;
}

/**
 * Convert a Cucumber-Expression-style pattern to a regex source, following
 * cucumber-expressions semantics as used by playwright-bdd:
 *   {int}/{float} numeric, {word} non-space, {string} quoted text (quotes included),
 *   {} and {customName} as non-greedy wildcards, optional text `(s)` and
 *   alternation `a/b`. `\{`, `\(`, `\/` escape those constructs to literals.
 */
export function patternToRegexSource(pattern: string): string {
  let out = "";
  let literal: LiteralChar[] = [];
  const flush = (): void => {
    out += literalToRegex(literal);
    literal = [];
  };

  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] ?? "";
    const next = pattern[i + 1];
    if (ch === "\\" && next !== undefined && "{}()/".includes(next)) {
      literal.push({ ch: next, escaped: true });
      i += 2;
      continue;
    }
    if (ch === "{") {
      const close = pattern.indexOf("}", i + 1);
      if (close !== -1) {
        flush();
        out += PARAM_TYPE_SOURCES[pattern.slice(i + 1, close)] ?? ".+?";
        i = close + 1;
        continue;
      }
    }
    if (ch === "(") {
      const close = pattern.indexOf(")", i + 1);
      if (close !== -1) {
        flush();
        out += `(?:${escapeLiteralText(pattern.slice(i + 1, close))})?`;
        i = close + 1;
        continue;
      }
    }
    literal.push({ ch, escaped: false });
    i += 1;
  }
  flush();
  return out;
}

function literalToRegex(chars: LiteralChar[]): string {
  let out = "";
  let word: LiteralChar[] = [];
  const flushWord = (): void => {
    out += wordToRegex(word);
    word = [];
  };
  for (const c of chars) {
    if (!c.escaped && /\s/.test(c.ch)) {
      flushWord();
      out += c.ch;
      continue;
    }
    word.push(c);
  }
  flushWord();
  return out;
}

function wordToRegex(word: LiteralChar[]): string {
  if (word.length === 0) {return "";}
  const alternatives: LiteralChar[][] = [[]];
  let hasAlternation = false;
  for (const c of word) {
    if (!c.escaped && c.ch === "/") {
      hasAlternation = true;
      alternatives.push([]);
      continue;
    }
    alternatives.at(-1)?.push(c);
  }
  const escape = (cs: LiteralChar[]): string => cs.map((c) => escapeLiteralChar(c.ch)).join("");
  if (!hasAlternation) {return escape(word);}
  return `(?:${alternatives.map(escape).join("|")})`;
}

function escapeLiteralText(text: string): string {
  return Array.from(text, escapeLiteralChar).join("");
}

function escapeLiteralChar(ch: string): string {
  return REGEX_SPECIALS_RE.test(ch) ? `\\${ch}` : ch;
}

function anchorIfNeeded(pattern: string): string {
  if (pattern.startsWith("^") && endsWithUnescapedDollar(pattern)) {return pattern;}
  // Wrap in a group so top-level alternation stays inside the anchors.
  return `^(?:${pattern})$`;
}

function endsWithUnescapedDollar(pattern: string): boolean {
  if (!pattern.endsWith("$")) {return false;}
  let backslashes = 0;
  for (let i = pattern.length - 2; i >= 0 && pattern[i] === "\\"; i--) {
    backslashes += 1;
  }
  return backslashes % 2 === 0;
}

function safeCompileRegex(source: string, flags?: string): RegExp | undefined {
  try {
    return new RegExp(source, flags ?? "");
  } catch {
    return undefined;
  }
}
