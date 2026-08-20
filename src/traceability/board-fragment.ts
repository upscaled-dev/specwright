import { escapeHtml } from "../utils/webview";
import { SurfaceFragment } from "./webview-host";

// Each board pane fills main and owns its own scrolling. Mapping is a flex column whose two card
// columns scroll independently; Matrix and Executions hand all their leftover height to the one
// scroller that holds the sticky-headed table. `minmax(0, 1fr)` is what lets the card columns compress
// below their content: plain `1fr` refuses to, and the whole document scrolls sideways instead.
const BOARD_CSS = `
  .board-pane { display: flex; flex-direction: column; }
  .board-pane .mapping-hint { flex: none; margin: 0 0 0.6rem; padding: 0.5rem 0.7rem; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); border-radius: 5px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); color: var(--vscode-descriptionForeground); font-size: 0.85em; line-height: 1.4; }
  .board-pane .columns { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 0.75rem; }
  .board-pane .column { min-width: 0; min-height: 0; overflow-y: auto; }
  .board-pane .section-chrome { position: sticky; top: 0; z-index: 3; padding: 0.15rem 0 0.05rem; background: var(--vscode-editor-background); }
  .board-pane .column h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); font-weight: 600; margin: 0 0 0.6rem; }
  .board-pane .section-toggle { display: flex; width: 100%; align-items: center; gap: 0.35rem; padding: 0; border: none; background: transparent; color: inherit; font: inherit; text-align: left; text-transform: inherit; letter-spacing: inherit; cursor: pointer; }
  .board-pane .section-toggle::before { content: '▾'; width: 0.8rem; }
  .board-pane .section-toggle[aria-expanded="false"]::before { content: '▸'; }
  .board-pane .section-toggle:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .board-pane .count { color: var(--vscode-descriptionForeground); font-weight: 400; }
  .board-pane .cards { display: flex; flex-direction: column; gap: 0.375rem; }
  .board-pane .card {
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
    border-radius: 5px;
    padding: 0.45rem 0.55rem;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  .board-pane .card .title { font-weight: 600; word-break: break-word; }
  .board-pane .card .pick { display: flex; align-items: flex-start; gap: 0.45rem; }
  .board-pane .card .pick input { margin: 0.15rem 0 0; }
  .board-pane .verb { padding: 0.25rem 0.7rem; font-family: inherit; font-size: 0.78rem; border: none; border-radius: 3px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
  .board-pane .verb:hover:enabled { background: var(--vscode-button-hoverBackground); }
  .board-pane .verb:disabled { opacity: 0.55; cursor: default; }
  .board-pane .verbs { position: relative; flex: none; display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0 0 0.6rem; min-height: 1.5rem; }
  .board-pane .select-all { flex: none; align-self: center; }
  .board-pane .container-actions { display: flex; gap: 0.25rem; padding-right: 0.15rem; }
  .board-pane .container-actions + .container-actions { padding-left: 0.4rem; border-left: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); }
  .board-pane .mapping-action-controls { flex: none; display: flex; flex-wrap: wrap; gap: 0.4rem; min-width: 0; }
  .board-pane .mapping-action-helper { flex: 1 1 10rem; min-width: 0; padding-top: 0.25rem; color: var(--vscode-descriptionForeground); font-size: 0.78rem; line-height: 1.3; overflow-wrap: anywhere; }
  .board-pane .icon-verb-tooltip { display: inline-flex; }
  .board-pane .icon-verb { display: inline-flex; width: 1.75rem; height: 1.65rem; align-items: center; justify-content: center; padding: 0; }
  .board-pane .icon-verb:disabled { pointer-events: none; }
  .board-pane .icon-verb svg { width: 1.05rem; height: 1.05rem; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
  .board-pane .icon-verb-tooltip-content { position: absolute; z-index: 2; top: calc(100% + 0.35rem); left: 0; box-sizing: border-box; width: max-content; max-width: min(100%, calc(100vw - 2rem)); padding: 0.3rem 0.45rem; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); border-radius: 3px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); color: var(--vscode-editorWidget-foreground, var(--vscode-foreground)); font-size: 0.78rem; line-height: 1.3; white-space: normal; visibility: hidden; opacity: 0; pointer-events: none; }
  .board-pane .icon-verb-tooltip:hover .icon-verb-tooltip-content, .board-pane .icon-verb-tooltip:focus-within .icon-verb-tooltip-content { visibility: visible; opacity: 1; }
  .board-pane .card .key { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); }
  .board-pane .card .meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 0.2rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .board-pane .pills { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.4rem; }
  .board-pane .pill { font-size: 0.72rem; padding: 0.08rem 0.4rem; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .board-pane .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 0.4rem 0; }
  .board-pane .mapping-top { flex: none; display: flex; align-items: flex-start; gap: 0.75rem; margin: 0 0 0.6rem; }
  .board-pane .mapping-top .mapping-hint { flex: 1; margin: 0; }
  .board-pane .mapping-toolbar { flex: none; display: flex; align-items: center; gap: 0.5rem; }
  .board-pane .page-size { flex: none; display: flex; align-items: center; gap: 0.35rem; color: var(--vscode-descriptionForeground); font-size: 0.82em; }
  .board-pane .page-size select { padding: 0.3rem 0.4rem; color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); background: var(--vscode-dropdown-background, var(--vscode-input-background)); border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent)); border-radius: 3px; font-family: inherit; font-size: inherit; }
  .board-pane .page-size select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .board-pane .section + .section { margin-top: 0.9rem; }
  .board-pane .section-search { flex: none; margin: 0 0 0.6rem; }
  .board-pane .section-search input { width: 100%; box-sizing: border-box; padding: 0.35rem 0.5rem; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; font-family: inherit; font-size: inherit; }
  .board-pane .section-search input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .board-pane .paginator { flex: none; display: flex; align-items: center; gap: 0.5rem; min-height: 1.6rem; margin-top: 0.5rem; color: var(--vscode-descriptionForeground); font-size: 0.82em; }
  .board-pane .paginator .range { flex: 1; text-align: center; }
  .board-pane .pill-button { font-family: inherit; font-size: 0.72rem; padding: 0.05rem 0.45rem; border: none; border-radius: 999px; background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); cursor: pointer; }
  .board-pane .pill-button:hover:enabled { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
  .board-pane .pill-button:disabled { cursor: default; }
  .board-pane .card[draggable="true"] { cursor: grab; }
  .board-pane .card.drop-target { outline: 2px dashed var(--vscode-focusBorder); outline-offset: -2px; }
  .board-pane .link-row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0.35rem 0.5rem; padding-top: 0.4rem; margin-top: 0.45rem; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); }
  .board-pane .link-row .name { flex: 1 1 12rem; min-width: 0; word-break: break-word; }
  .board-pane .link-row .row-actions { display: flex; flex-wrap: nowrap; gap: 0.3rem; margin-left: auto; }
  .board-pane .matrix-scroll { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); border-radius: 5px; }
  .board-pane table.matrix { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  .board-pane table.matrix th, .board-pane table.matrix td { text-align: left; padding: 0.4rem 0.6rem; white-space: nowrap; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); }
  .board-pane table.matrix thead th { position: sticky; top: 0; z-index: 1; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); font-weight: 600; }
  .board-pane table.matrix td.hole { background: var(--vscode-inputValidation-warningBackground, transparent); }
  .board-pane table.matrix .key { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); }
  .board-pane table.matrix .wrap { white-space: normal; overflow-wrap: anywhere; min-width: 10rem; }
  .board-pane table.matrix a.link { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  .board-pane table.matrix a.link:hover { text-decoration: underline; }
  .board-pane table.matrix td.group-cell { padding: 0; }
  .board-pane table.matrix td.older-cell { text-align: center; }
  .board-pane .group-toggle { display: flex; width: 100%; align-items: baseline; gap: 0.4rem; padding: 0.4rem 0.6rem; border: none; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); color: var(--vscode-foreground); font-family: inherit; font-size: inherit; font-weight: 600; text-align: left; cursor: pointer; }
  .board-pane .group-toggle:hover { background: var(--vscode-list-hoverBackground, var(--vscode-editorWidget-background)); }
  .board-pane table.matrix tr.execution-parent th, .board-pane table.matrix tr.execution-parent td { background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); font-weight: 600; }
  .board-pane .execution-toggle { width: 1.4rem; margin: 0 0.3rem 0 0; padding: 0; border: none; background: transparent; color: var(--vscode-foreground); font-family: inherit; cursor: pointer; }
  .board-pane .execution-toggle:hover { color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); }
  .board-pane tr.execution-child td:first-child { padding-left: 1.4rem; color: var(--vscode-descriptionForeground); }
  #executions-empty { flex: none; }
  @media (max-width: 540px) {
    .board-pane .columns { flex: none; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto; }
    .board-pane .column { overflow: visible; }
    .board-pane .container-actions { flex-basis: 100%; }
    .board-pane .container-actions + .container-actions { padding-left: 0; border-left: none; }
    .board-pane .mapping-actions { flex-direction: column; align-items: stretch; }
    .board-pane .mapping-action-helper { flex: none; }
  }`;

// One card-list section's fixed skeleton, top to bottom: header, verbs row, search row, cards region,
// paginator. Every mapping section is emitted through this, so the first section of each column shares row
// heights by construction and the columns line up. `verbs` is trusted button markup; every other field is
// a label, so it escapes.
interface MappingSectionSpec {
  readonly id: string;
  readonly title: string;
  readonly verbs: string;
  readonly placeholder: string;
  readonly searchLabel: string;
  readonly collapsible?: boolean;
  readonly sharedHelper?: boolean;
}

function mappingSection(spec: MappingSectionSpec): string {
  const heading = spec.collapsible
    ? `<h2><button id="${spec.id}-toggle" class="section-toggle" type="button" aria-expanded="true" aria-controls="${spec.id}-content">${escapeHtml(spec.title)} <span id="${spec.id}-count" class="count" role="status" aria-live="polite"></span></button></h2>`
    : `<h2>${escapeHtml(spec.title)} <span id="${spec.id}-count" class="count" role="status" aria-live="polite"></span></h2>`;
  const helperData = spec.sharedHelper ? " data-mapping-helper" : "";
  return `          <section class="section">
            <div class="section-chrome"><div class="section-head">${heading}</div>
              <div class="verbs mapping-actions"><div class="mapping-action-controls">${spec.verbs}</div><span id="${spec.id}-action-helper" class="mapping-action-helper"${helperData}></span></div>
            </div>
            <div id="${spec.id}-content">
              <div class="section-search"><input id="${spec.id}-search" type="text" spellcheck="false" autocomplete="off" placeholder="${escapeHtml(spec.placeholder)}" aria-label="${escapeHtml(spec.searchLabel)}"></div>
              <div id="${spec.id}-cards" class="cards"></div>
              <div id="${spec.id}-paginator" class="paginator"></div>
            </div>
          </section>`;
}

function iconAction(id: string, label: string, icon: string, action?: string): string {
  const dataAction = action === undefined ? "" : ` data-mapping-action="${action}"`;
  return `<span class="icon-verb-tooltip"><button id="${id}" class="verb icon-verb" type="button" disabled aria-label="${label}" aria-describedby="${id}-tooltip"${dataAction}><svg viewBox="0 0 17 16" aria-hidden="true" focusable="false">${icon}</svg></button><span id="${id}-tooltip" class="icon-verb-tooltip-content" role="tooltip">${label}</span></span>`;
}

function containerAction(id: string, label: string, shape: "set" | "plan", action: "create" | "add", command: string): string {
  const base = shape === "set"
    ? `<rect x="1.5" y="2.5" width="9" height="11" rx="1.2"></rect><path d="M4 5.5h4M4 8h4M4 10.5h3"></path>`
    : `<rect x="1.5" y="3.5" width="9" height="10" rx="1.2"></rect><path d="M1.5 6.5h9M4 1.8v3.4M8 1.8v3.4"></path>`;
  const badge = action === "create"
    ? `<path d="M13 8.5v5M10.5 11h5"></path>`
    : `<path d="M10.5 11h5M13.5 8.5 16 11l-2.5 2.5"></path>`;
  return iconAction(id, label, `${base}${badge}`, command);
}

// The list's own toolbar: its select-all box, then the four container actions. The box ships disabled and
// unchecked; the host decides checked, mixed, or clear over the whole filtered list on every render.
function mappingActions(section: "available" | "mapped", providerLabel: string): string {
  const selectAll = escapeHtml(`Select all ${section} ${providerLabel} tests`);
  return `<input id="${section}-select-all" class="select-all" type="checkbox" disabled aria-label="${selectAll}" aria-controls="${section}-cards">
            <span class="container-actions" role="group" aria-label="Test Set actions">${containerAction(`${section}-create-test-set`, "Create Test Set", "set", "create", "createTestSet")}${containerAction(`${section}-add-to-test-set`, "Add to existing Test Set", "set", "add", "addToTestSet")}</span>
            <span class="container-actions" role="group" aria-label="Test Plan actions">${containerAction(`${section}-create-test-plan`, "Create Test Plan", "plan", "create", "createTestPlan")}${containerAction(`${section}-add-to-test-plan`, "Add to existing Test Plan", "plan", "add", "addToTestPlan")}</span>`;
}

function boardPanesHtml(providerLabel: string): string {
  const testColumn = escapeHtml(`${providerLabel} test`);
  const untraced = mappingSection({
    id: "scenario",
    title: "Untraced scenarios",
    verbs: iconAction("create-tests", "Create tests", `<rect x="1.5" y="3" width="9" height="9" rx="1.5"></rect><path d="M4 7.5l1.6 1.6L8.5 6M13 9v5M10.5 11.5h5"></path>`),
    placeholder: "Filter scenarios",
    searchLabel: "Filter untraced scenarios",
  });
  const available = mappingSection({
    id: "available",
    title: `Available ${providerLabel} tests`,
    verbs: mappingActions("available", providerLabel),
    placeholder: "Filter by key or summary",
    searchLabel: `Filter available ${providerLabel} tests`,
    collapsible: true,
    sharedHelper: true,
  });
  const mapped = mappingSection({
    id: "mapped",
    title: `Mapped ${providerLabel} tests`,
    verbs: mappingActions("mapped", providerLabel),
    placeholder: "Filter by key or summary",
    searchLabel: `Filter mapped ${providerLabel} tests`,
    collapsible: true,
    sharedHelper: true,
  });
  return `    <section id="pane-mapping" class="pane board-pane" data-tab="mapping" role="tabpanel" aria-labelledby="tab-mapping" hidden>
      <div class="mapping-top">
        <p class="mapping-hint">Drag a scenario onto a test to link them, or select one scenario and one test and use the visible Link button.</p>
        <div class="mapping-toolbar">
          <button id="sync-now" class="verb" type="button" disabled>Sync now</button>
          <div class="page-size">
            <label for="page-size-select">Rows</label>
            <select id="page-size-select" title="How many cards each list shows">
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </div>
        </div>
      </div>
      <div class="columns">
        <div class="column">
${untraced}
        </div>
        <div class="column">
${available}
${mapped}
        </div>
      </div>
    </section>
    <section id="pane-matrix" class="pane board-pane" data-tab="matrix" role="tabpanel" aria-labelledby="tab-matrix" hidden>
      <div class="matrix-scroll">
        <table class="matrix">
          <thead>
            <tr><th>Requirement</th><th>${testColumn}</th><th>Scenario</th><th>Tag in file</th><th>Last result</th></tr>
          </thead>
          <tbody id="matrix-rows"></tbody>
        </table>
      </div>
    </section>
    <section id="pane-executions" class="pane board-pane" data-tab="executions" role="tabpanel" aria-labelledby="tab-executions" hidden>
      <div class="verbs">
        <button id="create-execution" class="verb" type="button" disabled>Create Execution</button>
      </div>
      <div id="executions-empty" class="empty" hidden>Execution activity from this workspace appears here.</div>
      <div id="executions-scroll" class="matrix-scroll">
        <table class="matrix">
          <thead>
            <tr><th>Execution</th><th>Summary</th><th>Action</th><th>Imported</th><th>Pass rate</th><th>Date</th><th>Activity</th></tr>
          </thead>
          <tbody id="executions-rows"></tbody>
        </table>
      </div>
    </section>`;
}

export function boardFragment(providerLabel: string): SurfaceFragment {
  return { css: BOARD_CSS, paneHtml: boardPanesHtml(providerLabel) };
}
