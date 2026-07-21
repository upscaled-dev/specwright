/**
 * Minimal stub of the `vscode` module so unit tests can `import * as vscode from "vscode"`
 * without launching VS Code. Anything not stubbed here will be `undefined` at access time;
 * code that needs real VS Code APIs belongs in integration tests, not unit tests.
 */

class StubOutputChannel {
  appendLine(_line: string): void { /* no-op */ }
  show(): void { /* no-op */ }
  clear(): void { /* no-op */ }
  dispose(): void { /* no-op */ }
}

class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

class Range {
  public readonly start: Position;
  public readonly end: Position;
  constructor(start: Position, end: Position);
  constructor(startLine: number, startChar: number, endLine: number, endChar: number);
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === "number") {
      this.start = new Position(a, b as number);
      this.end = new Position(c as number, d as number);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
}

class Location {
  public readonly range: Range;
  constructor(public readonly uri: unknown, rangeOrPosition: Range | Position) {
    // Real VS Code normalizes a Position into an empty Range.
    this.range = rangeOrPosition instanceof Position
      ? new Range(rangeOrPosition, rangeOrPosition)
      : rangeOrPosition;
  }
}

export class SourceBreakpoint {
  constructor(
    public readonly location: Location,
    public readonly enabled: boolean = true,
    public readonly condition?: string,
    public readonly hitCondition?: string,
    public readonly logMessage?: string
  ) {}
}

const Uri = {
  file: (fsPath: string) => ({
    fsPath,
    scheme: "file",
    toString: () => `file://${fsPath}`,
  }),
  parse: (value: string) => ({
    fsPath: value,
    scheme: value.split(":")[0] ?? "",
    toString: () => value,
  }),
};

export const env = {
  __openExternalCalls: [] as string[],
  __clipboardText: "",
  openExternal: (uri: { toString: () => string }): Promise<boolean> => {
    env.__openExternalCalls.push(uri.toString());
    return Promise.resolve(true);
  },
  clipboard: {
    writeText: (text: string): Promise<void> => {
      env.__clipboardText = text;
      return Promise.resolve();
    },
  },
  __resetEnv: (): void => {
    env.__openExternalCalls.length = 0;
    env.__clipboardText = "";
  },
};

interface StubStatusBarItem {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  alignment: number;
  priority: number;
  shown: boolean;
  disposed: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

interface TreeViewCounters {
  createCount: number;
  disposeCount: number;
}

interface StubTreeView {
  message: string | undefined;
  dispose: () => void;
  onDidDispose: () => { dispose: () => void };
}

const __treeViewCounters: TreeViewCounters = { createCount: 0, disposeCount: 0 };
let __lastTreeView: StubTreeView | undefined;

interface StubWebview {
  html: string;
  options: unknown;
  cspSource: string;
  __posted: unknown[];
  postMessage: (message: unknown) => Promise<boolean>;
  onDidReceiveMessage: (listener: (message: unknown) => unknown) => { dispose: () => void };
}

interface StubWebviewPanel {
  viewType: string;
  title: string;
  webview: StubWebview;
  __revealCount: number;
  __disposed: boolean;
  reveal: (column?: unknown) => void;
  onDidDispose: (listener: () => void) => { dispose: () => void };
  dispose: () => void;
  __receive: (message: unknown) => Promise<void>;
}

const __webviewPanels: StubWebviewPanel[] = [];

function createStubWebviewPanel(
  viewType: string,
  title: string,
  _showOptions: unknown,
  options: unknown
): StubWebviewPanel {
  const messageListeners: Array<(message: unknown) => unknown> = [];
  const webview: StubWebview = {
    html: "",
    options,
    cspSource: "vscode-webview://stub",
    __posted: [],
    postMessage: (message: unknown): Promise<boolean> => {
      webview.__posted.push(message);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (listener) => {
      messageListeners.push(listener);
      return {
        dispose: () => {
          const i = messageListeners.indexOf(listener);
          if (i > -1) { messageListeners.splice(i, 1); }
        },
      };
    },
  };
  const disposeListeners: Array<() => void> = [];
  const panel: StubWebviewPanel = {
    viewType,
    title,
    webview,
    __revealCount: 0,
    __disposed: false,
    reveal: (): void => { panel.__revealCount += 1; },
    onDidDispose: (listener) => {
      disposeListeners.push(listener);
      return {
        dispose: () => {
          const i = disposeListeners.indexOf(listener);
          if (i > -1) { disposeListeners.splice(i, 1); }
        },
      };
    },
    dispose: (): void => {
      if (panel.__disposed) { return; }
      panel.__disposed = true;
      for (const l of [...disposeListeners]) { l(); }
    },
    __receive: async (message): Promise<void> => {
      await Promise.all(messageListeners.map((l) => l(message)));
    },
  };
  __webviewPanels.push(panel);
  return panel;
}

export const window = {
  createOutputChannel: () => new StubOutputChannel(),
  createTerminal: () => ({ show: () => {}, sendText: () => {}, dispose: () => {} }),
  createStatusBarItem: (alignment?: number, priority?: number): StubStatusBarItem => ({
    text: "",
    tooltip: undefined,
    command: undefined,
    alignment: alignment ?? 1,
    priority: priority ?? 0,
    shown: false,
    disposed: false,
    show(): void { this.shown = true; },
    hide(): void { this.shown = false; },
    dispose(): void { this.disposed = true; },
  }),
  createTreeView: (_viewId: string, _options: unknown): StubTreeView => {
    __treeViewCounters.createCount += 1;
    const view: StubTreeView = {
      message: undefined,
      dispose: (): void => { __treeViewCounters.disposeCount += 1; },
      onDidDispose: () => ({ dispose: () => {} }),
    };
    __lastTreeView = view;
    return view;
  },
  // Settable by tests that exercise active-editor commands (insert step, go to definition).
  activeTextEditor: undefined as unknown,
  // Settable by tests that exercise editor decorations; empty so nothing is decorated by default.
  visibleTextEditors: [] as ReadonlyArray<unknown>,
  createTextEditorDecorationType: (_options: unknown): { dispose: () => void } => ({ dispose: () => {} }),
  onDidChangeVisibleTextEditors: (_listener: unknown): { dispose: () => void } => ({ dispose: () => {} }),
  showInformationMessage: (..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined),
  showWarningMessage: (..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined),
  showErrorMessage: (..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined),
  showQuickPick: (..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined),
  showInputBox: (..._args: unknown[]): Promise<string | undefined> => Promise.resolve(undefined),
  showSaveDialog: (..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined),
  showTextDocument: (..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined),
  // Runs the task immediately with a no-op progress reporter and a never-cancelled token. Tests that
  // need cancellation drive the AbortSignal directly rather than through this token.
  withProgress: <R>(
    _options: unknown,
    task: (
      progress: { report: (value: unknown) => void },
      token: { isCancellationRequested: boolean; onCancellationRequested: (listener: () => void) => { dispose: () => void } }
    ) => Thenable<R>
  ): Thenable<R> =>
    Promise.resolve(
      task(
        { report: () => { /* no-op */ } },
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }
      )
    ),
  createWebviewPanel: (
    viewType: string,
    title: string,
    showOptions?: unknown,
    options?: unknown
  ): StubWebviewPanel => createStubWebviewPanel(viewType, title, showOptions, options),
  __treeViewCounters,
  __getLastTreeView: (): StubTreeView | undefined => __lastTreeView,
  __resetTreeViewCounters: (): void => {
    __treeViewCounters.createCount = 0;
    __treeViewCounters.disposeCount = 0;
    __lastTreeView = undefined;
  },
  __webviewPanels,
  __resetWebviewPanels: (): void => {
    for (const panel of [...__webviewPanels]) { panel.dispose(); }
    __webviewPanels.length = 0;
  },
};

export const StatusBarAlignment = { Left: 1, Right: 2 };

const defaultConfiguration = {
  get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
  update: (..._args: unknown[]): Promise<void> => Promise.resolve(),
  // Real VS Code returns {key, defaultValue, globalValue, ...}; "no explicit value anywhere"
  // is the right default for tests.
  inspect: (key: string): { key: string } => ({ key }),
};

type FileWatcherListener = (uri: { fsPath: string }) => unknown;
type FileWatcherEventKind = "create" | "change" | "delete";

interface StubFileWatcher {
  onDidCreate: (l: FileWatcherListener) => { dispose: () => void };
  onDidChange: (l: FileWatcherListener) => { dispose: () => void };
  onDidDelete: (l: FileWatcherListener) => { dispose: () => void };
  dispose: () => void;
  __fire: (kind: FileWatcherEventKind, uri: { fsPath: string }) => Promise<void>;
}

const __fileWatchers: StubFileWatcher[] = [];

function createStubFileWatcher(): StubFileWatcher {
  const buckets: Record<FileWatcherEventKind, FileWatcherListener[]> = {
    create: [], change: [], delete: [],
  };
  const register = (bucket: FileWatcherListener[]) => (l: FileWatcherListener) => {
    bucket.push(l);
    return { dispose: () => { const i = bucket.indexOf(l); if (i > -1) {bucket.splice(i, 1);} } };
  };
  const watcher: StubFileWatcher = {
    onDidCreate: register(buckets.create),
    onDidChange: register(buckets.change),
    onDidDelete: register(buckets.delete),
    dispose: () => { /* no-op */ },
    // Listeners return the provider's incremental-update promise; await them so a test can assert
    // on the settled tree after firing an event.
    __fire: async (kind, uri) => { await Promise.all(buckets[kind].map((l) => l(uri))); },
  };
  __fileWatchers.push(watcher);
  return watcher;
}

/** Fire an event on the most recently created file-system watcher (integration-test seam). */
export function __fireFileWatcher(
  kind: FileWatcherEventKind,
  uri: { fsPath: string }
): Promise<void> {
  const last = __fileWatchers.at(-1);
  return last ? last.__fire(kind, uri) : Promise.resolve();
}

export function __resetFileWatchers(): void {
  __fileWatchers.length = 0;
}

export const workspace = {
  getConfiguration: (..._args: unknown[]) => defaultConfiguration,
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
  findFiles: () => Promise.resolve([]),
  createFileSystemWatcher: (): StubFileWatcher => createStubFileWatcher(),
  workspaceFolders: undefined as ReadonlyArray<unknown> | undefined,
  getWorkspaceFolder: (_uri: unknown): unknown => undefined,
  fs: {
    readFile: () => Promise.resolve(new Uint8Array()),
  },
};

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: () => Promise.resolve(),
};

export class RelativePattern {
  public readonly baseUri: { fsPath: string };
  public readonly base: string;
  constructor(
    base: { uri?: { fsPath: string }; fsPath?: string } | string,
    public readonly pattern: string
  ) {
    const fsPath =
      typeof base === "string" ? base : base.uri?.fsPath ?? base.fsPath ?? "";
    this.baseUri = { fsPath };
    this.base = fsPath;
  }
}

interface LanguageCounters {
  codeLensRegisterCount: number;
  codeLensDisposeCount: number;
  definitionRegisterCount: number;
  definitionDisposeCount: number;
  codeActionRegisterCount: number;
  codeActionDisposeCount: number;
  diagnosticCollectionCreateCount: number;
  diagnosticCollectionDisposeCount: number;
  completionRegisterCount: number;
  completionDisposeCount: number;
  hoverRegisterCount: number;
  hoverDisposeCount: number;
  referenceRegisterCount: number;
  referenceDisposeCount: number;
  usageCodeLensRegisterCount: number;
  usageCodeLensDisposeCount: number;
  documentSymbolRegisterCount: number;
  documentSymbolDisposeCount: number;
  documentFormattingRegisterCount: number;
  documentFormattingDisposeCount: number;
}

const __languageCounters: LanguageCounters = {
  codeLensRegisterCount: 0,
  codeLensDisposeCount: 0,
  definitionRegisterCount: 0,
  definitionDisposeCount: 0,
  codeActionRegisterCount: 0,
  codeActionDisposeCount: 0,
  diagnosticCollectionCreateCount: 0,
  diagnosticCollectionDisposeCount: 0,
  completionRegisterCount: 0,
  completionDisposeCount: 0,
  hoverRegisterCount: 0,
  hoverDisposeCount: 0,
  referenceRegisterCount: 0,
  referenceDisposeCount: 0,
  usageCodeLensRegisterCount: 0,
  usageCodeLensDisposeCount: 0,
  documentSymbolRegisterCount: 0,
  documentSymbolDisposeCount: 0,
  documentFormattingRegisterCount: 0,
  documentFormattingDisposeCount: 0,
};

function isUsageCodeLensProvider(provider: unknown): boolean {
  if (!provider || typeof provider !== "object") {return false;}
  return provider.constructor?.name === "StepUsageCodeLensProvider";
}

export const languages = {
  registerCodeLensProvider: (_selector: unknown, provider: unknown) => {
    if (isUsageCodeLensProvider(provider)) {
      __languageCounters.usageCodeLensRegisterCount += 1;
      return {
        dispose: () => {
          __languageCounters.usageCodeLensDisposeCount += 1;
        },
      };
    }
    __languageCounters.codeLensRegisterCount += 1;
    return {
      dispose: () => {
        __languageCounters.codeLensDisposeCount += 1;
      },
    };
  },
  registerDefinitionProvider: (..._args: unknown[]) => {
    __languageCounters.definitionRegisterCount += 1;
    return {
      dispose: () => {
        __languageCounters.definitionDisposeCount += 1;
      },
    };
  },
  registerCodeActionsProvider: (..._args: unknown[]) => {
    __languageCounters.codeActionRegisterCount += 1;
    return {
      dispose: () => {
        __languageCounters.codeActionDisposeCount += 1;
      },
    };
  },
  registerCompletionItemProvider: (..._args: unknown[]) => {
    __languageCounters.completionRegisterCount += 1;
    return {
      dispose: () => {
        __languageCounters.completionDisposeCount += 1;
      },
    };
  },
  registerHoverProvider: (..._args: unknown[]) => {
    __languageCounters.hoverRegisterCount += 1;
    return {
      dispose: () => {
        __languageCounters.hoverDisposeCount += 1;
      },
    };
  },
  registerReferenceProvider: (..._args: unknown[]) => {
    __languageCounters.referenceRegisterCount += 1;
    return {
      dispose: () => {
        __languageCounters.referenceDisposeCount += 1;
      },
    };
  },
  registerDocumentSymbolProvider: (..._args: unknown[]) => {
    __languageCounters.documentSymbolRegisterCount += 1;
    return {
      dispose: () => {
        __languageCounters.documentSymbolDisposeCount += 1;
      },
    };
  },
  registerDocumentFormattingEditProvider: (..._args: unknown[]) => {
    __languageCounters.documentFormattingRegisterCount += 1;
    return {
      dispose: () => {
        __languageCounters.documentFormattingDisposeCount += 1;
      },
    };
  },
  createDiagnosticCollection: (_name?: string) => {
    __languageCounters.diagnosticCollectionCreateCount += 1;
    const store = new Map<string, unknown[]>();
    return {
      set: (uri: { toString: () => string }, diags: unknown[]): void => {
        store.set(uri.toString(), diags);
      },
      delete: (uri: { toString: () => string }): void => {
        store.delete(uri.toString());
      },
      get: (uri: { toString: () => string }): unknown[] | undefined => store.get(uri.toString()),
      clear: (): void => store.clear(),
      dispose: (): void => {
        __languageCounters.diagnosticCollectionDisposeCount += 1;
        store.clear();
      },
    };
  },
  __counters: __languageCounters,
  __resetCounters: (): void => {
    __languageCounters.codeLensRegisterCount = 0;
    __languageCounters.codeLensDisposeCount = 0;
    __languageCounters.definitionRegisterCount = 0;
    __languageCounters.definitionDisposeCount = 0;
    __languageCounters.codeActionRegisterCount = 0;
    __languageCounters.codeActionDisposeCount = 0;
    __languageCounters.diagnosticCollectionCreateCount = 0;
    __languageCounters.diagnosticCollectionDisposeCount = 0;
    __languageCounters.completionRegisterCount = 0;
    __languageCounters.completionDisposeCount = 0;
    __languageCounters.hoverRegisterCount = 0;
    __languageCounters.hoverDisposeCount = 0;
    __languageCounters.referenceRegisterCount = 0;
    __languageCounters.referenceDisposeCount = 0;
    __languageCounters.usageCodeLensRegisterCount = 0;
    __languageCounters.usageCodeLensDisposeCount = 0;
    __languageCounters.documentSymbolRegisterCount = 0;
    __languageCounters.documentSymbolDisposeCount = 0;
    __languageCounters.documentFormattingRegisterCount = 0;
    __languageCounters.documentFormattingDisposeCount = 0;
  },
};

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];
  public readonly event = (listener: (value: T) => void): { dispose: () => void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(listener);
        if (i > -1) {this.listeners.splice(i, 1);}
      },
    };
  };
  public fire(value: T): void {
    for (const l of this.listeners) {l(value);}
  }
  public dispose(): void {
    this.listeners = [];
  }
}

export class CancellationTokenSource {
  private readonly emitter = new EventEmitter<unknown>();
  public readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: this.emitter.event,
  };
  public cancel(): void {
    if (this.token.isCancellationRequested) { return; }
    this.token.isCancellationRequested = true;
    this.emitter.fire(undefined);
  }
  public dispose(): void {
    this.emitter.dispose();
  }
}

export const tests = {
  createTestController: () => ({ dispose: () => {} }),
};

type DebugSessionListener = (session: unknown) => void;
const __debugTerminateListeners: DebugSessionListener[] = [];
const __debugStartListeners: DebugSessionListener[] = [];

function subscription(registry: DebugSessionListener[], listener?: DebugSessionListener) {
  if (listener) {
    registry.push(listener);
  }
  return {
    dispose: () => {
      if (!listener) {return;}
      const i = registry.indexOf(listener);
      if (i > -1) {registry.splice(i, 1);}
    },
  };
}

export const debug = {
  breakpoints: [] as unknown[],
  __startDebuggingCalls: [] as Array<{ folder: unknown; config: Record<string, unknown> }>,
  __stopDebuggingCalls: [] as unknown[],
  startDebugging: (folder?: unknown, config?: unknown): Promise<boolean> => {
    debug.__startDebuggingCalls.push({ folder, config: config as Record<string, unknown> });
    return Promise.resolve(true);
  },
  stopDebugging: (session?: unknown): Promise<void> => {
    debug.__stopDebuggingCalls.push(session);
    return Promise.resolve();
  },
  addBreakpoints: (bps: readonly unknown[]): void => {
    debug.breakpoints.push(...bps);
  },
  removeBreakpoints: (bps: readonly unknown[]): void => {
    debug.breakpoints = debug.breakpoints.filter((bp) => !bps.includes(bp));
  },
  onDidChangeBreakpoints: (_listener?: unknown) => ({ dispose: () => { /* no-op */ } }),
  onDidStartDebugSession: (listener?: DebugSessionListener) =>
    subscription(__debugStartListeners, listener),
  onDidTerminateDebugSession: (listener?: DebugSessionListener) =>
    subscription(__debugTerminateListeners, listener),
  __fireStart: (session: unknown): void => {
    for (const l of __debugStartListeners) {l(session);}
  },
  __fireTerminate: (session: unknown): void => {
    for (const l of __debugTerminateListeners) {l(session);}
  },
  __resetDebug: (): void => {
    debug.breakpoints = [];
    debug.__startDebuggingCalls.length = 0;
    debug.__stopDebuggingCalls.length = 0;
    __debugTerminateListeners.length = 0;
    __debugStartListeners.length = 0;
  },
};

export const extensions = {
  getExtension: (_id: string): unknown => undefined,
  onDidChange: () => ({ dispose: () => {} }),
};

export { Position, Range, Location, Uri };

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
export const QuickPickItemKind = { Separator: -1, Default: 0 };
export const OverviewRulerLane = { Left: 1, Center: 2, Right: 4, Full: 7 };
export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 };
export const EndOfLine = { LF: 1, CRLF: 2 };
export const TestRunProfileKind = { Run: 1, Debug: 2, Coverage: 3 };

export class TestRunRequest {
  constructor(public include?: unknown[], public exclude?: unknown[]) {}
}

export class TestMessage {
  constructor(public message: string) {}
}

export class CodeLens {
  constructor(public range: Range, public command?: unknown) {}
}

export const SymbolKind = {
  File: 0,
  Module: 1,
  Namespace: 2,
  Package: 3,
  Class: 4,
  Method: 5,
  Property: 6,
  Field: 7,
  Constructor: 8,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
  String: 14,
  Number: 15,
  Boolean: 16,
  Array: 17,
  Object: 18,
  Key: 19,
  Null: 20,
  EnumMember: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
};

export class DocumentSymbol {
  public children: DocumentSymbol[] = [];
  constructor(
    public name: string,
    public detail: string,
    public kind: number,
    public range: Range,
    public selectionRange: Range
  ) {}
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

export class Diagnostic {
  public source?: string;
  public code?: string | number;
  constructor(
    public range: Range,
    public message: string,
    public severity: number = DiagnosticSeverity.Error
  ) {}
}

export const CodeActionKind = {
  QuickFix: { value: "quickfix" },
  Refactor: { value: "refactor" },
  RefactorRewrite: { value: "refactor.rewrite" },
};

export class CodeAction {
  public diagnostics?: Diagnostic[];
  public command?: unknown;
  public isPreferred?: boolean;
  public edit?: WorkspaceEdit;
  constructor(public title: string, public kind?: unknown) {}
}

export const CompletionItemKind = {
  Text: 0,
  Method: 1,
  Function: 2,
  Constant: 20,
  Snippet: 14,
};

export class CompletionItem {
  public insertText?: string | SnippetString;
  public detail?: string;
  public documentation?: MarkdownString | string;
  public filterText?: string;
  public preselect?: boolean;
  public range?: Range;
  constructor(public label: string, public kind?: number) {}
}

export class SnippetString {
  constructor(public value: string) {}
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

export class TreeItem {
  public description?: string | boolean;
  public tooltip?: string;
  public contextValue?: string;
  public iconPath?: unknown;
  public command?: unknown;
  public resourceUri?: unknown;
  constructor(
    public label: string,
    public collapsibleState: number = TreeItemCollapsibleState.None
  ) {}
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class ThemeIcon {
  constructor(public readonly id: string, public readonly color?: unknown) {}
}

export class MarkdownString {
  public value = "";
  public isTrusted = false;
  public appendMarkdown(text: string): MarkdownString {
    this.value += text;
    return this;
  }
}

export class Hover {
  public contents: MarkdownString[];
  constructor(contents: MarkdownString | MarkdownString[]) {
    this.contents = Array.isArray(contents) ? contents : [contents];
  }
}

export interface RecordedWorkspaceEditEntry {
  op: "insert" | "replace";
  uri: unknown;
  range?: Range;
  position?: Position;
  text: string;
}

export class TextEdit {
  constructor(public range: Range, public newText: string) {}
  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }
  static insert(position: Position, newText: string): TextEdit {
    return new TextEdit(new Range(position.line, position.character, position.line, position.character), newText);
  }
  static delete(range: Range): TextEdit {
    return new TextEdit(range, "");
  }
}

export class WorkspaceEdit {
  public readonly __entries: RecordedWorkspaceEditEntry[] = [];
  public insert(uri: unknown, position: Position, text: string): void {
    this.__entries.push({ op: "insert", uri, position, text });
  }
  public replace(uri: unknown, range: Range, text: string): void {
    this.__entries.push({ op: "replace", uri, range, text });
  }
}

Object.assign(workspace, {
  textDocuments: [] as ReadonlyArray<unknown>,
  onDidOpenTextDocument: () => ({ dispose: () => {} }),
  onDidChangeTextDocument: () => ({ dispose: () => {} }),
  onDidCloseTextDocument: () => ({ dispose: () => {} }),
  applyEdit: (): Promise<boolean> => Promise.resolve(true),
  openTextDocument: (): Promise<unknown> => Promise.resolve(undefined),
});
