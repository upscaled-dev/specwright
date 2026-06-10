import { describe, it, expect, beforeEach } from "vitest";
import * as vscode from "vscode";
import { BreakpointMirror } from "../../core/breakpoint-mirror";

interface StatefulDebug {
  breakpoints: vscode.Breakpoint[];
  __fireTerminate: (session: unknown) => void;
  __resetDebug: () => void;
}

const debugApi = vscode.debug as unknown as StatefulDebug;

const FEATURE = "/work/features/background.feature";
const SPEC = "/work/.features-gen/features/background.feature.spec.js";

const specText = `const bddFileData = [ // bdd-data-start
  {"pwTestLine":11,"pickleLine":8,"steps":[{"pwStepLine":7,"gherkinStepLine":5},{"pwStepLine":12,"gherkinStepLine":9},{"pwStepLine":13,"gherkinStepLine":10}]},
  {"pwTestLine":19,"pickleLine":13,"steps":[{"pwStepLine":7,"gherkinStepLine":5},{"pwStepLine":20,"gherkinStepLine":14}]},
]; // bdd-data-end`;

function featureBreakpoint(
  gherkinLine: number,
  extras: { enabled?: boolean; condition?: string; hitCondition?: string; logMessage?: string } = {}
): vscode.SourceBreakpoint {
  return new vscode.SourceBreakpoint(
    new vscode.Location(vscode.Uri.file(FEATURE), new vscode.Position(gherkinLine - 1, 0)),
    extras.enabled ?? true,
    extras.condition,
    extras.hitCondition,
    extras.logMessage
  );
}

function makeMirror(read: () => string | undefined = () => specText): BreakpointMirror {
  return BreakpointMirror.create(vscode.debug, read);
}

function mirroredLines(): number[] {
  return debugApi.breakpoints
    .filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint)
    .filter((bp) => bp.location.uri.fsPath === SPEC)
    .map((bp) => bp.location.range.start.line)
    .sort((a, b) => a - b);
}

describe("BreakpointMirror", () => {
  beforeEach(() => {
    debugApi.__resetDebug();
  });

  it("mirrors a feature step breakpoint onto the generated spec line", () => {
    debugApi.breakpoints.push(featureBreakpoint(9));
    const mirror = makeMirror();
    const id = mirror.mirrorBreakpoints(FEATURE, SPEC);
    expect(id).toBeDefined();
    expect(mirroredLines()).toEqual([11]);
  });

  it("maps a Scenario: line breakpoint to the test() line", () => {
    debugApi.breakpoints.push(featureBreakpoint(8));
    const mirror = makeMirror();
    expect(mirror.mirrorBreakpoints(FEATURE, SPEC)).toBeDefined();
    expect(mirroredLines()).toEqual([10]);
  });

  it("skips unmapped feature lines silently and returns undefined when nothing maps", () => {
    debugApi.breakpoints.push(featureBreakpoint(99));
    const mirror = makeMirror();
    expect(mirror.mirrorBreakpoints(FEATURE, SPEC)).toBeUndefined();
    expect(mirroredLines()).toEqual([]);
  });

  it("copies condition, hitCondition, and logMessage onto the mirror", () => {
    debugApi.breakpoints.push(
      featureBreakpoint(9, { condition: "x > 1", hitCondition: "3", logMessage: "hit!" })
    );
    const mirror = makeMirror();
    mirror.mirrorBreakpoints(FEATURE, SPEC);
    const mirrored = debugApi.breakpoints.find(
      (bp): bp is vscode.SourceBreakpoint =>
        bp instanceof vscode.SourceBreakpoint && bp.location.uri.fsPath === SPEC
    );
    expect(mirrored?.condition).toBe("x > 1");
    expect(mirrored?.hitCondition).toBe("3");
    expect(mirrored?.logMessage).toBe("hit!");
  });

  it("does not duplicate a user breakpoint already on the target spec line", () => {
    debugApi.breakpoints.push(
      featureBreakpoint(9),
      new vscode.SourceBreakpoint(
        new vscode.Location(vscode.Uri.file(SPEC), new vscode.Position(11, 0))
      )
    );
    const mirror = makeMirror();
    expect(mirror.mirrorBreakpoints(FEATURE, SPEC)).toBeUndefined();
    expect(mirroredLines()).toEqual([11]);
  });

  it("removes only the terminated session's mirrors", () => {
    debugApi.breakpoints.push(featureBreakpoint(9));
    const mirror = makeMirror();
    const firstId = mirror.mirrorBreakpoints(FEATURE, SPEC);

    debugApi.breakpoints = debugApi.breakpoints.filter(
      (bp) =>
        !(bp instanceof vscode.SourceBreakpoint && bp.location.uri.fsPath === FEATURE)
    );
    debugApi.breakpoints.push(featureBreakpoint(14));
    const secondId = mirror.mirrorBreakpoints(FEATURE, SPEC);
    expect(mirroredLines()).toEqual([11, 19]);

    debugApi.__fireTerminate({ configuration: { [BreakpointMirror.SESSION_KEY]: firstId } });
    expect(mirroredLines()).toEqual([19]);

    debugApi.__fireTerminate({ configuration: { [BreakpointMirror.SESSION_KEY]: secondId } });
    expect(mirroredLines()).toEqual([]);
  });

  it("keeps a shared spec line alive until every session referencing it terminates", () => {
    // gherkin line 5 is a Background step mapped to pwStepLine 7 in BOTH scenario entries, so
    // two concurrent sessions claim the same spec line.
    debugApi.breakpoints.push(featureBreakpoint(5));
    const mirror = makeMirror();
    const firstId = mirror.mirrorBreakpoints(FEATURE, SPEC);
    const secondId = mirror.mirrorBreakpoints(FEATURE, SPEC);
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);
    expect(mirroredLines()).toEqual([6]);

    debugApi.__fireTerminate({ configuration: { [BreakpointMirror.SESSION_KEY]: firstId } });
    expect(mirroredLines()).toEqual([6]);

    debugApi.__fireTerminate({ configuration: { [BreakpointMirror.SESSION_KEY]: secondId } });
    expect(mirroredLines()).toEqual([]);
  });

  it("ignores terminated sessions without the mirror id (node-terminal children)", () => {
    debugApi.breakpoints.push(featureBreakpoint(9));
    const mirror = makeMirror();
    mirror.mirrorBreakpoints(FEATURE, SPEC);

    debugApi.__fireTerminate({ configuration: { type: "pwa-node" } });
    expect(mirroredLines()).toEqual([11]);
  });

  it("release() removes the mirror's breakpoints immediately", () => {
    debugApi.breakpoints.push(featureBreakpoint(9));
    const mirror = makeMirror();
    const id = mirror.mirrorBreakpoints(FEATURE, SPEC);
    mirror.release(id!);
    expect(mirroredLines()).toEqual([]);
  });

  it("dispose() removes all still-tracked mirrors", () => {
    debugApi.breakpoints.push(featureBreakpoint(9), featureBreakpoint(14));
    const mirror = makeMirror();
    mirror.mirrorBreakpoints(FEATURE, SPEC);
    expect(mirroredLines()).toEqual([11, 19]);
    mirror.dispose();
    expect(mirroredLines()).toEqual([]);
  });

  it("returns undefined when the spec is unreadable or unparseable", () => {
    debugApi.breakpoints.push(featureBreakpoint(9));
    expect(makeMirror(() => undefined).mirrorBreakpoints(FEATURE, SPEC)).toBeUndefined();
    expect(makeMirror(() => "no markers here").mirrorBreakpoints(FEATURE, SPEC)).toBeUndefined();
    expect(mirroredLines()).toEqual([]);
  });
});
