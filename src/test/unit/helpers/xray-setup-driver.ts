import { vi } from "vitest";
import * as vscode from "vscode";
import { ExtensionConfig } from "../../../core/extension-config";
import { Logger, LogLevel } from "../../../utils/logger";
import { XrayConnectionCommands } from "../../../xray/xray-connection-commands";
import {
  XrayConnectionOutcome,
} from "../../../xray/xray-connection-test";
import { XrayCredentialStore } from "../../../xray/xray-credential-store";
import { trustedWorkspace } from "./test-workspace-trust";
import {
  WEBVIEW_PROTOCOL_VERSION,
  type SetupEnvelope,
  type SetupHostMessage,
} from "../../../webview/setup-protocol";

export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export function connected(site: string): XrayConnectionOutcome {
  return { ok: true, stage: "ok", site, message: `Connected to ${site}` };
}

export function configWith(values: Record<string, unknown>): ExtensionConfig {
  const workspaceConfig = {
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      key in values ? (values[key] as T) : defaultValue,
    update: (): Promise<void> => Promise.resolve(),
    inspect: (key: string): { key: string } => ({ key }),
  } as unknown as vscode.WorkspaceConfiguration;
  return ExtensionConfig.create(workspaceConfig, false);
}

export function mapCredentialStore(): { store: XrayCredentialStore; map: Map<string, string> } {
  const map = new Map<string, string>();
  const storage = {
    get: (key: string): Promise<string | undefined> => Promise.resolve(map.get(key)),
    store: (key: string, value: string): Promise<void> => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string): Promise<void> => {
      map.delete(key);
      return Promise.resolve();
    },
  } as unknown as vscode.SecretStorage;
  return { store: new XrayCredentialStore(storage, trustedWorkspace()), map };
}

export function silentLogger(): Logger {
  const channel = {
    name: "test",
    append: () => { /* no-op */ },
    appendLine: () => { /* no-op */ },
    replace: () => { /* no-op */ },
    clear: () => { /* no-op */ },
    show: () => { /* no-op */ },
    hide: () => { /* no-op */ },
    dispose: () => { /* no-op */ },
  } as unknown as vscode.OutputChannel;
  return Logger.create(channel, LogLevel.ERROR);
}

export interface WsConfigStub {
  wsConfig: vscode.WorkspaceConfiguration;
  updates: Array<{ key: string; value: unknown; target: vscode.ConfigurationTarget }>;
}

export function stubWorkspaceConfig(
  inspected: Record<string, unknown> = {},
  values: Record<string, unknown> = {}
): WsConfigStub {
  const updates: WsConfigStub["updates"] = [];
  const wsConfig = {
    get: (key: string, dflt?: unknown): unknown => (key in values ? values[key] : dflt),
    inspect: (): Record<string, unknown> => inspected,
    update: (key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> => {
      updates.push({ key, value, target });
      return Promise.resolve();
    },
  } as unknown as vscode.WorkspaceConfiguration;
  vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(wsConfig);
  return { wsConfig, updates };
}

export interface SettingShape {
  globalValue?: unknown;
  workspaceValue?: unknown;
}

export function statefulWorkspaceConfig(
  initial: Record<string, SettingShape>
): WsConfigStub {
  const state = new Map(
    Object.entries(initial).map(([key, value]) => [key, { ...value }])
  );
  const updates: WsConfigStub["updates"] = [];
  const wsConfig = {
    get: (key: string, dflt?: unknown): unknown => {
      const value = state.get(key);
      return value?.workspaceValue ?? value?.globalValue ?? dflt;
    },
    inspect: (key: string): Record<string, unknown> => ({ key, ...state.get(key) }),
    update: (key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> => {
      updates.push({ key, value, target });
      const shape = state.get(key) ?? {};
      const field = target === vscode.ConfigurationTarget.Workspace
        ? "workspaceValue"
        : "globalValue";
      if (value === undefined) {
        delete shape[field];
      } else {
        shape[field] = value;
      }
      state.set(key, shape);
      return Promise.resolve();
    },
  } as unknown as vscode.WorkspaceConfiguration;
  vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(wsConfig);
  return { wsConfig, updates };
}

export const MASK = "••••••••";
export const FIRST_DOCUMENT = "1".repeat(32);
export const SECOND_DOCUMENT = "2".repeat(32);

export function makeCommands(
  site: string,
  region = "global",
  workspaceTrust = trustedWorkspace()
): {
  commands: XrayConnectionCommands;
  store: XrayCredentialStore;
  map: Map<string, string>;
} {
  const { store, map } = mapCredentialStore();
  return {
    commands: new XrayConnectionCommands(
      configWith({ "xray.siteUrl": site, "xray.apiRegion": region }),
      store,
      silentLogger(),
      () => [],
      (deps) => Promise.resolve(connected(deps.site)),
      workspaceTrust,
      vscode.Uri.file("/extension/dist")
    ),
    store,
    map,
  };
}

export interface StubPanel {
  viewType: string;
  title: string;
  webview: {
    html: string;
    options: { enableScripts: boolean; localResourceRoots: vscode.Uri[] };
    __posted: unknown[];
    postMessage: (message: unknown) => Promise<boolean>;
  };
  __revealCount: number;
  __disposed: boolean;
  __receive: (message: unknown) => Promise<void>;
}

export type PostedSetup = SetupEnvelope<SetupHostMessage>;

export const win = vscode.window as unknown as {
  __webviewPanels: StubPanel[];
  __resetWebviewPanels: () => void;
};

export let activePanel: StubPanel | undefined;
export let activeDocument = FIRST_DOCUMENT;

export function sessionOf(panel: StubPanel): string {
  return /<body data-session="([^"]+)"/.exec(panel.webview.html)?.[1] ?? "";
}

export function postedBodies(panel: StubPanel): SetupHostMessage[] {
  return (panel.webview.__posted as PostedSetup[]).map((message) => message.body);
}

export function lastNonBusy(panel: StubPanel): SetupHostMessage | undefined {
  return postedBodies(panel).filter((message) => message.type !== "busy").at(-1);
}

export async function openPanel(commands: XrayConnectionCommands): Promise<StubPanel> {
  await commands.connect();
  const panel = win.__webviewPanels[0]!;
  activePanel = panel;
  await panel.__receive({
    version: WEBVIEW_PROTOCOL_VERSION,
    session: sessionOf(panel),
    document: activeDocument,
    revision: 0,
    surface: "setup",
    body: { type: "ready" },
  });
  await flush();
  return panel;
}

export function resetSetupDriver(): void {
  activePanel = undefined;
  activeDocument = FIRST_DOCUMENT;
  win.__resetWebviewPanels();
}

export async function reloadPanel(panel: StubPanel, document: string): Promise<void> {
  const previousDocument = activeDocument;
  activeDocument = document;
  await panel.__receive({
    version: WEBVIEW_PROTOCOL_VERSION,
    session: sessionOf(panel),
    document,
    revision: 0,
    surface: "setup",
    body: { type: "ready", previousDocument },
  });
}

export function saveMessage(
  overrides: Partial<{
    site: string;
    region: string;
    clientId: string;
    clientSecret: string;
    jiraEmail: string;
    jiraToken: string;
    test: boolean;
  }> = {}
): Record<string, unknown> {
  if (activePanel === undefined) {throw new Error("Open the setup panel before sending a save.");}
  const envelopes = activePanel.webview.__posted as PostedSetup[];
  return {
    version: WEBVIEW_PROTOCOL_VERSION,
    session: sessionOf(activePanel),
    document: activeDocument,
    revision: envelopes.at(-1)?.revision ?? 0,
    surface: "setup",
    body: {
      type: "save",
      site: "acme.atlassian.net",
      region: "global",
      clientId: "id",
      clientSecret: "fixture-client-secret",
      jiraEmail: "",
      jiraToken: "",
      test: false,
      ...overrides,
    },
  };
}
