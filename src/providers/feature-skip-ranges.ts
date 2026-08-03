import { docStringFenceState } from "../parsers/gherkin-slice";

export function computeSkipRanges(text: string): Set<number> {
  const skip = new Set<number>();
  const lines = text.split("\n");
  let docStringDelimiter: string | undefined;
  let inExamplesBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();

    const fence = docStringFenceState(docStringDelimiter, trimmed);
    docStringDelimiter = fence.fence;
    if (fence.inString) {
      skip.add(i);
      continue;
    }

    if (trimmed.length === 0) {
      skip.add(i);
      if (inExamplesBlock) {inExamplesBlock = false;}
      continue;
    }

    if (trimmed.startsWith("#")) {
      skip.add(i);
      continue;
    }

    if (trimmed.startsWith("|")) {
      skip.add(i);
      continue;
    }

    if (/^Examples\s*:/.test(trimmed)) {
      skip.add(i);
      inExamplesBlock = true;
      continue;
    }

    if (inExamplesBlock) {
      if (isGherkinSectionKeyword(trimmed)) {
        inExamplesBlock = false;
      } else {
        skip.add(i);
        continue;
      }
    }
  }

  return skip;
}

const SECTION_KEYWORDS_RE =
  /^(Feature|Scenario Outline|Scenario Template|Scenario|Background|Rule|Given|When|Then|And|But|\*|@)/;

function isGherkinSectionKeyword(trimmed: string): boolean {
  return SECTION_KEYWORDS_RE.test(trimmed);
}
