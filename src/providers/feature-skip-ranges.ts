export function computeSkipRanges(text: string): Set<number> {
  const skip = new Set<number>();
  const lines = text.split("\n");
  let docStringDelimiter: string | null = null;
  let inExamplesBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();

    if (docStringDelimiter) {
      skip.add(i);
      // A docstring closes only with the delimiter type that opened it.
      if (trimmed.startsWith(docStringDelimiter)) {docStringDelimiter = null;}
      continue;
    }

    if (trimmed.startsWith(`"""`) || trimmed.startsWith("```")) {
      skip.add(i);
      docStringDelimiter = trimmed.startsWith(`"""`) ? `"""` : "```";
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
