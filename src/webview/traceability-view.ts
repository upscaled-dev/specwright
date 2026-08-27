import {
  parseTraceabilityHostEnvelope,
  TRACEABILITY_SELECTION_LIMIT,
  TRACEABILITY_VIEW_PROTOCOL_VERSION,
  type TraceabilityWireRow,
} from "./traceability-view-protocol";
import { createTraceabilityPreviewDialog } from "./traceability-preview-dialog";
import { installTraceabilityTabs, type TraceabilityViewTab } from "./traceability-view-tabs";
import {
  pageSize,
  revealIndex,
  selectionRange,
  TRACEABILITY_ROW_HEIGHT,
  visibleWindow,
} from "./traceability-tree-navigation";

const SELECTION_LIMIT = TRACEABILITY_SELECTION_LIMIT;
const FILTER_LIMIT = 4_096;
const COLLAPSED_ROOT_LIMIT = 512;
const filter = document.getElementById("filter") as HTMLInputElement;
const tree = document.getElementById("tree") as HTMLElement;
const status = document.getElementById("status") as HTMLElement | null;
const tabs = [...document.querySelectorAll<HTMLButtonElement>("#tabs [role=tab]")];
const previewDialog = document.getElementById("preview") as HTMLDialogElement;
const previewTitle = document.getElementById("preview-title") as HTMLElement;
const previewSummary = document.getElementById("preview-summary") as HTMLElement;
const previewMembers = document.getElementById("preview-members") as HTMLElement;
const cancelPreview = document.getElementById("cancel-preview") as HTMLButtonElement;
const confirmPreview = document.getElementById("confirm-preview") as HTMLButtonElement;
const vscode = acquireVsCodeApi();
const session = document.body.dataset["session"] ?? "";

let revision = 0;
let generation = 0;
let incoming: TraceabilityWireRow[] | undefined;
let incomingGeneration = 0;
let incomingTotal = 0;
let incomingState = "empty";
let rows: TraceabilityWireRow[] = [];
let state = "empty";
let shown: TraceabilityWireRow[] = [];
let focusId: string | undefined;
let selectionAnchorId: string | undefined;
let rowById = new Map<string, TraceabilityWireRow>();
let depthById = new Map<string, number>();
let siblingPositionById = new Map<string, number>();
let siblingCountById = new Map<string, number>();
let rootIds = new Set<string>();
let filterPersistTimer: ReturnType<typeof setTimeout> | undefined;
// Focus and the range anchor belong to the tab that owns their row; the selection spans all tabs.
const focusByView = new Map<TraceabilityViewTab, string>();
const anchorByView = new Map<TraceabilityViewTab, string>();

const restored = vscode.getState();
const restoredView = restored?.["view"];
let activeView: TraceabilityViewTab = restoredView === "repository" || restoredView === "test-sets" ? restoredView : "workspace";
let query = typeof restored?.["filter"] === "string" ? restored["filter"].slice(0, FILTER_LIMIT) : "";
const expanded = new Set<string>(strings(restored?.["expanded"]));
const collapsedRoots = new Set<string>(strings(restored?.["collapsedRoots"]).slice(-COLLAPSED_ROOT_LIMIT));
let selected = new Set<string>(strings(restored?.["selected"]).slice(0, SELECTION_LIMIT));
selectionAnchorId = selected.values().next().value;
filter.value = query;
filter.maxLength = FILTER_LIMIT;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function post(body: unknown): void {
  if (incoming === undefined) {
    vscode.postMessage({ version: TRACEABILITY_VIEW_PROTOCOL_VERSION, session, revision, surface: "traceability", body });
  }
}

const preview = createTraceabilityPreviewDialog({
  dialog: previewDialog,
  title: previewTitle,
  summary: previewSummary,
  members: previewMembers,
  cancel: cancelPreview,
  confirm: confirmPreview,
  post,
  generation: () => generation,
});

function persist(): void {
  vscode.setState({ view: activeView, filter: query, expanded: [...expanded], collapsedRoots: [...collapsedRoots], selected: [...selected] });
}

function persistFilter(): void {
  if (filterPersistTimer) {
    clearTimeout(filterPersistTimer);
  }
  filterPersistTimer = setTimeout(() => {
    filterPersistTimer = undefined;
    persist();
  }, 120);
}

function isExpanded(id: string): boolean {
  return rootIds.has(id) ? !collapsedRoots.has(id) : expanded.has(id);
}

function refreshVisible(): void {
  const viewRows = rows.filter((row) => (row.view ?? "workspace") === activeView);
  rowById = new Map(viewRows.map((row) => [row.id, row]));
  depthById = new Map();
  for (const row of viewRows) {
    depthById.set(row.id, row.parentId ? (depthById.get(row.parentId) ?? 0) + 1 : 1);
  }
  rootIds = new Set(viewRows.filter((row) => row.expandable && row.parentId === undefined).map((row) => row.id));

  if (state !== "ready") {
    shown = [];
    return;
  }

  const needle = query.trim().toLocaleLowerCase();
  const matches = new Set<string>();
  for (const row of viewRows) {
    const content = `${row.label} ${row.description ?? ""} ${row.tooltip ?? ""}`.toLocaleLowerCase();
    if (!needle || content.includes(needle)) {
      let current: TraceabilityWireRow | undefined = row;
      while (current) {
        matches.add(current.id);
        current = current.parentId ? rowById.get(current.parentId) : undefined;
      }
    }
  }

  shown = viewRows.filter((row) => {
    if (needle) {
      return matches.has(row.id);
    }
    if (!matches.has(row.id)) {
      return false;
    }
    let parent = row.parentId ? rowById.get(row.parentId) : undefined;
    while (parent) {
      if (!isExpanded(parent.id)) {
        return false;
      }
      parent = parent.parentId ? rowById.get(parent.parentId) : undefined;
    }
    return true;
  });

  siblingPositionById = new Map();
  siblingCountById = new Map();
  const siblings = new Map<string, TraceabilityWireRow[]>();
  for (const row of shown) {
    const parent = row.parentId ?? "";
    const items = siblings.get(parent) ?? [];
    items.push(row);
    siblings.set(parent, items);
  }
  for (const items of siblings.values()) {
    for (let index = 0; index < items.length; index += 1) {
      const id = items[index]?.id;
      if (id) {
        siblingPositionById.set(id, index + 1);
        siblingCountById.set(id, items.length);
      }
    }
  }

  const known = new Set(rows.map((row) => row.id));
  selected = new Set([...selected].filter((id) => known.has(id)).slice(0, SELECTION_LIMIT));
  if (selectionAnchorId && !known.has(selectionAnchorId)) {
    selectionAnchorId = selected.values().next().value;
  }
  if (!shown.some((row) => row.id === focusId)) {
    focusId = shown[0]?.id;
  }
  if (!shown.some((row) => row.id === selectionAnchorId)) {
    selectionAnchorId = focusId;
  }
}

function selectView(view: TraceabilityViewTab): void {
  if (view !== activeView) {
    if (focusId) {focusByView.set(activeView, focusId);}
    if (selectionAnchorId) {anchorByView.set(activeView, selectionAnchorId);}
    activeView = view;
    focusId = focusByView.get(view);
    selectionAnchorId = anchorByView.get(view);
  }
  filter.placeholder = activeView === "workspace" ? "Filter workspace" : activeView === "repository" ? "Filter repository" : "Filter Test Sets";
  refreshVisible();
  tree.scrollTop = 0;
  persist();
  render();
}
installTraceabilityTabs(tabs, activeView, selectView);

function defaultAction(row: TraceabilityWireRow): string | undefined {
  return row.defaultAction;
}

function stateMessage(): string {
  if (state === "disconnected") {
    return "Set up Xray integration to map scenarios and publish results.";
  }
  if (state === "untrusted") {
    return "Traceability stays offline while this workspace is untrusted.";
  }
  return "Add @TEST_KEY tags to scenarios. Local mappings update automatically.";
}

function render(restoreFocus = false): void {
  if (state !== "ready") {
    renderState();
    return;
  }
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", "Traceability tree");
  tree.setAttribute("aria-multiselectable", "true");

  const window = visibleWindow(tree.scrollTop, tree.clientHeight, shown.length);
  const fragment = document.createDocumentFragment();
  const spacer = document.createElement("div");
  spacer.className = "spacer";
  spacer.style.height = `${shown.length * TRACEABILITY_ROW_HEIGHT}px`;
  spacer.setAttribute("role", "presentation");
  fragment.append(spacer);

  for (let index = window.start; index < window.end; index += 1) {
    const row = shown[index];
    if (row) {
      fragment.append(renderRow(row, index));
    }
  }
  tree.tabIndex = shown.length === 0 ? 0 : -1;
  tree.replaceChildren(fragment);
  if (restoreFocus && focusId) {
    focusRow(focusId);
  }
}

function renderState(): void {
  tree.setAttribute("role", "region");
  tree.setAttribute("aria-label", "Traceability status");
  tree.removeAttribute("aria-multiselectable");
  tree.tabIndex = 0;
  const row = rows[0];
  const title = document.createElement("p");
  title.className = "state-title";
  title.textContent = row?.label ?? "Traceability";
  const message = document.createElement("p");
  message.className = "state";
  message.textContent = row?.description ?? stateMessage();
  const fragment = document.createDocumentFragment();
  fragment.append(title, message);
  if (row?.actions.length) {
    const actions = document.createElement("div");
    actions.className = "state-actions";
    for (const action of row.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.title = action.label;
      button.setAttribute("aria-label", action.label);
      button.append(iconElement(action.icon));
      button.disabled = incoming !== undefined;
      button.onclick = () => post({ type: "action", generation, id: row.id, action: action.id, selection: [] });
      actions.append(button);
    }
    fragment.append(actions);
  }
  tree.replaceChildren(fragment);
}

function renderRow(row: TraceabilityWireRow, index: number): HTMLElement {
  const element = document.createElement("div");
  element.className = `row tone-${row.tone ?? "muted"}`;
  element.role = "treeitem";
  element.dataset["id"] = row.id;
  element.style.position = "absolute";
  element.style.top = `${index * TRACEABILITY_ROW_HEIGHT}px`;
  element.style.left = "0";
  element.style.right = "0";
  element.style.paddingLeft = `${(depthById.get(row.id) ?? 1) * 16 - 12}px`;
  element.tabIndex = focusId === row.id ? 0 : -1;
  element.setAttribute("aria-level", String(depthById.get(row.id) ?? 1));
  element.setAttribute("aria-selected", String(selected.has(row.id)));
  element.setAttribute("aria-posinset", String(siblingPositionById.get(row.id) ?? 1));
  element.setAttribute("aria-setsize", String(siblingCountById.get(row.id) ?? 1));
  if (row.expandable) {
    element.setAttribute("aria-expanded", String(isExpanded(row.id)));
    const twisty = document.createElement("button");
    twisty.type = "button";
    twisty.className = "twisty";
    twisty.append(iconElement(isExpanded(row.id) ? "chevron-down" : "chevron-right"));
    twisty.setAttribute("aria-label", `Toggle ${row.label}`);
    twisty.tabIndex = -1;
    twisty.disabled = incoming !== undefined;
    twisty.onclick = (event) => {
      event.stopPropagation();
      if (incoming === undefined) {
        toggle(row.id);
      }
    };
    twisty.onkeydown = (event) => event.stopPropagation();
    element.append(twisty);
  }

  element.append(iconElement(row.icon, true));

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = row.label;
  label.title = row.tooltip ?? row.label;
  element.append(label);
  if (row.description) {
    const description = document.createElement("span");
    description.className = "description";
    description.textContent = row.description;
    element.append(description);
  }

  const actions = document.createElement("span");
  actions.className = "actions";
  for (const action of row.actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = action.label;
    button.disabled = incoming !== undefined;
    button.setAttribute("aria-label", `${action.label}: ${row.label}`);
    button.append(iconElement(action.icon));
    button.onclick = (event) => {
      event.stopPropagation();
      if (incoming === undefined) {
        post({ type: "action", generation, id: row.id, action: action.id, selection: [...selected] });
      }
    };
    button.onkeydown = (event) => event.stopPropagation();
    actions.append(button);
  }
  element.append(actions);
  element.onclick = (event) => {
    if (select(row.id, event as MouseEvent)) {
      const action = defaultAction(row);
      if (action) {
        post({ type: "action", generation, id: row.id, action, selection: [...selected] });
      }
    }
  };
  element.onkeydown = (event) => keydown(event, row);
  return element;
}

function iconElement(icon: string, stateIcon = false): HTMLElement {
  const element = document.createElement("span");
  element.classList.add("codicon", `codicon-${icon}`);
  if (icon === "loading") { element.classList.add("codicon-modifier-spin"); }
  if (stateIcon) { element.classList.add("state-icon"); }
  element.dataset["icon"] = icon;
  element.setAttribute("aria-hidden", "true");
  return element;
}

function toggle(id: string): void {
  if (rootIds.has(id)) {
    if (isExpanded(id)) {
      collapsedRoots.delete(id);
      collapsedRoots.add(id);
      while (collapsedRoots.size > COLLAPSED_ROOT_LIMIT) {
        const oldest = collapsedRoots.values().next().value;
        if (typeof oldest === "string") { collapsedRoots.delete(oldest); }
      }
    } else {
      collapsedRoots.delete(id);
    }
  } else if (expanded.has(id)) {
    expanded.delete(id);
  } else {
    expanded.add(id);
  }
  persist();
  refreshVisible();
  focusId = id;
  render(true);
}

function select(id: string, event: MouseEvent): boolean {
  if (incoming !== undefined) {
    return false;
  }
  const multiSelect = event.shiftKey || event.metaKey || event.ctrlKey;
  if (event.shiftKey && (selectionAnchorId ?? focusId)) {
    const ids = shown.map((row) => row.id);
    const anchor = selectionAnchorId ?? focusId;
    if (anchor) {
      selected = new Set(selectionRange(ids, anchor, id, SELECTION_LIMIT));
      selectionAnchorId = anchor;
    }
  } else if (event.metaKey || event.ctrlKey) {
    if (selected.has(id)) {
      selected.delete(id);
    } else if (selected.size < SELECTION_LIMIT) {
      selected.add(id);
    } else {
      announce(`Selection is limited to ${SELECTION_LIMIT} rows.`);
    }
    selectionAnchorId = id;
  } else {
    selected = new Set([id]);
    selectionAnchorId = id;
  }
  focusId = id;
  persist();
  render(true);
  return !multiSelect;
}

function keydown(event: KeyboardEvent, row: TraceabilityWireRow): void {
  if (incoming !== undefined) {
    return;
  }
  const index = shown.indexOf(row);
  const move = (next: number, extend = event.shiftKey, preserveSelection = event.ctrlKey || event.metaKey): void => {
    const target = shown[Math.max(0, Math.min(shown.length - 1, next))];
    if (!target) {
      return;
    }
    const previous = focusId;
    focusId = target.id;
    if (extend && previous) {
      const ids = shown.map((candidate) => candidate.id);
      const anchor = selectionAnchorId ?? previous;
      selected = new Set(selectionRange(ids, anchor, target.id, SELECTION_LIMIT));
      selectionAnchorId = anchor;
    } else if (!preserveSelection) {
      selected = new Set([target.id]);
      selectionAnchorId = target.id;
    }
    persist();
    tree.scrollTop = revealIndex(targetIndex(target.id), tree.scrollTop, tree.clientHeight, shown.length);
    render();
    focusRow(target.id);
  };
  if (event.key === "ArrowDown") {
    event.preventDefault();
    move(index + 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    move(index - 1);
  } else if (event.key === "Home") {
    event.preventDefault();
    move(0);
  } else if (event.key === "End") {
    event.preventDefault();
    move(shown.length - 1);
  } else if (event.key === "PageDown") {
    event.preventDefault();
    move(index + pageSize(tree.clientHeight));
  } else if (event.key === "PageUp") {
    event.preventDefault();
    move(index - pageSize(tree.clientHeight));
  } else if (event.key === "ArrowRight" && row.expandable) {
    event.preventDefault();
    if (!isExpanded(row.id)) {
      toggle(row.id);
    } else {
      const child = shown[index + 1];
      if (child?.parentId === row.id) {
        move(index + 1);
      }
    }
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    if (row.expandable && isExpanded(row.id)) {
      toggle(row.id);
    } else if (row.parentId) {
      const parentIndex = shown.findIndex((candidate) => candidate.id === row.parentId);
      if (parentIndex >= 0) {
        move(parentIndex);
      }
    }
  } else if (event.key === " " && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    if (selected.has(row.id)) {
      selected.delete(row.id);
    } else if (selected.size < SELECTION_LIMIT) {
      selected.add(row.id);
    } else {
      announce(`Selection is limited to ${SELECTION_LIMIT} rows.`);
    }
    selectionAnchorId = row.id;
    persist();
    render(true);
  } else if (event.key === " " || event.key === "Enter") {
    event.preventDefault();
    if (row.expandable) {
      toggle(row.id);
    } else {
      const action = defaultAction(row);
      if (action) {
        post({ type: "action", generation, id: row.id, action, selection: [...selected] });
      }
    }
  }
}

function targetIndex(id: string): number {
  return Math.max(0, shown.findIndex((row) => row.id === id));
}

function focusRow(id: string): void {
  for (const candidate of document.querySelectorAll<HTMLElement>("[data-id]")) {
    if (candidate.dataset["id"] === id) {
      candidate.focus();
      return;
    }
  }
}

function announce(message: string): void {
  if (status) {
    status.textContent = message;
  } else {
    tree.setAttribute("aria-description", message);
  }
}

filter.oninput = () => {
  query = filter.value.slice(0, FILTER_LIMIT);
  filter.value = query;
  persistFilter();
  refreshVisible();
  tree.scrollTop = 0;
  render();
};
tree.onscroll = () => render();
window.addEventListener("resize", () => render());

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = parseTraceabilityHostEnvelope(event.data, session, revision);
  if (!message) {
    return;
  }
  revision = message.revision;
  const body = message.body;
  if (body.type === "begin") {
    if (body.generation <= generation) {
      return;
    }
    preview.close();
    incoming = [];
    incomingGeneration = body.generation;
    incomingTotal = body.total;
    incomingState = body.state;
    tree.setAttribute("aria-busy", "true");
    tree.setAttribute("aria-disabled", "true");
    return;
  }
  if (body.type === "preview") {
    if (body.generation === generation && incoming === undefined) {preview.show(body.preview);}
    return;
  }
  if (body.type === "chunk") {
    if (incoming === undefined || body.generation !== incomingGeneration || body.offset !== incoming.length || incoming.length + body.rows.length > incomingTotal) {
      return;
    }
    incoming.push(...body.rows);
    return;
  }
  if (body.type === "end") {
    if (incoming === undefined || body.generation !== incomingGeneration || incoming.length !== incomingTotal) {
      return;
    }
    rows = incoming;
    generation = body.generation;
    state = incomingState;
    incoming = undefined;
    tree.removeAttribute("aria-busy");
    tree.removeAttribute("aria-disabled");
    if (state === "ready") {
      const currentIds = new Set(rows.map((row) => row.id));
      for (const id of expanded) {
        if (!currentIds.has(id)) {
          expanded.delete(id);
        }
      }
    }
    refreshVisible();
    for (const id of rootIds) {expanded.delete(id);}
    persist();
    render();
    return;
  }
  if (body.type === "focus-filter" && body.generation === generation && incoming === undefined) {
    filter.focus();
    post({ type: "focused", generation });
  }
});

post({ type: "ready" });
