import { describe, expect, it } from "vitest";
import {
  TRACEABILITY_CHUNK_BYTES,
  TRACEABILITY_DISPLAY_TEXT_LIMIT,
  TRACEABILITY_PREVIEW_MEMBER_LIMIT,
  TRACEABILITY_SELECTION_LIMIT,
  TRACEABILITY_VIEW_PROTOCOL_VERSION,
  parseTraceabilityClientEnvelope,
  parseTraceabilityHostEnvelope,
} from "../../webview/traceability-view-protocol";

function message(body: object, overrides: Record<string, unknown> = {}): object {
  return {
    version: TRACEABILITY_VIEW_PROTOCOL_VERSION,
    session: "trace-session",
    revision: 3,
    surface: "traceability",
    body,
    ...overrides,
  };
}

describe("traceability view protocol", () => {
  it("admits only exact bounded ready, focus, and action envelopes", () => {
    expect(parseTraceabilityClientEnvelope(message({ type: "ready" }))).toBeDefined();
    expect(parseTraceabilityClientEnvelope(message({ type: "focused", generation: 2 }))).toBeDefined();
    expect(parseTraceabilityClientEnvelope(message({ type: "confirm-preview", generation: 2, previewId: "opaque" }))).toBeDefined();
    expect(parseTraceabilityClientEnvelope(message({ type: "confirm-preview", generation: 2, previewId: "opaque", memberKeys: ["SHOP-1"] }))).toBeUndefined();
    expect(parseTraceabilityClientEnvelope(message({ type: "action", generation: 2, id: "row", action: "open", selection: ["row"] }))).toBeDefined();
    const maximumSelection = message({ type: "action", generation: 2, id: "row", action: "open", selection: Array(TRACEABILITY_SELECTION_LIMIT).fill("x".repeat(512)) });
    expect(new TextEncoder().encode(JSON.stringify(maximumSelection)).length).toBeLessThan(TRACEABILITY_CHUNK_BYTES);
    expect(parseTraceabilityClientEnvelope(maximumSelection)).toBeDefined();
    expect(parseTraceabilityClientEnvelope(message({ type: "action", generation: 2, id: "row", action: "open", selection: Array(TRACEABILITY_SELECTION_LIMIT + 1).fill("row") }))).toBeUndefined();
    expect(parseTraceabilityClientEnvelope(message({ type: "action", generation: -1, id: "row", action: "open", selection: [] }))).toBeUndefined();
    expect(parseTraceabilityClientEnvelope(message({ type: "ready", extra: true }))).toBeUndefined();
  });

  it("rejects foreign and oversized input before it reaches the host", () => {
    expect(parseTraceabilityClientEnvelope(message({ type: "ready" }, { version: 1 }))).toBeUndefined();
    expect(parseTraceabilityClientEnvelope(message({ type: "ready" }, { surface: "board" }))).toBeUndefined();
    expect(parseTraceabilityClientEnvelope(message({ type: "action", generation: 2, id: "x".repeat(2_049), action: "open", selection: [] }))).toBeUndefined();
  });

  it("validates exact bounded host chunks before the browser commits them", () => {
    const begin = { version: TRACEABILITY_VIEW_PROTOCOL_VERSION, session: "trace-session", revision: 1, surface: "traceability", body: { type: "begin", generation: 1, state: "ready", total: 1 } };
    expect(parseTraceabilityHostEnvelope(begin, "trace-session", 0)).toBeDefined();
    expect(parseTraceabilityHostEnvelope({ ...begin, body: { ...begin.body, state: "broken" } }, "trace-session", 0)).toBeUndefined();
    const row = { id: "row", label: "row", icon: "circle", expandable: false, actions: [] };
    expect(parseTraceabilityHostEnvelope({ ...begin, revision: 2, body: { type: "chunk", generation: 1, offset: 0, rows: [row] } }, "trace-session", 1)).toBeDefined();
    expect(parseTraceabilityHostEnvelope({ ...begin, revision: 2, body: { type: "chunk", generation: 1, offset: 0, rows: Array(257).fill(row) } }, "trace-session", 1)).toBeUndefined();
    expect(parseTraceabilityHostEnvelope({ ...begin, revision: 3 }, "trace-session", 1)).toBeUndefined();
    const unicode = { ...row, label: "😀".repeat(2_048) };
    expect(parseTraceabilityHostEnvelope({ ...begin, revision: 2, body: { type: "chunk", generation: 1, offset: 0, rows: Array(128).fill(unicode) } }, "trace-session", 1)).toBeUndefined();
    expect(parseTraceabilityHostEnvelope({ ...begin, revision: 2, body: { type: "chunk", generation: 1, offset: 0, rows: [{ ...row, icon: "bad icon" }] } }, "trace-session", 1)).toBeUndefined();
    const preview = { previewId: "opaque", title: "SHOP-301", remoteMembers: 4, runnable: 3, remoteOnly: 1, members: [{ label: "SHOP-101", mapped: true }], displayTruncated: false };
    expect(parseTraceabilityHostEnvelope({ ...begin, revision: 2, body: { type: "preview", generation: 1, preview } }, "trace-session", 1)).toBeDefined();
    const maximumPreview = { ...preview, title: "t".repeat(TRACEABILITY_DISPLAY_TEXT_LIMIT), members: Array(TRACEABILITY_PREVIEW_MEMBER_LIMIT).fill({ label: "m".repeat(TRACEABILITY_DISPLAY_TEXT_LIMIT), mapped: true }) };
    const maximumEnvelope = { ...begin, revision: 2, body: { type: "preview", generation: 1, preview: maximumPreview } };
    expect(new TextEncoder().encode(JSON.stringify(maximumEnvelope)).length).toBeLessThan(TRACEABILITY_CHUNK_BYTES);
    expect(parseTraceabilityHostEnvelope(maximumEnvelope, "trace-session", 1)).toBeDefined();
    expect(parseTraceabilityHostEnvelope({ ...begin, revision: 2, body: { type: "preview", generation: 1, preview: { ...preview, members: Array(TRACEABILITY_PREVIEW_MEMBER_LIMIT + 1).fill(preview.members[0]) } } }, "trace-session", 1)).toBeUndefined();
    expect(parseTraceabilityHostEnvelope({ ...begin, revision: 2, body: { type: "preview", generation: 1, preview: { ...preview, title: "x".repeat(TRACEABILITY_CHUNK_BYTES) } } }, "trace-session", 1)).toBeUndefined();
  });
});
