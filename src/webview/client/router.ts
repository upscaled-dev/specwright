import {
  isHostEnvelope,
  WEBVIEW_PROTOCOL_VERSION,
  type HostMessage,
  type HostMessageBySurface,
  type SurfaceName,
} from "../protocol";

export function installRouter(): void {
  const vscode = acquireVsCodeApi();
  const session = document.body.dataset["session"] ?? "";
  const handlers = new Map<SurfaceName, (message: HostMessage) => void>();
  let shellHandler: ((message: HostMessageBySurface["shell"]) => void) | undefined;
  let revision = 0;

  const post = (surface: SurfaceName | "shell", body: Record<string, unknown>): void => {
    vscode.postMessage({ version: WEBVIEW_PROTOCOL_VERSION, session, revision, surface, body });
  };

  window.__spec = {
    post: (surface, message) => post(surface, message),
    postShell: (message) => post("shell", message),
    register: (surface, handler) => handlers.set(surface, (message) => handler(message as HostMessageBySurface[typeof surface])),
    registerShell: (handler) => {shellHandler = handler;},
    state: () => vscode.getState() ?? {},
    saveState: (patch) => vscode.setState({ ...vscode.getState(), ...patch }),
  };

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (!isHostEnvelope(event.data, session, revision)) {return;}
    revision = event.data.revision;
    if (event.data.surface === "shell") {shellHandler?.(event.data.body as HostMessageBySurface["shell"]);}
    else {handlers.get(event.data.surface)?.(event.data.body);}
  });
}
