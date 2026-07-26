import { describe, it, expect } from "vitest";
import { LinkSurface } from "../../traceability/link-picker-panel";
import { LinkedRow, LinkPickerRow, LinkPickerUi } from "../../traceability/link-picker-flow";
import { SurfaceHost, SurfaceName } from "../../traceability/webview-host";

// A fake SurfaceHost driving LinkSurface in isolation: `receive` delivers an inbound (webview) message
// to the surface's handler, `posted` records outbound ones, `tabVisible` records setTabVisible calls,
// `activations` records `activate` targets, and `dispose` fires the onDidDispose seam.
interface FakeHost {
  host: SurfaceHost;
  posted: Array<{ type: string; [key: string]: unknown }>;
  tabVisible: Array<{ visible: boolean; title: string | undefined }>;
  activations: Array<SurfaceName | undefined>;
  receive: (message: unknown) => void;
  dispose: () => void;
}

function fakeHost(): FakeHost {
  let messageHandler: ((message: unknown) => void) | undefined;
  let disposeHandler: (() => void) | undefined;
  let disposed = false;
  const posted: Array<{ type: string; [key: string]: unknown }> = [];
  const tabVisible: Array<{ visible: boolean; title: string | undefined }> = [];
  const activations: Array<SurfaceName | undefined> = [];
  const host: SurfaceHost = {
    post: (message) => posted.push(message as { type: string }),
    onMessage: (handler) => {
      messageHandler = handler;
    },
    activate: (surface) => activations.push(surface),
    onDidDispose: (handler) => {
      disposeHandler = handler;
    },
    isDisposed: () => disposed,
    setTabVisible: (visible, title) => tabVisible.push({ visible, title }),
  };
  return {
    host,
    posted,
    tabVisible,
    activations,
    receive: (message) => messageHandler?.(message),
    dispose: () => {
      disposed = true;
      disposeHandler?.();
    },
  };
}

const OPTS = { title: "Link scenario to Xray test", searchPlaceholder: "Search Xray tests" };
const ROW: LinkPickerRow = { id: "CALC-1", key: "CALC-1", summary: "Login", kind: "test" };
const LINKED: LinkedRow[] = [{ key: "CALC-1", summary: "Login" }, { key: "CALC-2", remoteMissing: true }];

function begin(rig: FakeHost): { surface: LinkSurface; ui: LinkPickerUi } {
  const surface = new LinkSurface(rig.host);
  const ui = surface.begin(OPTS);
  return { surface, ui };
}

describe("LinkSurface", () => {
  it("reveals the Link tab, resets the pane, and activates the Link tab on begin", () => {
    const rig = fakeHost();
    begin(rig);

    expect(rig.tabVisible).toContainEqual({ visible: true, title: OPTS.title });
    expect(rig.posted).toContainEqual({ type: "reset", title: OPTS.title, searchPlaceholder: OPTS.searchPlaceholder });
    expect(rig.activations).toContain(undefined);
  });

  it("forwards search/confirm/cancel webview messages to the registered handlers", () => {
    const rig = fakeHost();
    const { ui } = begin(rig);
    const searches: string[] = [];
    const confirms: string[] = [];
    let cancels = 0;
    ui.onSearch((value) => searches.push(value));
    ui.onConfirm((id) => confirms.push(id));
    ui.onCancel(() => { cancels += 1; });

    rig.receive({ type: "search", value: "CAL" });
    rig.receive({ type: "confirm", id: "CALC-1" });

    expect(searches).toEqual(["CAL"]);
    expect(confirms).toEqual(["CALC-1"]);

    // A confirm settles the session; a later cancel message is dropped.
    rig.receive({ type: "cancel" });
    expect(cancels).toBe(0);
  });

  it("posts row, linked, and busy updates to the webview", () => {
    const rig = fakeHost();
    const { ui } = begin(rig);
    ui.setRows([ROW]);
    ui.setLinked(LINKED);
    ui.setBusy(true);

    expect(rig.posted).toContainEqual({ type: "rows", rows: [ROW] });
    expect(rig.posted).toContainEqual({ type: "linked", rows: LINKED });
    expect(rig.posted).toContainEqual({ type: "busy", busy: true });
  });

  it("forwards openLinked and unlink webview messages to their handlers", () => {
    const rig = fakeHost();
    const { ui } = begin(rig);
    const opened: string[] = [];
    const unlinked: string[] = [];
    ui.onOpenLinked((key) => opened.push(key));
    ui.onUnlink((key) => unlinked.push(key));

    rig.receive({ type: "openLinked", key: "CALC-1" });
    rig.receive({ type: "unlink", key: "CALC-2" });

    expect(opened).toEqual(["CALC-1"]);
    expect(unlinked).toEqual(["CALC-2"]);
  });

  it("keeps the session live after a linked-row action (open/unlink never settle it)", () => {
    const rig = fakeHost();
    const { ui } = begin(rig);
    const searches: string[] = [];
    ui.onSearch((value) => searches.push(value));
    ui.onOpenLinked(() => { /* informational */ });
    ui.onUnlink(() => { /* informational */ });

    rig.receive({ type: "openLinked", key: "CALC-1" });
    rig.receive({ type: "unlink", key: "CALC-2" });
    rig.receive({ type: "search", value: "still typing" });

    expect(searches).toEqual(["still typing"]);
  });

  it("close hides the Link tab and drops the session; it is idempotent and stops posting", () => {
    const rig = fakeHost();
    const { ui } = begin(rig);
    ui.setRows([ROW]);
    const count = rig.posted.length;

    ui.close();
    expect(rig.tabVisible).toContainEqual({ visible: false, title: undefined });

    ui.setRows([ROW]);
    expect(rig.posted).toHaveLength(count);
    expect(() => ui.close()).not.toThrow();
  });

  it("re-begin supersedes a live session by firing its cancel, then reveals a fresh tab", () => {
    const rig = fakeHost();
    const surface = new LinkSurface(rig.host);
    const first = surface.begin(OPTS);
    let firstCancelled = 0;
    // The flow's onCancel settles then closes; mirror that so the supersede path can settle the tab.
    first.onCancel(() => { firstCancelled += 1; first.close(); });

    surface.begin({ title: "Link scenario to Jira test", searchPlaceholder: "Search Jira tests" });

    expect(firstCancelled).toBe(1);
    expect(rig.tabVisible).toContainEqual({ visible: true, title: "Link scenario to Jira test" });
  });

  it("fires the active session's cancel when the panel is disposed", () => {
    const rig = fakeHost();
    const { ui } = begin(rig);
    let cancels = 0;
    ui.onCancel(() => { cancels += 1; });

    rig.dispose();

    expect(cancels).toBe(1);
  });

  it("drops webview messages after a terminal confirm (settle-safety)", () => {
    const rig = fakeHost();
    const { ui } = begin(rig);
    const searches: string[] = [];
    ui.onSearch((value) => searches.push(value));
    ui.onConfirm(() => { /* settle */ });

    rig.receive({ type: "confirm", id: "CALC-1" });
    rig.receive({ type: "search", value: "late" });

    expect(searches).toEqual([]);
  });

  it("exposes the Link fragment (title/placeholder scaffolding) for the shell document", () => {
    // The pane is hydrated on begin, so the static skeleton carries the section scaffolding, not the
    // dialog text; the title and placeholder ride the reset message instead.
    const rig = fakeHost();
    begin(rig);
    expect(rig.posted[0]).toMatchObject({ type: "reset", title: OPTS.title, searchPlaceholder: OPTS.searchPlaceholder });
  });
});
