// The two one-liners every user-facing message reaches for. `many` is there for the irregulars
// ("entry"/"entries") that a trailing "s" gets wrong.
export function plural(count: number, word: string, many = `${word}s`): string {
  return count === 1 ? word : many;
}

export function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Anything shaped like a JWT (three consecutive long base64url segments) is masked before a
// diagnostic string is logged, a defense for the one place we do emit text (GraphQL error
// messages). Single-quantifier regex; the segment-shape check lives in code to stay linear.
const TOKEN_RUN = /[A-Za-z0-9_.-]+/g;
const JWT_SEGMENT_MIN = 8;

function isJwtLike(run: string): boolean {
  const segments = run.split(".");
  for (let i = 0; i + 2 < segments.length; i++) {
    if (
      (segments[i] ?? "").length >= JWT_SEGMENT_MIN &&
      (segments[i + 1] ?? "").length >= JWT_SEGMENT_MIN &&
      (segments[i + 2] ?? "").length >= JWT_SEGMENT_MIN
    ) {
      return true;
    }
  }
  return false;
}

export function scrubJwtLike(text: string): string {
  return text.replace(TOKEN_RUN, (run) => (isJwtLike(run) ? "[jwt-like-token]" : run));
}
