import { describe, it, expect, beforeEach } from "vitest";
import * as vscode from "vscode";
import { BddgenDiagnosticsProvider } from "../../providers/bddgen-diagnostics-provider";

interface MockableLanguages {
  __counters: { diagnosticCollectionCreateCount: number; diagnosticCollectionDisposeCount: number };
  __resetCounters: () => void;
}

const lang = vscode.languages as unknown as MockableLanguages;

interface CollectionProbe {
  get(uri: { toString: () => string }): vscode.Diagnostic[] | undefined;
  setCalls: Array<{ fsPath: string; diags: vscode.Diagnostic[] }>;
  clearCalls: number;
}

function probeCollection(provider: BddgenDiagnosticsProvider): CollectionProbe {
  const internals = provider as unknown as { collection: vscode.DiagnosticCollection };
  const original = internals.collection;
  const setCalls: Array<{ fsPath: string; diags: vscode.Diagnostic[] }> = [];
  let clearCalls = 0;
  const originalSet = original.set.bind(original) as (uri: vscode.Uri, diags: readonly vscode.Diagnostic[]) => void;
  const originalClear = original.clear.bind(original);
  (original as unknown as { set: typeof original.set }).set = ((uri: vscode.Uri, diags: readonly vscode.Diagnostic[]) => {
    setCalls.push({ fsPath: (uri as unknown as { fsPath: string }).fsPath, diags: [...diags] });
    originalSet(uri, diags);
  }) as typeof original.set;
  (original as unknown as { clear: () => void }).clear = (): void => {
    clearCalls += 1;
    originalClear();
  };
  return {
    get: (uri) => (original as unknown as { get: (u: { toString: () => string }) => vscode.Diagnostic[] | undefined }).get(uri),
    setCalls,
    get clearCalls() { return clearCalls; },
  };
}

describe("BddgenDiagnosticsProvider", () => {
  beforeEach(() => {
    lang.__resetCounters();
  });

  it("publishes diagnostics grouped by file when parseable errors are present", () => {
    const provider = new BddgenDiagnosticsProvider();
    const probe = probeCollection(provider);
    const output = [
      "Error parsing feature file: /repo/features/a.feature",
      "Parser errors:",
      "(2:1): bad token",
      "Error parsing feature file: /repo/features/b.feature",
      "Parser errors:",
      "(5:2): another problem",
    ].join("\n");

    provider.publish(output, "/repo");

    expect(probe.setCalls).toHaveLength(2);
    const byFs = new Map(probe.setCalls.map((c) => [c.fsPath, c.diags]));
    const aDiags = byFs.get("/repo/features/a.feature");
    const bDiags = byFs.get("/repo/features/b.feature");
    expect(aDiags).toHaveLength(1);
    expect(bDiags).toHaveLength(1);
    expect(aDiags?.[0]?.message).toBe("bad token");
    expect(aDiags?.[0]?.source).toBe("Playwright-BDD");
    expect(aDiags?.[0]?.code).toBe("bddgen-error");
    expect(aDiags?.[0]?.severity).toBe(vscode.DiagnosticSeverity.Error);
    expect(aDiags?.[0]?.range.start.line).toBe(1);
    expect(bDiags?.[0]?.message).toBe("another problem");
    expect(bDiags?.[0]?.range.start.line).toBe(4);
    provider.dispose();
  });

  it("clears previously published diagnostics on publish() with no parseable errors", () => {
    const provider = new BddgenDiagnosticsProvider();
    const probe = probeCollection(provider);
    provider.publish("Error parsing feature file: /repo/features/x.feature\nParser errors:\n(1:1): boom", "/repo");
    expect(probe.setCalls).toHaveLength(1);

    provider.publish("nothing parseable here", "/repo");

    expect(probe.clearCalls).toBeGreaterThanOrEqual(2);
    expect(probe.setCalls).toHaveLength(1);
    provider.dispose();
  });

  it("clear() empties the collection", () => {
    const provider = new BddgenDiagnosticsProvider();
    const probe = probeCollection(provider);
    provider.publish("Error parsing feature file: /repo/features/x.feature\nParser errors:\n(1:1): boom", "/repo");

    provider.clear();

    expect(probe.clearCalls).toBeGreaterThanOrEqual(2);
    provider.dispose();
  });

  it("dispose() disposes the underlying collection and becomes a no-op", () => {
    const before = lang.__counters.diagnosticCollectionDisposeCount;
    const provider = new BddgenDiagnosticsProvider();

    provider.dispose();

    expect(lang.__counters.diagnosticCollectionDisposeCount).toBe(before + 1);
    provider.publish("Error parsing feature file: /repo/features/x.feature\nParser errors:\n(1:1): boom", "/repo");
    provider.clear();
    provider.dispose();
    expect(lang.__counters.diagnosticCollectionDisposeCount).toBe(before + 1);
  });
});
