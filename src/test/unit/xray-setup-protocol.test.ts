import { describe, expect, it } from "vitest";
import { parseClientEnvelope } from "../../webview/protocol";
import {
  isSetupHostEnvelope,
  parseSetupClientEnvelope,
  type SetupEnvelope,
  type SetupHostMessage,
} from "../../webview/setup-protocol";

const DOCUMENT = "1".repeat(32);
const PREVIOUS_DOCUMENT = "2".repeat(32);

function client(body: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    session: "session-1",
    document: DOCUMENT,
    revision: 0,
    surface: "setup",
    body,
    ...overrides,
  };
}

function save(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "save",
    site: "acme.atlassian.net",
    region: "global",
    clientId: "id",
    clientSecret: "secret",
    jiraEmail: "",
    jiraToken: "",
    test: true,
    ...overrides,
  };
}

function host(body: SetupHostMessage, revision = 1): SetupEnvelope<SetupHostMessage> {
  return { version: 1, session: "session-1", document: DOCUMENT, revision, surface: "setup", body };
}

describe("Xray setup webview protocol", () => {
  it("accepts only exact bounded setup save and ready envelopes", () => {
    expect(parseSetupClientEnvelope(client({ type: "ready" }))).toBeDefined();
    expect(parseSetupClientEnvelope(client({ type: "ready", previousDocument: PREVIOUS_DOCUMENT }))).toBeDefined();
    expect(parseSetupClientEnvelope(client({ type: "ready", previousDocument: "x".repeat(129) }))).toBeUndefined();
    expect(parseSetupClientEnvelope(client(save()))).toBeDefined();
    expect(parseSetupClientEnvelope(client({ ...save(), extra: true }))).toBeUndefined();
    expect(parseSetupClientEnvelope(client(save({ region: "moon" })))).toBeUndefined();
    expect(parseSetupClientEnvelope(client(save({ clientSecret: "x".repeat(8_193) })))).toBeUndefined();
    expect(parseSetupClientEnvelope(client(save(), { version: 2 }))).toBeUndefined();
    expect(parseSetupClientEnvelope(client(save(), { surface: "board" }))).toBeUndefined();
  });

  it("keeps setup isolated from the board surface router", () => {
    expect(parseClientEnvelope(client({ type: "ready" }))).toBeUndefined();
  });

  it("accepts only current-session, increasing, fully validated host messages", () => {
    const valid = host({ type: "saved", site: "acme.atlassian.net", region: "au", jira: true }, 3);
    expect(isSetupHostEnvelope(valid, "session-1", DOCUMENT, 2)).toBe(true);
    expect(isSetupHostEnvelope(valid, "foreign", DOCUMENT, 2)).toBe(false);
    expect(isSetupHostEnvelope(valid, "session-1", "f".repeat(32), 2)).toBe(false);
    expect(isSetupHostEnvelope(valid, "session-1", DOCUMENT, 3)).toBe(false);
    expect(isSetupHostEnvelope({ ...valid, version: 2 }, "session-1", DOCUMENT, 2)).toBe(false);
    expect(isSetupHostEnvelope(
      { ...valid, body: { ...valid.body, secret: "echo" } },
      "session-1",
      DOCUMENT,
      2
    )).toBe(false);
    expect(isSetupHostEnvelope(host({
      type: "form-state",
      site: "acme.atlassian.net",
      region: "au",
      credentials: true,
      jira: false,
    }), "session-1", DOCUMENT, 0)).toBe(true);
    expect(isSetupHostEnvelope(host({
      type: "form-state",
      site: "x".repeat(513),
      region: "au",
      credentials: true,
      jira: false,
    }), "session-1", DOCUMENT, 0)).toBe(false);
  });

  it("bounds host project collections and nested text before DOM mutation", () => {
    const projects = Array.from({ length: 201 }, (_, index) => ({ key: `P${index}`, name: `Project ${index}` }));
    const body: SetupHostMessage = {
      type: "project-view",
      hasJira: true,
      jiraProjects: projects,
      jiraTruncated: true,
      probed: [],
    };
    expect(isSetupHostEnvelope(host(body), "session-1", DOCUMENT, 0)).toBe(false);
    expect(isSetupHostEnvelope(
      host({ ...body, jiraProjects: projects.slice(0, 200) }),
      "session-1",
      DOCUMENT,
      0
    )).toBe(true);
    expect(isSetupHostEnvelope(host({
      ...body,
      jiraProjects: [{ key: "CALC", name: "x".repeat(513) }],
    }), "session-1", DOCUMENT, 0)).toBe(false);
  });

  it("rejects sparse and inherited-hole project collections", () => {
    const sparseJira = new Array<{ key: string; name: string }>(1);
    const inheritedProbed = new Array<{ project: string; totalTests: number }>(1);
    const prototype = Object.create(Array.prototype) as Record<number, unknown>;
    prototype[0] = { project: "CALC", totalTests: 1 };
    Object.setPrototypeOf(inheritedProbed, prototype);
    const body = {
      type: "project-view" as const,
      hasJira: true,
      jiraProjects: sparseJira,
      jiraTruncated: false,
      probed: [],
    };

    expect(isSetupHostEnvelope(host(body), "session-1", DOCUMENT, 0)).toBe(false);
    expect(isSetupHostEnvelope(
      host({ ...body, jiraProjects: [], probed: inheritedProbed }),
      "session-1",
      DOCUMENT,
      0
    )).toBe(false);
  });
});
