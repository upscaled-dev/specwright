import * as vscode from "vscode";
import * as fs from "node:fs";
import { BddFileData, parseBddFileData } from "../parsers/bdd-file-data-parser";

type ReadFileText = (fsPath: string) => string | undefined;

function defaultReadFileText(fsPath: string): string | undefined {
  try {
    return fs.readFileSync(fsPath, "utf8");
  } catch {
    return undefined;
  }
}

function normalizePath(fsPath: string): string {
  // Windows paths are case-insensitive; comparing verbatim would miss drive-letter casing.
  return process.platform === "win32" ? fsPath.toLowerCase() : fsPath;
}

function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

interface SharedBreakpoint {
  breakpoint: vscode.SourceBreakpoint;
  refCount: number;
}

function targetSpecLines(data: BddFileData, gherkinLine: number): number[] {
  const stepTargets = data.stepLines.get(gherkinLine);
  if (stepTargets) {
    return stepTargets;
  }
  const testTarget = data.testLines.get(gherkinLine);
  return testTarget === undefined ? [] : [testTarget];
}

interface ChildTracking {
  childIds: Set<string>;
  expectedRootId?: string;
  rootSession?: vscode.DebugSession;
}

export type DebugTerminationResult =
  | { readonly confirmed: true }
  | { readonly confirmed: false; readonly failure: string };

export const DEBUG_STOP_TIMEOUT_MS = 2_000;

/**
 * Mirrors user breakpoints set in a .feature file onto the corresponding lines of the
 * bddgen-generated spec, where the JS debugger can actually bind them. Mirrors are tracked per
 * debug session (via `SESSION_KEY` in the session configuration) and removed when that session
 * terminates, so the user's breakpoint list isn't polluted afterwards. Spec lines shared by
 * concurrent sessions (e.g. Background steps) are reference-counted: the breakpoint stays until
 * the last session referencing it goes away.
 *
 * Every debug session is tracked, even when nothing mirrors: a `node-terminal` parent session is
 * bound to the terminal, not the test command, so it never terminates on its own. We watch its
 * child (pwa-node) sessions instead and, when the last one ends, release the mirror and stop the
 * lingering parent so the debugger disconnects automatically.
 */
export class BreakpointMirror {
  public static readonly SESSION_KEY = "__specwrightMirrorId";

  private readonly mirrors = new Map<string, string[]>();
  private readonly sharedByLine = new Map<string, SharedBreakpoint>();
  private readonly childSessions = new Map<string, ChildTracking>();
  private readonly releaseWaiters = new Map<
    string,
    Array<(result: DebugTerminationResult) => void>
  >();
  private readonly completed = new Map<string, DebugTerminationResult>();
  private readonly stoppingNaturally = new Set<string>();
  private disposed = false;
  private counter = 0;
  private readonly subscriptions: vscode.Disposable[];

  public static create(
    debugApi: typeof vscode.debug = vscode.debug,
    readFileText?: ReadFileText
  ): BreakpointMirror {
    return new BreakpointMirror(debugApi, readFileText);
  }

  constructor(
    private readonly debugApi: typeof vscode.debug,
    private readonly readFileText: ReadFileText = defaultReadFileText
  ) {
    this.subscriptions = [
      debugApi.onDidStartDebugSession((session) => {
        const ownId = session.configuration?.[BreakpointMirror.SESSION_KEY] as unknown;
        if (
          typeof ownId === "string"
          && this.mirrors.has(ownId)
          && session.parentSession === undefined
        ) {
          // Only the first top-level session, or the root already identified through a child's
          // parent chain, can establish ownership. A descendant that copied the key cannot replace it.
          const existing = this.childSessions.get(ownId);
          if (!existing) {
            this.childSessions.set(ownId, {
              childIds: new Set(),
              expectedRootId: session.id,
              rootSession: session,
            });
          } else if (
            existing.rootSession === undefined
            && (existing.expectedRootId === undefined || existing.expectedRootId === session.id)
          ) {
            existing.expectedRootId = session.id;
            existing.rootSession = session;
          }
          return;
        }
        const tracked = this.findTrackedAncestor(session);
        if (!tracked) {
          return;
        }
        let tracking = this.childSessions.get(tracked.mirrorId);
        if (!tracking) {
          tracking = { childIds: new Set(), expectedRootId: tracked.rootSession.id };
          this.childSessions.set(tracked.mirrorId, tracking);
        }
        tracking.childIds.add(session.id);
      }),
      debugApi.onDidTerminateDebugSession((session) => {
        const ownId = session.configuration?.[BreakpointMirror.SESSION_KEY] as unknown;
        if (typeof ownId === "string" && this.mirrors.has(ownId)) {
          const tracking = this.childSessions.get(ownId);
          // A copied mirror key is not identity. Only the exact root id recorded by the root's own
          // start event can prove that this mirror's debug session terminated.
          if (tracking?.rootSession?.id === session.id) {
            this.release(ownId);
            return;
          }
        }
        const tracked = this.findTrackedAncestor(session);
        if (!tracked) {
          return;
        }
        const tracking = this.childSessions.get(tracked.mirrorId);
        if (!tracking) {
          return;
        }
        tracking.childIds.delete(session.id);
        if (tracking.childIds.size > 0 || tracking.rootSession === undefined) {
          return;
        }
        this.stopNaturally(tracked.mirrorId);
      }),
      // VS Code initializes `debug.breakpoints` lazily; without a listener it can read as empty
      // until the breakpoints API activates, so the first debug after a window reload would
      // mirror nothing. Subscribing forces initialization.
      debugApi.onDidChangeBreakpoints(() => { /* subscription only */ }),
    ];
  }

  /**
   * Always returns a mirror id, even when the spec is unreadable/unparseable or no breakpoint
   * maps (then the id tracks an empty key list); every debug session must be tracked so
   * session-end detection and auto-disconnect work universally.
   */
  public mirrorBreakpoints(
    featureFsPath: string,
    specFsPaths: string | readonly string[] | undefined
  ): string {
    const paths = typeof specFsPaths === "string" ? [specFsPaths] : specFsPaths ?? [];
    const claimedKeys = paths.flatMap((specFsPath) => this.claimSpecLines(featureFsPath, specFsPath));
    this.counter += 1;
    const mirrorId = `mirror-${this.counter}`;
    this.mirrors.set(mirrorId, claimedKeys);
    return mirrorId;
  }

  private claimSpecLines(featureFsPath: string, specFsPath: string): string[] {
    const specText = this.readFileText(specFsPath);
    if (specText === undefined) {
      return [];
    }
    const data = parseBddFileData(specText);
    if (!data) {
      return [];
    }

    const sourceBreakpoints = this.debugApi.breakpoints.filter(
      (bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint
    );
    const featureBreakpoints = sourceBreakpoints.filter((bp) =>
      samePath(bp.location.uri.fsPath, featureFsPath)
    );
    // A breakpoint the user placed in the generated spec already serves the line, so we skip it,
    // but our own mirrors from concurrent sessions must not count as occupied: those are
    // reference-counted below instead.
    const mirrorOwned = new Set(
      [...this.sharedByLine.values()].map((shared) => shared.breakpoint)
    );
    const userOccupiedLines = new Set(
      sourceBreakpoints
        .filter((bp) => samePath(bp.location.uri.fsPath, specFsPath) && !mirrorOwned.has(bp))
        .map((bp) => bp.location.range.start.line)
    );

    const specUri = vscode.Uri.file(specFsPath);
    const claimedKeys: string[] = [];
    const added: vscode.SourceBreakpoint[] = [];
    for (const bp of featureBreakpoints) {
      const targets = targetSpecLines(data, bp.location.range.start.line + 1);
      for (const pwLine of targets) {
        const specLine = pwLine - 1;
        const key = `${normalizePath(specFsPath)}:${specLine}`;
        if (userOccupiedLines.has(specLine) || claimedKeys.includes(key)) {
          continue;
        }
        let shared = this.sharedByLine.get(key);
        if (!shared) {
          const mirrored = new vscode.SourceBreakpoint(
            new vscode.Location(specUri, new vscode.Position(specLine, 0)),
            bp.enabled,
            bp.condition,
            bp.hitCondition,
            bp.logMessage
          );
          shared = { breakpoint: mirrored, refCount: 0 };
          this.sharedByLine.set(key, shared);
          added.push(mirrored);
        }
        shared.refCount += 1;
        claimedKeys.push(key);
      }
    }

    if (added.length > 0) {
      this.debugApi.addBreakpoints(added);
    }
    return claimedKeys;
  }

  private findTrackedAncestor(
    session: vscode.DebugSession
  ): { mirrorId: string; rootSession: vscode.DebugSession } | undefined {
    for (let parent = session.parentSession; parent; parent = parent.parentSession) {
      const id = parent.configuration?.[BreakpointMirror.SESSION_KEY] as unknown;
      if (typeof id === "string" && this.mirrors.has(id)) {
        return { mirrorId: id, rootSession: parent };
      }
    }
    return undefined;
  }

  /**
   * Force the session for a mirror down: stop its root session (when known) and
   * release the mirror. Used as a watchdog escape when the natural teardown chain
   * (last child session terminates → root stopped) wedges, e.g. pnpm process trees
   * leaving a debug-attached child alive, or no child session ever attaching.
   */
  public async forceStop(mirrorId: string): Promise<DebugTerminationResult> {
    if (!this.mirrors.has(mirrorId)) {
      return { confirmed: true };
    }
    const result = await this.stopTrackedRoot(mirrorId);
    if (result.confirmed) {this.release(mirrorId, result);}
    return result;
  }

  public async shutdown(): Promise<DebugTerminationResult[]> {
    const mirrorIds = [...this.mirrors.keys()];
    const results = await Promise.all(mirrorIds.map((mirrorId) => this.forceStop(mirrorId)));
    for (let index = 0; index < mirrorIds.length; index += 1) {
      const mirrorId = mirrorIds[index];
      const result = results[index];
      if (mirrorId !== undefined && result !== undefined && this.mirrors.has(mirrorId)) {
        this.release(mirrorId, result);
      }
    }
    this.dispose();
    return results;
  }

  private async stopTrackedRoot(mirrorId: string): Promise<DebugTerminationResult> {
    const tracking = this.childSessions.get(mirrorId);
    const root = tracking?.rootSession;
    if (!root) {
      return {
        confirmed: false,
        failure: "Debug-session termination could not be confirmed because no tracked root session was available.",
      };
    }
    // stopDebugging resolving confirms that VS Code accepted the request, not that the debug
    // adapter and its descendants have terminated. The root termination event is the release proof.
    const terminated = this.waitForRelease(mirrorId);
    let stop: Promise<void>;
    try {
      stop = Promise.resolve(this.debugApi.stopDebugging(root));
    } catch (error) {
      return {
        confirmed: false,
        failure: `Debug-session termination failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const rejected = stop.then<never, DebugTerminationResult>(
      () => new Promise<never>(() => { /* wait for the root termination event */ }),
      (error: unknown) => ({
        confirmed: false,
        failure: `Debug-session termination failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<DebugTerminationResult>((resolve) => {
      timer = setTimeout(() => resolve({
        confirmed: false,
        failure: `Debug-session termination was not confirmed within ${DEBUG_STOP_TIMEOUT_MS} ms.`,
      }), DEBUG_STOP_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([terminated, rejected, timeout]);
    } finally {
      if (timer !== undefined) {clearTimeout(timer);}
    }
  }

  private stopNaturally(mirrorId: string): void {
    if (this.stoppingNaturally.has(mirrorId)) {return;}
    this.stoppingNaturally.add(mirrorId);
    this.stopTrackedRoot(mirrorId).then(
      (result) => {
        if (result.confirmed) {
          this.release(mirrorId, result);
        } else {
          this.complete(mirrorId, result);
        }
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.complete(mirrorId, {
          confirmed: false,
          failure: `Debug-session termination failed: ${message}`,
        });
      }
    );
  }

  public waitForRelease(mirrorId: string): Promise<DebugTerminationResult> {
    const completed = this.completed.get(mirrorId);
    if (completed !== undefined) {
      this.completed.delete(mirrorId);
      return Promise.resolve(completed);
    }
    if (!this.mirrors.has(mirrorId)) {
      return Promise.resolve({ confirmed: true });
    }
    return new Promise((resolve) => {
      const waiters = this.releaseWaiters.get(mirrorId);
      if (waiters) {
        waiters.push(resolve);
      } else {
        this.releaseWaiters.set(mirrorId, [resolve]);
      }
    });
  }

  public release(
    mirrorId: string,
    result: DebugTerminationResult = { confirmed: true }
  ): void {
    this.childSessions.delete(mirrorId);
    this.stoppingNaturally.delete(mirrorId);
    this.complete(mirrorId, result);
    const keys = this.mirrors.get(mirrorId);
    if (!keys) {
      return;
    }
    this.mirrors.delete(mirrorId);
    const removed: vscode.SourceBreakpoint[] = [];
    for (const key of keys) {
      const shared = this.sharedByLine.get(key);
      if (!shared) {
        continue;
      }
      shared.refCount -= 1;
      if (shared.refCount === 0) {
        this.sharedByLine.delete(key);
        removed.push(shared.breakpoint);
      }
    }
    if (removed.length > 0) {
      this.debugApi.removeBreakpoints(removed);
    }
  }

  private complete(mirrorId: string, result: DebugTerminationResult): void {
    this.completed.delete(mirrorId);
    const waiters = this.releaseWaiters.get(mirrorId);
    if (waiters) {
      this.releaseWaiters.delete(mirrorId);
      for (const resolve of waiters) {
        resolve(result);
      }
    } else if (!result.confirmed) {
      this.completed.set(mirrorId, result);
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const disposed: DebugTerminationResult = {
      confirmed: false,
      failure: "Debug-session termination was not confirmed before breakpoint tracking was disposed.",
    };
    for (const waiters of this.releaseWaiters.values()) {
      for (const resolve of waiters) {
        resolve(disposed);
      }
    }
    this.releaseWaiters.clear();
    this.completed.clear();
    this.stoppingNaturally.clear();
    this.childSessions.clear();
    const all = [...this.sharedByLine.values()].map((shared) => shared.breakpoint);
    if (all.length > 0) {
      this.debugApi.removeBreakpoints(all);
    }
    this.sharedByLine.clear();
    this.mirrors.clear();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}
