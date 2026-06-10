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

/**
 * Mirrors user breakpoints set in a .feature file onto the corresponding lines of the
 * bddgen-generated spec, where the JS debugger can actually bind them. Mirrors are tracked per
 * debug session (via `SESSION_KEY` in the session configuration) and removed when that session
 * terminates, so the user's breakpoint list isn't polluted afterwards. Spec lines shared by
 * concurrent sessions (e.g. Background steps) are reference-counted: the breakpoint stays until
 * the last session referencing it goes away.
 */
export class BreakpointMirror {
  public static readonly SESSION_KEY = "__specwrightMirrorId";

  private readonly mirrors = new Map<string, string[]>();
  private readonly sharedByLine = new Map<string, SharedBreakpoint>();
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
      debugApi.onDidTerminateDebugSession((session) => {
        const id = session.configuration?.[BreakpointMirror.SESSION_KEY] as unknown;
        if (typeof id === "string" && this.mirrors.has(id)) {
          this.release(id);
        }
      }),
      // VS Code initializes `debug.breakpoints` lazily; without a listener it can read as empty
      // until the breakpoints API activates, so the first debug after a window reload would
      // mirror nothing. Subscribing forces initialization.
      debugApi.onDidChangeBreakpoints(() => { /* subscription only */ }),
    ];
  }

  public mirrorBreakpoints(featureFsPath: string, specFsPath: string): string | undefined {
    const specText = this.readFileText(specFsPath);
    if (specText === undefined) {
      return undefined;
    }
    const data = parseBddFileData(specText);
    if (!data) {
      return undefined;
    }

    const sourceBreakpoints = this.debugApi.breakpoints.filter(
      (bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint
    );
    const featureBreakpoints = sourceBreakpoints.filter((bp) =>
      samePath(bp.location.uri.fsPath, featureFsPath)
    );
    // A breakpoint the user placed in the generated spec already serves the line, so we skip it —
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

    if (claimedKeys.length === 0) {
      return undefined;
    }
    if (added.length > 0) {
      this.debugApi.addBreakpoints(added);
    }
    this.counter += 1;
    const mirrorId = `mirror-${this.counter}`;
    this.mirrors.set(mirrorId, claimedKeys);
    return mirrorId;
  }

  public release(mirrorId: string): void {
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

  public dispose(): void {
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
