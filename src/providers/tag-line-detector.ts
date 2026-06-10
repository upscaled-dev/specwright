import { TAG_TOKEN_PATTERN } from "../parsers/tag-regex";

export interface TagLineContext {
  partial: string;
  tokenStart: number;
}

const TAG_LINE_RE = new RegExp(String.raw`^\s*(?:${TAG_TOKEN_PATTERN}\s+)*@([^\s@,]*)$`);

export function detectTagToken(lineUpToCursor: string): TagLineContext | undefined {
  const match = TAG_LINE_RE.exec(lineUpToCursor);
  if (!match) {return undefined;}
  const partial = match[1] ?? "";
  const tokenStart = lineUpToCursor.length - 1 - partial.length;
  return { partial, tokenStart };
}
