import { describe, it, expect, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import { BoardPanel } from "../../traceability/board-panel";
import type { PublishDialogModel } from "../../traceability/publish-flow";

import * as board from "./helpers/board-panel-driver";

const { deps, posted, receive, lastActivate, openReady, win } = board;

afterEach(() => win.__resetWebviewPanels());

describe("BoardPanel", () => {
  it("renders the shell: title, tabs, the drag-to-link hint, the provider label, the matrix header, and the executions table", () => {
    BoardPanel.open(deps());
    const panel = win.__webviewPanels[0]!;

    expect(panel.title).toBe("Coverage Board");
    expect(panel.webview.html).toContain("Coverage Board");
    expect(panel.webview.html).toContain("Mapping");
    expect(panel.webview.html).toContain("Matrix");
    expect(panel.webview.html).toContain("Executions");
    expect(panel.webview.html).toContain("Filter by key, tag, file");
    expect(panel.webview.html).toContain("select one scenario and one test and use the visible Link button");
    expect(panel.webview.html).toContain("Xray tests");
    expect(panel.webview.html).toContain("Requirement");
    expect(panel.webview.html).toContain("Xray test");
    expect(panel.webview.html).toContain("Tag in file");
    expect(panel.webview.html).toContain("Last result");
    expect(panel.webview.html).toContain("Pass rate");
    expect(panel.webview.html).toContain("<th>Activity</th>");
    expect(panel.webview.html).toContain("Execution activity from this workspace appears here.");
  });

  it("splits the mapping pane's test column into an available group and a mapped group", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;

    expect(html).toContain("Available Xray tests");
    expect(html).toContain('id="available-count"');
    expect(html).toContain('id="available-cards"');
    expect(html).toContain("Mapped Xray tests");
    expect(html).toContain('id="mapped-count"');
    expect(html).toContain('id="mapped-cards"');
    expect(html).toContain('id="available-toggle"');
    expect(html).toContain('aria-controls="available-content"');
    expect(html).toContain('id="mapped-toggle"');
    expect(html).toContain('aria-controls="mapped-content"');
    expect(html.match(/id="sync-now"/g)).toHaveLength(1);
    expect(html).toContain("position: sticky");
    expect(html).toContain("background: var(--vscode-editor-background)");
  });

  // Source-level only: the webview JS never runs here, so this pins that the strip ships above the panes
  // (so it shows on any tab) and that a render clears it, not that the rendered bar animates.
  it("carries the sync progress strip above the panes, cleared by every render", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;

    expect(html).toContain('id="sync-strip"');
    expect(html).toContain('id="sync-strip-text"');
    expect(html.indexOf('id="sync-strip"')).toBeLessThan(html.indexOf("<main>"));
  });

  // The app frame: the document is a flex column whose only scrollers are the panes, and one global
  // [hidden] rule (with the !important a pane's own display: flex would otherwise beat) hides every
  // surface's collapsed parts. Source-level pins, since no unit rig lays the document out.
  it("frames the document so only the panes scroll, with one hidden rule for every surface", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;

    expect(html).toContain("html, body { height: 100%; }");
    expect(html).toContain("[hidden] { display: none !important; }");
    expect(html).toContain("main { flex: 1; min-height: 0;");
    expect(html).toContain(".pane { height: 100%; box-sizing: border-box; overflow-y: auto; }");
    expect(html).toContain(".board-pane { display: flex; flex-direction: column; }");
    // One left edge for the toolbar, the strip, and the panes.
    expect(html.split("1.1rem").length - 1).toBe(3);
    // The per-surface duplicates are gone, including the two the publish and link fragments carried.
    expect(html.split("[hidden] { display: none").length - 1).toBe(1);
  });

  // The two load-bearing pieces of the half-window layout: tracks that may compress below their content,
  // and the stacking breakpoint that turns the columns into one scrolling list.
  it("gives the mapping columns compressible tracks and a stacking breakpoint", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;

    expect(html).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);");
    expect(html).toContain("@media (max-width: 540px)");
    expect(html).toContain("grid-template-columns: minmax(0, 1fr); grid-template-rows: auto;");
    expect(html).toContain(".board-pane .column { min-width: 0; min-height: 0; overflow-y: auto; }");
    // The table scroller owns the leftover height instead of guessing at the viewport.
    expect(html).toContain(".board-pane .matrix-scroll { flex: 1; min-height: 0; overflow: auto;");
    expect(html).not.toContain("100vh");
  });

  it("carries no Mapped tree markup, no drag-to-unlink drop zone, and no decorative gutter", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;
    expect(html).not.toContain("mapped-groups");
    expect(html).not.toContain("unlink-ready");
    // The gutter spent 88px on the word "drag to link"; the hint bar already says it.
    expect(html).not.toContain("gutter");
    expect(html).not.toContain("drag to link");
  });

  // Twelve verb buttons across two panes, nine compact Mapping actions plus the text Sync, Select sync
  // projects, and Execution verbs.
  it("skins every board button with the one verb class, each inside a verbs row", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;

    expect(html.split('class="verb"').length - 1).toBe(3);
    expect(html.split('class="verb icon-verb"').length - 1).toBe(9);
    expect(html).not.toContain('class="create-tests"');
    expect(html.split('<div class="verbs mapping-actions">').length - 1).toBe(3);
    expect(html.split('<div class="verbs">').length - 1).toBe(1);
  });

  // Source-level only: the webview JS never runs here. The shared section builder gives every card list
  // the same skeleton, so this pins the three per-column search boxes, the three paginators, the one
  // page-size dropdown, and the two decisions the frame owns: a count from the honest total, and a search
  // echo that only lands when the box is not focused so a repaint cannot jump a mid-type cursor.
  it("builds every mapping section with its own search box, paginator, and one shared page-size control", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;

    expect(html).toContain('id="scenario-search"');
    expect(html).toContain('id="available-search"');
    expect(html).toContain('id="mapped-search"');
    expect(html).toContain('id="scenario-paginator"');
    expect(html).toContain('id="available-paginator"');
    expect(html).toContain('id="mapped-paginator"');
    expect(html).toContain('id="page-size-select"');
    expect(html).toContain('<option value="25">25</option>');
    expect(html).toContain('<option value="50">50</option>');
    expect(html).toContain('<option value="100">100</option>');
  });

  it("loads one external client bundle and carries no executable inline script", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).toContain('src="file:///extension/dist/coverage-board.js"');
    expect(html).not.toContain("acquireVsCodeApi()");
    expect(html).not.toContain("unsafe-eval");
    expect(html).toContain('role="tablist" aria-label="Coverage views"');
    expect(html).toContain('id="scope-select" aria-label="View project" title="The project the board works in. Filters the board, loads that project, and targets create and publish. Every sync fetches it alongside the selected sync projects."');
    expect(html).toContain('id="search" type="text" spellcheck="false" autocomplete="off" aria-label="Filter coverage board"');
    expect(win.__webviewPanels[0]!.webview.options.localResourceRoots.map((uri) => uri.toString())).toEqual([
      vscode.Uri.file("/extension/dist").toString(),
    ]);
  });

  it("carries the permanent Publish tab and its pane in the shell", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;
    expect(html).toContain('data-tab="publish"');
    expect(html).toContain('id="pane-publish"');
    expect(html).toContain(">Publish</button>");
  });


  it("fires startPublish when the Publish tab is activated with no publish underway", async () => {
    const startPublish = vi.fn();
    const { panel } = await openReady({ startPublish });

    await receive(panel, { type: "tab", tab: "publish" });

    expect(lastActivate(panel)).toBe("publish");
    expect(startPublish).toHaveBeenCalledOnce();
  });

  it("does not re-fire startPublish while a publish is already being presented", async () => {
    const startPublish = vi.fn();
    const { instance, panel } = await openReady({ startPublish });

    void instance.publish.beginFlow().present({
      title: "Publish run results",
      runs: [],
      selectedRunId: "",
      jiraSearchAvailable: false,
      knownProjectKeys: [],
      attachments: { available: false, suggestions: [], uploadLimitBytes: 0, evidenceStream: "evidence" },
    });
    await receive(panel, { type: "tab", tab: "publish" });

    expect(startPublish).not.toHaveBeenCalled();
  });

  it("does not restart a confirmed publish when the Publish tab is repeatedly reactivated", async () => {
    const model: PublishDialogModel = {
      title: "Publish run results",
      runs: [{
        id: "run-1",
        label: "run-1",
        subtitle: "1 mapped result",
        project: { value: "CALC", fromDerivation: true },
        defaultSummary: "Publish run-1",
      }],
      selectedRunId: "run-1",
      jiraSearchAvailable: false,
      knownProjectKeys: ["CALC"],
      attachments: { available: false, suggestions: [], uploadLimitBytes: 0, evidenceStream: "evidence" },
    };
    const current: { instance?: BoardPanel } = {};
    const startPublish = vi.fn(() => {
      const next = current.instance!.publish.beginFlow();
      void next.present(model);
    });
    const opened = await openReady({ startPublish });
    current.instance = opened.instance;
    const instance = opened.instance;
    const panel = opened.panel;
    const first = instance.publish.beginFlow();
    const confirmed = first.present(model);
    await receive(panel, {
      surface: "publish",
      type: "confirm",
      runId: "run-1",
      request: { mode: "append", executionKey: "XNP-1" },
      attachments: [],
    });
    await confirmed;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await receive(panel, { type: "tab", tab: "mapping" });
      await receive(panel, { type: "tab", tab: "publish" });
    }

    expect(startPublish).not.toHaveBeenCalled();
    expect(posted(panel).filter((message) => message.type === "settled")).toHaveLength(0);
    expect(posted(panel).filter((message) => message.type === "publish-busy").at(-1)).toMatchObject({ busy: true });

    expect(first.markSettled()).toBe(true);
    await receive(panel, { type: "tab", tab: "publish" });
    await receive(panel, { type: "tab", tab: "publish" });

    expect(startPublish).toHaveBeenCalledOnce();
  });

  // The stub keeps whatever the host assigns, so this pins that both themes reach the tab. Resolving the
  // media Uris off the extension root is the command layer's job and is not exercised here.
  it("puts the light and dark tab icons on the panel when the host supplies them", () => {
    const tabIcon = {
      light: vscode.Uri.file("/ext/media/coverage-board-light.svg"),
      dark: vscode.Uri.file("/ext/media/coverage-board-dark.svg"),
    };

    BoardPanel.open(deps({ tabIcon }));

    expect((win.__webviewPanels[0] as unknown as { iconPath?: unknown }).iconPath).toEqual(tabIcon);
  });

  it("opens without a tab icon when the host has no extension root to resolve one from", () => {
    BoardPanel.open(deps());

    expect((win.__webviewPanels[0] as unknown as { iconPath?: unknown }).iconPath).toBeUndefined();
  });

  it("reveals the existing panel instead of opening a second (singleton surface)", () => {
    BoardPanel.open(deps());
    BoardPanel.open(deps());

    expect(win.__webviewPanels).toHaveLength(1);
    expect(win.__webviewPanels[0]!.__revealCount).toBe(1);
  });


});
