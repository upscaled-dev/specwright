const DEPTH_CAP = 6;
const ERROR_MESSAGE_CLIP = 160;

// Connection diagnostics log allowlisted information only: status, field names, value types,
// lengths/counts, and rate-limit headers (docs/requirements/traceability-integration-recommendations.md
// — truncating arbitrary values is not redaction). The type skeleton is exactly what the §5 wire-shape
// review needs; response values never reach the output channel.
export function describeShape(value: unknown, depth = 0): unknown {
  if (depth >= DEPTH_CAP) {
    return "…";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return `string(${value.length})`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return typeof value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return ["(empty)"];
    }
    const skeleton = describeShape(value[0], depth + 1);
    return value.length === 1 ? [skeleton] : [skeleton, `… ${value.length} items total`];
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = describeShape(item, depth + 1);
    }
    return out;
  }
  return typeof value;
}

// Anything shaped like a JWT (three consecutive long base64url segments) is masked before a
// diagnostic string is logged — a defense for the one place we do emit text (GraphQL error
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

// GraphQL failures arrive as HTTP 200 with an `errors` array. Error `message` and `extensions.code`
// are the diagnostic payload the connection test exists to capture (§5 marks the error shape as a
// live-verification item), so they are the deliberate exception to types-only logging: clipped and
// JWT-scrubbed, nothing else from the error object.
export function graphqlErrorSummaries(body: unknown): string[] {
  if (body === null || typeof body !== "object") {
    return [];
  }
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return [];
  }
  return errors.map((entry, index) => {
    const record = (entry ?? {}) as { message?: unknown; extensions?: { code?: unknown } };
    const message =
      typeof record.message === "string"
        ? scrubJwtLike(record.message).slice(0, ERROR_MESSAGE_CLIP)
        : "(no message)";
    const code = typeof record.extensions?.code === "string" ? ` [${record.extensions.code}]` : "";
    return `errors[${index}]${code}: ${message}`;
  });
}

// Describes a JWT for the log without ever emitting it — length and segment count are enough to
// verify the wire shape.
export function describeJwt(jwt: string): string {
  const segments = jwt.split(".").length;
  return `JWT received (length ${jwt.length}, ${segments} dot-separated segment(s), three-segment shape: ${segments === 3})`;
}
