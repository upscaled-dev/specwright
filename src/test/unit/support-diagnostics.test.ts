import { describe, expect, it } from "vitest";
import { SupportDiagnostics } from "../../core/support-diagnostics";

describe("SupportDiagnostics", () => {
  it("retains only redacted, bounded values", () => {
    const diagnostics = new SupportDiagnostics();
    const loop: Record<string, unknown> = { token: "secret", path: "/Users/me/project/file.feature" };
    loop["self"] = loop;
    diagnostics.record("error", "Bearer abcdefghijklmnopqrstuvwxyz /Users/me/file C:\\work\\file file:///tmp/a eyJabcdefgh.abcdefgh.abcdefgh", {
      password: "nope", loop, binary: new Uint8Array(2048), deep: { a: { b: { c: { d: { e: { f: { g: "end" } } } } } } },
    });
    const snapshot = diagnostics.snapshot({ extensionVersion: "1.0.0", configuration: [{ properties: { "x.value": { type: "string", default: "secret" } } }] });
    expect(JSON.stringify(diagnostics.retainedRecords())).not.toContain("secret");
    expect(JSON.stringify(diagnostics.retainedRecords())).not.toContain("/Users/me");
    expect(snapshot).not.toContain("secret");
    expect(snapshot).not.toContain("/Users/me");
    expect(snapshot).not.toContain("C:\\work");
    expect(snapshot).not.toContain("file:///tmp");
    expect(snapshot).toContain('"configurationSchema"');
    expect(snapshot).not.toContain('"default"');
  });

  it("caps retained records and releases them on disposal", () => {
    const diagnostics = new SupportDiagnostics();
    for (let index = 0; index < 150; index++) { diagnostics.record("info", `event ${index}`); }
    const before = diagnostics.snapshot({ extensionVersion: "1", configuration: [] });
    expect((JSON.parse(before) as { logs: unknown[] }).logs.length).toBeLessThanOrEqual(100);
    diagnostics.dispose();
    expect((JSON.parse(diagnostics.snapshot({ extensionVersion: "1", configuration: [] })) as { logs: unknown[] }).logs).toEqual([]);
  });

  it("keeps Unicode and oversized snapshots within the advertised byte cap", () => {
    const diagnostics = new SupportDiagnostics();
    for (let index = 0; index < 150; index++) { diagnostics.record("info", "🙂".repeat(10_000)); }
    const snapshot = diagnostics.snapshot({ extensionVersion: "🙂".repeat(100_000), configuration: [] });
    const parsed = JSON.parse(snapshot) as { truncation: { snapshotBytes: number; droppedRecords: number } };
    expect(Buffer.byteLength(snapshot)).toBeLessThanOrEqual(64 * 1024);
    expect(parsed.truncation.snapshotBytes).toBe(Buffer.byteLength(snapshot));
    expect(parsed.truncation.droppedRecords).toBeGreaterThan(0);
  });

  it("caps schema entries across malformed configuration groups", () => {
    const diagnostics = new SupportDiagnostics();
    const configuration = Array.from({ length: 100 }, (_unused, group) => ({
      properties: { [`setting.${group}`]: { type: "🙂".repeat(10_000), scope: "workspace" } },
    }));
    const snapshot = diagnostics.snapshot({ extensionVersion: "1", configuration });
    const parsed = JSON.parse(snapshot) as { configurationSchema: unknown[]; truncation: { snapshotBytes: number } };
    expect(parsed.configurationSchema.length).toBeLessThanOrEqual(40);
    expect(parsed.truncation.snapshotBytes).toBe(Buffer.byteLength(snapshot));
    expect(Buffer.byteLength(snapshot)).toBeLessThanOrEqual(64 * 1024);
  });

  it("fails closed for credentials, unsafe details, paths, and hostile values", () => {
    const diagnostics = new SupportDiagnostics();
    const secret = "eyJabcdefgh.abcdefgh.abcdefgh";
    const hostile = new Proxy({ inherited: "ignored", value: 1n }, { get: () => { throw new Error("Bearer top-secret"); } });
    diagnostics.record("error", `response body Bearer ${secret} \\server\\share C:\\dir\\a /single file:///tmp/a me@example.com`, {
      authorization: `Basic ${secret}`, payload: "raw", safe: hostile, deep: { a: { b: { c: { d: { e: { f: "too deep" } } } } } },
    });
    const retained = JSON.stringify(diagnostics.retainedRecords());
    expect(retained).not.toContain(secret);
    expect(retained).not.toContain("me@example.com");
    expect(retained).not.toContain("server\\share");
    expect(retained).not.toContain("raw");
    expect(retained).toContain("redacted-detail");
  });

  it("redacts dotted bearer values, whitespace paths, and unsafe detail fields", () => {
    const diagnostics = new SupportDiagnostics();
    const bearer = "aaaaaaaa.bbbbbbbb.cccccccc";
    diagnostics.record("info", `Bearer ${bearer} /Users/me/a feature \\server\\shared folder`, {
      detail: "arbitrary server response value",
      message: "completed test run",
      completion: { detail: "completed opaque provider suffix" },
      nested: { message: "untrusted payload bytes" },
    });

    const retained = JSON.stringify(diagnostics.retainedRecords());
    expect(retained).not.toContain(bearer);
    expect(retained).not.toContain("/Users/me/a feature");
    expect(retained).not.toContain("server\\shared folder");
    expect(retained).not.toContain("arbitrary server response value");
    expect(retained).not.toContain("untrusted payload bytes");
    expect(retained).not.toContain("test run");
    expect(retained).not.toContain("opaque provider suffix");
    expect(retained).toContain('"completed"');
  });

  it("shares the entry budget across nested values", () => {
    const diagnostics = new SupportDiagnostics();
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 45; index++) { wide[`entry${index}`] = index; }
    diagnostics.record("info", "completed", wide);

    const retained = diagnostics.retainedRecords()[0]?.data as Record<string, unknown>;
    expect(retained).toHaveProperty("[truncated]", "[entry-budget]");
  });

  it("fails closed for opaque error values and error fields", () => {
    const diagnostics = new SupportDiagnostics();
    const secret = "opaque upstream error payload";
    diagnostics.record("error", "failed", {
      error: new Error(secret),
      nested: { error: { message: secret } },
    });
    diagnostics.record("error", "failed", new Error(secret));

    const retained = JSON.stringify(diagnostics.retainedRecords());
    expect(retained).not.toContain(secret);
    expect(retained).toContain("[redacted-error]");
    expect(retained).toContain("[redacted-key]");
  });

  it("contains revoked configuration proxies and preserves valid bounded JSON", () => {
    const diagnostics = new SupportDiagnostics();
    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();

    const snapshot = diagnostics.snapshot({ extensionVersion: "1", configuration: proxy });
    const parsed = JSON.parse(snapshot) as { configurationSchema: unknown[]; truncation: { schemaTruncated: boolean; knownSkippedSchemaNodes: number; snapshotBytes: number } };
    expect(parsed.configurationSchema).toEqual([]);
    expect(parsed.truncation.schemaTruncated).toBe(true);
    expect(parsed.truncation.knownSkippedSchemaNodes).toBeGreaterThan(0);
    expect(parsed.truncation.snapshotBytes).toBe(Buffer.byteLength(snapshot));
    expect(Buffer.byteLength(snapshot)).toBeLessThanOrEqual(64 * 1024);
  });

  it("shares the schema budget across groups and reports known skipped groups", () => {
    const diagnostics = new SupportDiagnostics();
    const configuration = Array.from({ length: 30 }, (_unused, index) => ({
      properties: { [`setting.${index}`]: { type: "string" } },
    }));

    const snapshot = diagnostics.snapshot({ extensionVersion: "1", configuration });
    const parsed = JSON.parse(snapshot) as { configurationSchema: unknown[]; truncation: { schemaTruncated: boolean; knownSkippedSchemaNodes: number } };
    expect(parsed.configurationSchema).toHaveLength(20);
    expect(parsed.truncation.schemaTruncated).toBe(true);
    expect(parsed.truncation.knownSkippedSchemaNodes).toBe(1);
  });

  it("retains only an explicit category for dynamic top-level messages", () => {
    const diagnostics = new SupportDiagnostics();
    const opaque = "upstream response carries an unclassified value";
    diagnostics.record("warn", opaque);
    diagnostics.record("info", "Legacy execution lifecycle");

    const retained = diagnostics.retainedRecords();
    expect(JSON.stringify(retained)).not.toContain(opaque);
    expect(retained.map((record) => record.message)).toEqual(["operational-event", "execution-lifecycle"]);
  });

  it("normalizes hostile runtime levels", () => {
    const diagnostics = new SupportDiagnostics();
    diagnostics.record("credential=opaque" as string, "event");
    expect(diagnostics.retainedRecords()[0]?.level).toBe("unknown");
    expect(JSON.stringify(diagnostics.retainedRecords())).not.toContain("credential=opaque");
  });

  it("fails closed before inherited object and schema keys can be traversed", () => {
    const inherited = Object.fromEntries(Array.from({ length: 100 }, (_unused, index) => [`inherited${index}`, index]));
    let objectChecks = 0;
    const object = new Proxy(Object.create(inherited), {
      getOwnPropertyDescriptor: () => { objectChecks += 1; return undefined; },
    });
    const diagnostics = new SupportDiagnostics();
    diagnostics.record("info", "completed", object);
    expect(objectChecks).toBe(0);

    let schemaChecks = 0;
    const properties = new Proxy(Object.create(inherited), {
      getOwnPropertyDescriptor: () => { schemaChecks += 1; return undefined; },
    });
    diagnostics.snapshot({ extensionVersion: "1", configuration: [{ properties }] });
    expect(schemaChecks).toBe(0);
  });

  it("does not count sparse or inherited schema candidates as known skipped nodes", () => {
    const groups = new Array(100);
    for (let index = 0; index < 40; index++) { groups[index] = {}; }
    Object.setPrototypeOf(groups, Object.create(Array.prototype, {
      inherited: { enumerable: true, value: {} },
    }));
    const diagnostics = new SupportDiagnostics();
    const snapshot = diagnostics.snapshot({ extensionVersion: "1", configuration: groups });
    const parsed = JSON.parse(snapshot) as { truncation: { schemaTruncated: boolean; knownSkippedSchemaNodes: number } };
    expect(parsed.truncation.schemaTruncated).toBe(true);
    expect(parsed.truncation.knownSkippedSchemaNodes).toBe(0);
  });

  it("redacts ordinary data keys and foreign schema keys", () => {
    const diagnostics = new SupportDiagnostics();
    const warning = "opaque provider warning with credential-like text";
    diagnostics.record("warn", "provider warning", {
      warnings: warning,
      providerCount: 97,
      nested: { value: "must not traverse" },
    });
    const oversized = `playwrightBddRunner.${"a".repeat(600)}`;
    const snapshot = diagnostics.snapshot({
      extensionVersion: "1",
      configuration: [{ properties: {
        "playwrightBddRunner.xray.apiRegion": { type: "string", scope: "resource" },
        "foreign.opaque.key": { type: "string", scope: "resource" },
        [oversized]: { type: "string", scope: "resource" },
      } }],
    });
    const parsed = JSON.parse(snapshot) as { configurationSchema: Array<{ key: string }> };
    const retained = JSON.stringify(diagnostics.retainedRecords());
    expect(retained).not.toContain(warning);
    expect(retained).not.toContain("warnings");
    expect(retained).not.toContain("97");
    expect(retained).not.toContain("must not traverse");
    expect(parsed.configurationSchema.map((entry) => entry.key)).toEqual([
      "playwrightBddRunner.xray.apiRegion",
      "[redacted-key]",
      "[redacted-key]",
    ]);
  });

  it("retains only validated lifecycle and remote fields", () => {
    const diagnostics = new SupportDiagnostics();
    const operationId = "11111111-2222-4333-8444-555555555555";
    const artifactId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    diagnostics.record("info", "Legacy execution lifecycle", {
      operationId,
      artifactId,
      operation: "xray.authenticate",
      engine: "core-client",
      schemaProfile: "client-v1",
      mode: "run",
      state: "complete",
      outcomeCertainty: "confirmed",
      captureState: "captured",
      initiatedBy: "test-explorer",
      operationClass: "read",
      attempt: 1,
      durationMs: 12,
      cancelled: false,
    });
    diagnostics.record("info", "Legacy execution lifecycle", {
      operationId: "not-a-uuid",
      artifactId: "artifact-1",
      operation: "unknown.remote.operation",
      engine: "legacy-direct-ish",
      schemaProfile: "custom-v1",
      state: "invented",
    });

    const [accepted, rejected] = diagnostics.retainedRecords().map((record) => record.data as Record<string, unknown>);
    expect(accepted).toMatchObject({
      operationId,
      artifactId,
      operation: "xray.authenticate",
      engine: "core-client",
      schemaProfile: "client-v1",
      attempt: 1,
      durationMs: 12,
      cancelled: false,
    });
    expect(rejected).toEqual({
      operationId: "[redacted]",
      artifactId: "[redacted]",
      operation: "[redacted]",
      engine: "[redacted]",
      schemaProfile: "[redacted]",
      state: "[redacted]",
    });
  });

  it("redacts wrong scalar kinds for allowed lifecycle and remote fields before traversal", () => {
    const diagnostics = new SupportDiagnostics();
    const secret = "nested payload must not survive";
    diagnostics.record("info", "Legacy execution lifecycle", {
      operation: { token: secret },
      operationId: null,
      artifactId: new Uint8Array([1, 2, 3]),
      engine: ["core-client"],
      schemaProfile: false,
      attempt: "1",
      backoffMs: { value: 1 },
      durationMs: null,
      cancelled: "false",
      message: { detail: secret },
      detail: [secret],
    });

    const retained = diagnostics.retainedRecords()[0]?.data;
    expect(retained).toEqual({
      operation: "[redacted]",
      operationId: "[redacted]",
      artifactId: "[redacted]",
      engine: "[redacted]",
      schemaProfile: "[redacted]",
      attempt: "[redacted]",
      backoffMs: "[redacted]",
      durationMs: "[redacted]",
      cancelled: "[redacted]",
      message: "[redacted]",
      detail: "[redacted]",
    });
    expect(JSON.stringify(retained)).not.toContain(secret);
  });
});
