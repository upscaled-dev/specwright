import type {
  ExecutionActivityRow,
  ExecutionGroup,
  ExecutionRow,
  MatrixGroup,
  MatrixRow,
  UnknownExecutionRow,
} from "../protocol";

export interface BoardTables {
  renderMatrix(groups: readonly MatrixGroup[], filtering: boolean): void;
  renderExecutions(rows: readonly ExecutionRow[], filtering: boolean): void;
}

export function installBoardTables(): BoardTables {
  const element = <T extends HTMLElement>(id: string): T => {
    const found = document.getElementById(id);
    if (!found) {throw new Error(`Missing board element: ${id}`);}
    return found as T;
  };
  const matrixRows = element<HTMLTableSectionElement>("matrix-rows");
  const executionsRows = element<HTMLTableSectionElement>("executions-rows");
  const executionsEmpty = element<HTMLElement>("executions-empty");
  const executionsScroll = element<HTMLElement>("executions-scroll");
  const state = window.__spec.state();
  const storedMatrixOpen = Array.isArray(state["matrixOpen"]) ? state["matrixOpen"].filter((item): item is string => typeof item === "string") : [];
  const storedCollapsed = Array.isArray(state["executionsCollapsed"]) ? state["executionsCollapsed"].filter((item): item is string => typeof item === "string") : [];
  const matrixOpen = new Set(storedMatrixOpen);
  const executionsCollapsed = new Set(storedCollapsed);
  const pageSize = 50;
  let executionsShown = typeof state["executionsShown"] === "number" && Number.isFinite(state["executionsShown"])
    ? state["executionsShown"] : pageSize;
  let executionItems: readonly ExecutionRow[] = [];
  let olderRow: HTMLTableRowElement | undefined;
  let currentFiltering = false;

  function cell(text: string, className = ""): HTMLTableCellElement {
    const td = document.createElement("td");
    td.textContent = text;
    if (className) {td.className = className;}
    return td;
  }

  function matrixRow(row: MatrixRow): HTMLTableRowElement {
    const tr = document.createElement("tr");
    for (const [text, className] of [[row.requirement, "wrap"], [row.test, "key"], [row.scenario, "wrap"], [row.tag, "key"], [row.result, ""]] as const) {
      const td = cell(text, text === "" ? "hole" : className);
      tr.appendChild(td);
    }
    return tr;
  }

  function renderMatrixGroup(group: MatrixGroup): void {
    const head = document.createElement("tr");
    const groupCell = cell("", "group-cell");
    groupCell.colSpan = 5;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "group-toggle";
    const twisty = document.createElement("span");
    twisty.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.textContent = group.file || "Available tests";
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `(${group.count})`;
    toggle.append(twisty, name, count);
    groupCell.appendChild(toggle);
    head.appendChild(groupCell);
    matrixRows.appendChild(head);
    let open = currentFiltering || matrixOpen.has(group.file);
    let rows: HTMLTableRowElement[] = [];
    const paint = (): void => {
      twisty.textContent = open ? "▾" : "▸";
      toggle.setAttribute("aria-expanded", String(open));
      rows.forEach((row) => row.remove());
      rows = open ? group.rows.map(matrixRow) : [];
      const fragment = document.createDocumentFragment();
      rows.forEach((row) => fragment.appendChild(row));
      matrixRows.insertBefore(fragment, head.nextSibling);
    };
    toggle.addEventListener("click", () => {
      open = !open;
      if (!currentFiltering) {
        if (open) {matrixOpen.add(group.file);} else {matrixOpen.delete(group.file);}
        window.__spec.saveState({ matrixOpen: [...matrixOpen] });
      }
      paint();
    });
    paint();
  }

  function renderMatrix(groups: readonly MatrixGroup[], filtering: boolean): void {
    currentFiltering = filtering;
    matrixRows.textContent = "";
    if (groups.length === 0) {
      const tr = document.createElement("tr");
      const td = cell("Nothing to trace yet.", "empty");
      td.colSpan = 5;
      tr.appendChild(td);
      matrixRows.appendChild(tr);
      return;
    }
    groups.forEach(renderMatrixGroup);
  }

  function keyCell(row: ExecutionRow, toggle?: HTMLButtonElement): HTMLTableCellElement {
    const th = document.createElement("th");
    th.scope = "row";
    if (toggle) {th.appendChild(toggle);}
    if (!row.key) {th.appendChild(document.createTextNode(row.keyLabel)); return th;}
    const link = document.createElement("a");
    link.className = "link";
    link.href = "#";
    link.textContent = row.keyLabel;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      window.__spec.post("board", { type: "open", key: row.key });
    });
    th.appendChild(link);
    return th;
  }

  const activityCount = (count: number): string => `${count} ${count === 1 ? "entry" : "entries"}`;

  function activityRow(activity: ExecutionActivityRow): HTMLTableRowElement {
    const tr = document.createElement("tr");
    tr.className = "execution-child";
    const branch = cell("");
    const arrow = document.createElement("span");
    arrow.textContent = "↳";
    arrow.setAttribute("aria-hidden", "true");
    branch.appendChild(arrow);
    tr.append(branch, cell(""), cell(activity.action), cell(activity.resultsImported), cell(activity.passRate), cell(activity.publishedAt), cell(""));
    return tr;
  }

  function unknownRow(row: UnknownExecutionRow): HTMLTableRowElement {
    const tr = document.createElement("tr");
    tr.append(keyCell(row), cell(row.summary, "wrap"), cell(row.action), cell(row.resultsImported), cell(row.passRate), cell(row.publishedAt), cell(activityCount(row.activityCount)));
    return tr;
  }

  function renderExecutionGroup(group: ExecutionGroup): void {
    const head = document.createElement("tr");
    head.className = "execution-parent";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "execution-toggle";
    head.append(keyCell(group, toggle), cell(group.summary, "wrap"), cell(""), cell(""), cell(""), cell(group.latestPublishedAt), cell(activityCount(group.activityCount)));
    executionsRows.appendChild(head);
    let rows: HTMLTableRowElement[] = [];
    let open = currentFiltering || !executionsCollapsed.has(group.key);
    const paint = (): void => {
      toggle.textContent = open ? "▾" : "▸";
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", `${open ? "Hide" : "Show"} activity for ${group.keyLabel}`);
      rows.forEach((row) => row.remove());
      rows = open ? group.activities.map(activityRow) : [];
      const fragment = document.createDocumentFragment();
      rows.forEach((row) => fragment.appendChild(row));
      executionsRows.insertBefore(fragment, head.nextSibling);
    };
    toggle.addEventListener("click", () => {
      open = !open;
      if (!currentFiltering) {
        if (open) {executionsCollapsed.delete(group.key);} else {executionsCollapsed.add(group.key);}
        window.__spec.saveState({ executionsCollapsed: [...executionsCollapsed] });
      }
      paint();
    });
    paint();
  }

  function renderItem(item: ExecutionRow): void {
    if (item.kind === "group") {renderExecutionGroup(item);} else {executionsRows.appendChild(unknownRow(item));}
  }

  function paintExecutions(from: number): void {
    olderRow?.remove();
    olderRow = undefined;
    const shown = Math.min(executionsShown, executionItems.length);
    for (let index = from; index < shown; index++) {
      const item = executionItems[index];
      if (item) {renderItem(item);}
    }
    if (shown >= executionItems.length) {return;}
    const tr = document.createElement("tr");
    const td = cell("", "older-cell");
    td.colSpan = 7;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pill-button";
    button.textContent = `Show older (${executionItems.length - shown} more)`;
    button.addEventListener("click", () => {
      const next = Math.min(executionsShown, executionItems.length);
      executionsShown = next + pageSize;
      window.__spec.saveState({ executionsShown });
      paintExecutions(next);
    });
    td.appendChild(button);
    tr.appendChild(td);
    olderRow = tr;
    executionsRows.appendChild(tr);
  }

  function renderExecutions(rows: readonly ExecutionRow[], filtering: boolean): void {
    currentFiltering = filtering;
    executionsRows.textContent = "";
    olderRow = undefined;
    executionItems = rows;
    const empty = rows.length === 0;
    executionsEmpty.textContent = filtering ? "No executions match this filter." : "Execution activity from this workspace appears here.";
    executionsEmpty.hidden = !empty;
    executionsScroll.hidden = empty;
    if (!empty) {paintExecutions(0);}
  }

  return { renderMatrix, renderExecutions };
}
