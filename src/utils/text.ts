// The two one-liners every user-facing message reaches for. `many` is there for the irregulars
// ("entry"/"entries") that a trailing "s" gets wrong.
export function plural(count: number, word: string, many = `${word}s`): string {
  return count === 1 ? word : many;
}

// Two levels is as deep as undici's chains go, and the cap is also what keeps a self-referencing
// cause from looping.
const CAUSE_DEPTH = 2;

function describeCause(cause: unknown, depth: number): string | undefined {
  if (depth === 0 || cause === undefined || cause === null) {
    return undefined;
  }
  if (!(cause instanceof Error)) {
    return typeof cause === "string" && cause.trim() !== "" ? cause : undefined;
  }
  const code = (cause as { code?: unknown }).code;
  // undici reports a refused connect as an AggregateError that carries the code and an empty message;
  // the wording lives in the first error it aggregates.
  let detail = cause.message === "" ? undefined : cause.message;
  if (detail === undefined && cause instanceof AggregateError) {
    detail = describeCause(cause.errors[0], depth - 1);
  }
  const head = describeFault(typeof code === "string" ? code : undefined, detail);
  if (head === undefined) {
    return undefined;
  }
  const next = describeCause(cause.cause, depth - 1);
  return next === undefined ? head : `${head} (cause: ${next})`;
}

function describeFault(code: string | undefined, detail: string | undefined): string | undefined {
  if (code === undefined) {
    return detail;
  }
  return detail === undefined ? code : `${code}: ${detail}`;
}

// undici hangs the real transport fault (ECONNREFUSED, a cert rejection, a proxy failure) off
// `cause`, so a bare `message` reads "fetch failed" and names nothing.
export function errMsg(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = describeCause(error.cause, CAUSE_DEPTH);
  return cause === undefined ? error.message : `${error.message} (cause: ${cause})`;
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

// `max` bounds the returned string, ellipsis included, so a caller sizing a menu title or a toast
// gets the width it asked for.
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const SERVER_TEXT_MAX = 300;

// A server's own words on their way to the output channel or a message. Scrubbed before the clip so a
// truncation cannot split a token past the point the scrub pattern recognizes it.
export function serverText(text: string): string {
  return truncate(scrubJwtLike(text.trim()), SERVER_TEXT_MAX);
}

// The same text on its way to a toast, where an unusable body is worse than none: a gateway answers a
// 502 with an HTML page, so a body that opens with a tag is refused and the caller falls back to its
// status-only wording.
export function serverMessage(text: string): string | undefined {
  const message = serverText(text);
  return message === "" || message.startsWith("<") ? undefined : message;
}

function nonEmpty(value: unknown): string[] {
  return typeof value === "string" && value.trim() !== "" ? [value.trim()] : [];
}

/**
 * The human text inside an error envelope, read in the order the wire uses it: Xray's `{error}`
 * string (which carries even a Jira screen-validation rejection), Jira's `{errorMessages}` array, its
 * per-field `{errors}` object, and a plain-text body. Anything else, and any HTML page, stays
 * undefined so the caller reports the bare status.
 */
export function serverMessageOf(body: unknown): string | undefined {
  if (typeof body === "string") {
    return serverMessage(body);
  }
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const error = record["error"];
  const messages = record["errorMessages"];
  const fields = record["errors"];
  return (
    serverMessage(typeof error === "string" ? error : "") ??
    serverMessage(Array.isArray(messages) ? messages.flatMap(nonEmpty).join("; ") : "") ??
    serverMessage(
      typeof fields === "object" && fields !== null && !Array.isArray(fields)
        ? Object.entries(fields)
            .flatMap(([field, message]) => nonEmpty(message).map((text) => `${field}: ${text}`))
            .join("; ")
        : ""
    )
  );
}

// Verbatim server text can echo the request that produced it (the /authenticate body carries the
// client secret), so any credential value already in hand is masked before the text is logged.
export function maskValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    if (value !== "") {
      out = out.replaceAll(value, "[redacted]");
    }
  }
  return out;
}
