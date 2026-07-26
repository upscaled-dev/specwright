// The two one-liners every user-facing message reaches for. `many` is there for the irregulars
// ("entry"/"entries") that a trailing "s" gets wrong.
export function plural(count: number, word: string, many = `${word}s`): string {
  return count === 1 ? word : many;
}

export function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
