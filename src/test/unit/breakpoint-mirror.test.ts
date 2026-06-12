import { describe, it, expect, beforeEach } from "vitest";
import * as vscode from "vscode";
import { BreakpointMirror } from "../../core/breakpoint-mirror";

interface StatefulDebug {
  breakpoints: vscode.Breakpoint[];
  __stopDebuggingCalls: unknown[];
  __fireStart: (session: unknown) => void;
  __fireTerminate: (session: unknown) => void;
  __resetDebug: () => void;
}

const debugApi = vscode.debug as unknown as StatefulDebug;

interface TrackedSession {
  id: string;
  configuration: Record<string, unknown>;
  parentSession?: TrackedSession;
}

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

  it("skips unmapped feature lines silently but still tracks an id when nothing maps", () => {
    debugApi.breakpoints.push(featureBreakpoint(99));
    const mirror = makeMirror();
    expect(mirror.mirrorBreakpoints(FEATURE, SPEC)).toBeDefined();
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
    expect(mirror.mirrorBreakpoints(FEATURE, SPEC)).toBeDefined();
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
    mirror.release(id);
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

  it("still tracks an id when the spec is unreadable or unparseable", () => {
    debugApi.breakpoints.push(featureBreakpoint(9));
    expect(makeMirror(() => undefined).mirrorBreakpoints(FEATURE, SPEC)).toBeDefined();
    expect(makeMirror(() => "no markers here").mirrorBreakpoints(FEATURE, SPEC)).toBeDefined();
    expect(mirroredLines()).toEqual([]);
  });

  it("tracks an id with no breakpoints and releases it cleanly", async () => {
    const mirror = makeMirror();
    const id = mirror.mirrorBreakpoints(FEATURE, SPEC);
    expect(typeof id).toBe("string");
    const waited = mirror.waitForRelease(id);
    mirror.release(id);
    await waited;
    expect(mirroredLines()).toEqual([]);
  });

  describe("child session tracking", () => {
    function makeSessions(id: string): { root: TrackedSession; child: TrackedSession } {
      const root: TrackedSession = {
        id: "root",
        configuration: { [BreakpointMirror.SESSION_KEY]: id },
      };
      const child: TrackedSession = {
        id: "child-1",
        configuration: { type: "pwa-node" },
        parentSession: root,
      };
      return { root, child };
    }

    it("releases the mirror and stops the root when the last child terminates", () => {
      debugApi.breakpoints.push(featureBreakpoint(9));
      const mirror = makeMirror();
      const id = mirror.mirrorBreakpoints(FEATURE, SPEC);
      const { root, child } = makeSessions(id);

      debugApi.__fireStart(child);
      expect(mirroredLines()).toEqual([11]);

      debugApi.__fireTerminate(child);
      expect(mirroredLines()).toEqual([]);
      expect(debugApi.__stopDebuggingCalls).toEqual([root]);
    });

    it("keeps the mirror while another child is still alive", () => {
      debugApi.breakpoints.push(featureBreakpoint(9));
      const mirror = makeMirror();
      const id = mirror.mirrorBreakpoints(FEATURE, SPEC);
      const { root, child } = makeSessions(id);
      const sibling: TrackedSession = {
        id: "child-2",
        configuration: { type: "pwa-node" },
        parentSession: root,
      };

      debugApi.__fireStart(child);
      debugApi.__fireStart(sibling);
      debugApi.__fireTerminate(child);
      expect(mirroredLines()).toEqual([11]);
      expect(debugApi.__stopDebuggingCalls).toEqual([]);

      debugApi.__fireTerminate(sibling);
      expect(mirroredLines()).toEqual([]);
      expect(debugApi.__stopDebuggingCalls).toEqual([root]);
    });

    it("matches a grandchild through a two-level parentSession chain", () => {
      debugApi.breakpoints.push(featureBreakpoint(9));
      const mirror = makeMirror();
      const id = mirror.mirrorBreakpoints(FEATURE, SPEC);
      const { root, child } = makeSessions(id);
      const grandchild: TrackedSession = {
        id: "grandchild-1",
        configuration: { type: "pwa-node" },
        parentSession: child,
      };

      debugApi.__fireStart(child);
      debugApi.__fireStart(grandchild);
      debugApi.__fireTerminate(child);
      expect(mirroredLines()).toEqual([11]);

      debugApi.__fireTerminate(grandchild);
      expect(mirroredLines()).toEqual([]);
      expect(debugApi.__stopDebuggingCalls).toEqual([root]);
    });

    it("forceStop stops the root tracked at session start and resolves waiters", async () => {
      const mirror = makeMirror();
      const id = mirror.mirrorBreakpoints(FEATURE, SPEC);
      const root: TrackedSession = {
        id: "root-1",
        configuration: { [BreakpointMirror.SESSION_KEY]: id },
      };
      // The root session starts but NO child session ever attaches — the natural
      // last-child-terminated teardown can never fire (pnpm process-tree shape).
      debugApi.__fireStart(root);

      let resolved = false;
      const waited = mirror.waitForRelease(id).then(() => { resolved = true; });

      await mirror.forceStop(id);
      await waited;

      expect(resolved).toBe(true);
      expect(debugApi.__stopDebuggingCalls).toEqual([root]);
    });

    it("forceStop releases even when no root session was ever tracked", async () => {
      const mirror = makeMirror();
      const id = mirror.mirrorBreakpoints(FEATURE, SPEC);

      await mirror.forceStop(id);
      await mirror.waitForRelease(id);

      expect(debugApi.__stopDebuggingCalls).toEqual([]);
    });

    it("manual parent disconnect releases without calling stopDebugging", () => {
      debugApi.breakpoints.push(featureBreakpoint(9));
      const mirror = makeMirror();
      const id = mirror.mirrorBreakpoints(FEATURE, SPEC);
      const { root, child } = makeSessions(id);

      debugApi.__fireStart(child);
      debugApi.__fireTerminate(root);
      expect(mirroredLines()).toEqual([]);
      expect(debugApi.__stopDebuggingCalls).toEqual([]);

      // The child terminates afterwards; the mirror is already gone, so nothing fires again.
      debugApi.__fireTerminate(child);
      expect(debugApi.__stopDebuggingCalls).toEqual([]);
    });
  });

  describe("waitForRelease", () => {
    it("resolves when the mirror is released", async () => {
      const mirror = makeMirror();
      const id = mirror.mirrorBreakpoints(FEATURE, SPEC);
      let resolved = false;
      const waited = mirror.waitForRelease(id).then(() => { resolved = true; });

      await new Promise((r) => setTimeout(r, 0));
      expect(resolved).toBe(false);

      mirror.release(id);
      await waited;
      expect(resolved).toBe(true);
    });

    it("resolves immediately for unknown or already-released ids", async () => {
      const mirror = makeMirror();
      await mirror.waitForRelease("mirror-does-not-exist");

      const id = mirror.mirrorBreakpoints(FEATURE, SPEC);
      mirror.release(id);
      await mirror.waitForRelease(id);
    });

    it("dispose() resolves pending waiters", async () => {
      const mirror = makeMirror();
      const id = mirror.mirrorBreakpoints(FEATURE, SPEC);
      const waited = mirror.waitForRelease(id);
      mirror.dispose();
      await waited;
    });
  });
});
