import { toWorkspaceRelative } from "../utils/workspace-path";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { NormalizedStatus } from "./contracts";
import {
  RunOutcome,
  ScenarioRef,
  TraceabilityModel,
  TraceLink,
  UntracedScenario,
  worstStatus,
} from "./traceability-model";

export type GroupingMode = "test" | "file";
export interface GroupingModeStore { get(): GroupingMode; set(mode: GroupingMode): void; }
export interface ConnectionSyncStatus { syncedAt: number; stale: boolean; }
export interface ConnectionIndicator {
  state: "checking" | "ok" | "auth-failed" | "unreachable";
  label: string;
  message: string;
  sync?: ConnectionSyncStatus | undefined;
  defaultProject?: string | undefined;
}
interface SectionNode { kind: "section"; section: "covered" | "untraced" | "orphan"; }
interface FileNode { kind: "file"; filePath: string; relPath: string; untracedCount: number; }
interface TestKeyNode { kind: "testKey"; testKey: string; project?: string | undefined; links: TraceLink[]; }
interface LinkNode { kind: "link"; link: TraceLink; }
interface UntracedNode { kind: "untraced"; item: UntracedScenario; }
interface OrphanNode { kind: "orphan"; testKey: string; summary?: string | undefined; }
interface InfoNode { kind: "info"; label: string; }
interface ConnectionNode extends ConnectionIndicator { kind: "connection"; }
interface StateNode { kind: "state"; state: "disconnected" | "empty" | "untrusted"; }
export type TraceabilityNode = ConnectionNode | SectionNode | FileNode | TestKeyNode | LinkNode | UntracedNode | OrphanNode | InfoNode | StateNode;

export type TraceabilityActionId = "open" | "copy" | "link" | "run" | "connect" | "switch-project" | "select-sync-projects" | "hide" | "manage-trust";
export interface TraceabilityAction {
  readonly id: TraceabilityActionId;
  readonly label: string;
  readonly icon: string;
}

export interface TraceabilityProjectionRow {
  readonly id: string;
  readonly parentId?: string | undefined;
  readonly label: string;
  readonly description?: string | undefined;
  readonly tooltip?: string | undefined;
  readonly icon: string;
  readonly tone?: "success" | "error" | "skipped" | "pending" | "unknown" | "warning" | "info" | "muted" | undefined;
  readonly expandable: boolean;
  readonly actions: readonly TraceabilityAction[];
  readonly defaultAction?: TraceabilityAction["id"] | undefined;
}

export interface TraceabilityProjection {
  readonly state: "ready" | "disconnected" | "empty" | "untrusted";
  readonly rows: readonly TraceabilityProjectionRow[];
  readonly nodes: ReadonlyMap<string, TraceabilityNode>;
}

const ACTIONS = {
  openLocal: { id: "open", label: "Open", icon: "go-to-file" },
  openRemote: { id: "open", label: "Open in tracker", icon: "link-external" },
  copy: { id: "copy", label: "Copy key", icon: "copy" },
  link: { id: "link", label: "Link scenario", icon: "link" },
  run: { id: "run", label: "Run and publish", icon: "play" },
  connect: { id: "connect", label: "Set up connection", icon: "plug" },
  switchProject: { id: "switch-project", label: "Switch default project", icon: "repo-forked" },
  selectSyncProjects: { id: "select-sync-projects", label: "Select projects to sync", icon: "checklist" },
  hide: { id: "hide", label: "Hide Traceability", icon: "eye-closed" },
  manageTrust: { id: "manage-trust", label: "Manage workspace trust", icon: "shield" },
} as const satisfies Record<string, TraceabilityAction>;
const DISPLAY_TEXT_LIMIT = 4_096;

const outcomeIcon: Record<RunOutcome, string> = {
  passed: "pass",
  failed: "error",
  skipped: "skip",
};
const outcomeTone: Record<RunOutcome, TraceabilityProjectionRow["tone"]> = {
  passed: "success",
  failed: "error",
  skipped: "skipped",
};
const statusTone: Record<NormalizedStatus["category"], TraceabilityProjectionRow["tone"]> = {
  passed: "success",
  failed: "error",
  pending: "pending",
  unknown: "unknown",
};

// The browser receives stable opaque identities only. Paths and scenario text stay in the host map.
function rowId(kind: string, value: string): string {
  return `${kind}:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}
function display(value: string): string { return value.slice(0, DISPLAY_TEXT_LIMIT); }
function displayJoin(values: readonly string[], separator: string): string {
  let result = "";
  for (const value of values) {
    const next = display(value);
    const prefix = result ? separator : "";
    if (result.length + prefix.length + next.length > DISPLAY_TEXT_LIMIT) {
      return result || next.slice(0, DISPLAY_TEXT_LIMIT);
    }
    result += prefix + next;
  }
  return result;
}
function displayPath(filePath: string): string {
  const relative = toWorkspaceRelative(filePath);
  return display(path.isAbsolute(relative) ? path.basename(relative) : relative);
}
function reqDescription(reqKeys: readonly string[]): string { return reqKeys.length ? displayJoin(["REQ ", displayJoin(reqKeys, ", ")], "") : ""; }
function refId(ref: ScenarioRef): string { return `${ref.filePath}:${ref.line}:${ref.name}`; }

function aggregateIterations(links: readonly TraceLink[]): { passed: number; total: number } | undefined {
  let passed = 0;
  let total = 0;
  let any = false;
  for (const link of links) {
    if (link.iterations) { passed += link.iterations.passed; total += link.iterations.total; any = true; }
  }
  return any ? { passed, total } : undefined;
}

function testDescription(links: readonly TraceLink[]): string {
  const first = links[0];
  const count = links.length === 1 ? "1 scenario" : `${links.length} scenarios`;
  const base = first?.meta?.summary ? display(first.meta.summary) : first?.project ? displayJoin([first.project, count], " · ") : count;
  const iterations = aggregateIterations(links);
  return iterations ? displayJoin([base, `${iterations.passed}/${iterations.total}`], " · ") : base;
}

function connectionDescription(indicator: ConnectionIndicator): { description: string; tooltip: string } {
  const base = indicator.state === "ok" ? "Connected" : indicator.state === "checking" ? "Checking…" : indicator.state === "auth-failed" ? "Authentication failed" : "Unreachable";
  if (!indicator.sync) { return { description: base, tooltip: display(indicator.message) }; }
  const ago = formatSyncedAgo(Date.now() - indicator.sync.syncedAt);
  const description = indicator.state === "unreachable"
    ? `Unreachable · showing data synced ${ago}`
    : `${base} · synced ${ago}${indicator.sync.stale ? " (stale)" : ""}`;
  return { description, tooltip: displayJoin([indicator.message, description], " · ") };
}
export function formatSyncedAgo(elapsedMs: number): string {
  const minutes = Math.floor(Math.max(0, elapsedMs) / 60_000);
  if (minutes < 1) { return "just now"; }
  if (minutes < 60) { return `${minutes}m ago`; }
  if (minutes < 1_440) { return `${Math.floor(minutes / 60)}h ago`; }
  return `${Math.floor(minutes / 1_440)}d ago`;
}

function stateProjection(state: "disconnected" | "empty" | "untrusted"): TraceabilityProjection {
  const id = rowId("state", state);
  const row: TraceabilityProjectionRow = state === "disconnected"
    ? { id, label: "Set up Xray", description: "Set up Xray integration to map scenarios and publish results.", tooltip: "Set up Xray integration to map scenarios and publish results.", icon: "plug", tone: "info", expandable: false, actions: [ACTIONS.connect, ACTIONS.hide], defaultAction: "connect" }
    : state === "untrusted"
      ? { id, label: "Workspace trust required", description: "Traceability stays offline while this workspace is untrusted.", tooltip: "Trust this workspace before connecting to Xray or reading traceability data.", icon: "shield", tone: "warning", expandable: false, actions: [ACTIONS.manageTrust], defaultAction: "manage-trust" }
      : { id, label: "No Xray-tagged scenarios found yet.", description: "Add @TEST_KEY tags to scenarios. Local mappings update automatically.", tooltip: "Add @TEST_KEY tags to scenarios. Local mappings update automatically.", icon: "info", tone: "muted", expandable: false, actions: [] };
  return { state, rows: [row], nodes: new Map([[id, { kind: "state", state }]]) };
}

/** A flat, browser-neutral rendering of the native tree's established ordering and semantics. */
export function projectTraceabilityTree(
  model: TraceabilityModel | undefined,
  providerLabel: string,
  grouping: GroupingMode,
  connected: boolean,
  connection: ConnectionIndicator | undefined,
  trusted: boolean
): TraceabilityProjection {
  if (!trusted) { return stateProjection("untrusted"); }
  if (!connected) { return stateProjection("disconnected"); }
  if (!model) { return stateProjection("empty"); }
  const snapshot = model.snapshot;
  if (snapshot.links.length === 0 && snapshot.untraced.length === 0) {
    return stateProjection("empty");
  }
  const label = display(providerLabel);
  const rows: TraceabilityProjectionRow[] = [];
  const nodes = new Map<string, TraceabilityNode>();
  const add = (row: TraceabilityProjectionRow, node: TraceabilityNode): void => {
    const text = (value: string | undefined): string | undefined => {
      return value ? value.slice(0, DISPLAY_TEXT_LIMIT) : undefined;
    };
    rows.push({ ...row, label: text(row.label) ?? "", description: text(row.description), tooltip: text(row.tooltip) });
    nodes.set(row.id, node);
  };
  if (connection) {
    const text = connectionDescription(connection);
    const id = rowId("connection", "current");
    const tone = connection.state === "ok" ? "success" : connection.state === "auth-failed" ? "error" : connection.state === "unreachable" ? "warning" : "muted";
    const project = connection.defaultProject ? display(connection.defaultProject) : undefined;
    const tooltip = project
      ? displayJoin([display(connection.label), text.tooltip, `Default project ${project}. Prefills new tests and executions, and joins the sync scope while no sync project list is set.`], "\n")
      : displayJoin([display(connection.label), text.tooltip], "\n");
    add({ id, label: "Xray Cloud", description: project ? displayJoin([text.description, `project ${project}`], " · ") : text.description, tooltip, icon: connection.state === "ok" ? "cloud" : connection.state === "checking" ? "loading" : connection.state === "auth-failed" ? "key" : "debug-disconnect", tone, expandable: false, actions: [ACTIONS.connect, ACTIONS.switchProject, ACTIONS.selectSyncProjects], defaultAction: "connect" }, { kind: "connection", ...connection });
  }
  const addScenario = (link: TraceLink, parentId: string): void => {
    const id = rowId("scenario", `${link.testKey}:${refId(link.scenario)}`);
    const description = displayJoin([reqDescription(link.reqKeys), link.drift ? "drift" : ""].filter(Boolean), " · ");
    const scenario = display(link.scenario.name);
    add({ id, parentId, label: scenario, description, tooltip: link.drift ? displayJoin([scenario, "The remote test text differs from this scenario."], "\n") : scenario, icon: link.lastResult ? outcomeIcon[link.lastResult] : "circle-outline", tone: link.lastResult ? outcomeTone[link.lastResult] : "muted", expandable: false, actions: [ACTIONS.openLocal, ACTIONS.link, ACTIONS.run], defaultAction: "open" }, { kind: "link", link });
  };
  const addUntraced = (item: UntracedScenario, parentId: string): void => {
    const id = rowId("untraced", refId(item.scenario));
    const descriptions = item.scenario.kind === "outline" && item.examples !== undefined ? [item.examples === 1 ? "1 example" : `${item.examples} examples`] : [];
    const req = reqDescription(item.reqKeys); if (req) { descriptions.push(req); }
    const scenario = display(item.scenario.name);
    add({ id, parentId, label: scenario, description: displayJoin(descriptions, " · "), tooltip: scenario, icon: "circle-large-outline", tone: "muted", expandable: false, actions: [ACTIONS.openLocal, ACTIONS.link], defaultAction: "open" }, { kind: "untraced", item });
  };
  const addOrphans = (parentId?: string): void => {
    const section = parentId ?? rowId("section", "orphan");
    const projects = displayJoin(snapshot.completeProjects, ", ");
    if (!parentId) { add({ id: section, label: displayJoin(["Available", label, "tests"], " "), description: displayJoin([String(snapshot.orphans.length), `in ${projects}`], " "), icon: "folder", expandable: true, actions: [] }, { kind: "section", section: "orphan" }); }
    if (!snapshot.orphans.length) { const id = rowId("info", "orphan"); const message = displayJoin(["No available", label, "tests in", `${projects}.`], " "); add({ id, parentId: section, label: message, icon: "info", expandable: false, actions: [] }, { kind: "info", label: message }); return; }
    for (const orphan of [...snapshot.orphans].sort((a, b) => a.testKey.localeCompare(b.testKey))) {
      const id = rowId("orphan", orphan.testKey);
      const key = display(orphan.testKey);
      const summary = orphan.meta.summary ? display(orphan.meta.summary) : undefined;
      add({ id, parentId: section, label: key, description: summary, tooltip: summary ? displayJoin([key, summary], " · ") : key, icon: "beaker", tone: "info", expandable: false, actions: [ACTIONS.openRemote, ACTIONS.copy], defaultAction: "open" }, { kind: "orphan", testKey: orphan.testKey, summary: orphan.meta.summary });
    }
  };
  if (grouping === "file") {
    const files = new Map<string, { untraced: number; links: TraceLink[]; items: UntracedScenario[] }>();
    for (const item of snapshot.untraced) { const value = files.get(item.scenario.filePath) ?? { untraced: 0, links: [], items: [] }; value.untraced++; value.items.push(item); files.set(item.scenario.filePath, value); }
    for (const link of snapshot.links) { const value = files.get(link.scenario.filePath) ?? { untraced: 0, links: [], items: [] }; value.links.push(link); files.set(link.scenario.filePath, value); }
    for (const [filePath, value] of [...files].sort((a, b) => (a[1].untraced ? 0 : 1) - (b[1].untraced ? 0 : 1) || toWorkspaceRelative(a[0]).localeCompare(toWorkspaceRelative(b[0])))) {
      const id = rowId("file", filePath);
      const relPath = displayPath(filePath);
      add({ id, label: relPath, description: value.untraced ? `${value.untraced} untraced` : undefined, tooltip: relPath, icon: "file", expandable: true, actions: [ACTIONS.run] }, { kind: "file", filePath, relPath, untracedCount: value.untraced });
      value.items.sort((a, b) => a.scenario.line - b.scenario.line).forEach((item) => addUntraced(item, id));
      value.links.sort((a, b) => a.scenario.line - b.scenario.line).forEach((link) => addScenario(link, id));
    }
    if (snapshot.completeProjects.length) { addOrphans(); }
  } else {
    const untracedId = rowId("section", "untraced");
    add({ id: untracedId, label: "Untraced scenarios", description: String(snapshot.untraced.length), icon: "folder", expandable: true, actions: [] }, { kind: "section", section: "untraced" });
    if (!snapshot.untraced.length) { const message = displayJoin(["Every scenario is mapped to a", label, "test."], " "); add({ id: rowId("info", "untraced"), parentId: untracedId, label: message, icon: "info", expandable: false, actions: [] }, { kind: "info", label: message }); }
    else { [...snapshot.untraced].sort((a, b) => a.scenario.name.localeCompare(b.scenario.name)).forEach((item) => addUntraced(item, untracedId)); }
    const coveredId = rowId("section", "covered");
    const byKey = new Map<string, TraceLink[]>();
    for (const link of snapshot.links) { const items = byKey.get(link.testKey) ?? []; items.push(link); byKey.set(link.testKey, items); }
    add({ id: coveredId, label: "Mapped tests", description: String(byKey.size), icon: "folder", expandable: true, actions: [] }, { kind: "section", section: "covered" });
    if (!byKey.size) { const message = displayJoin(["No scenarios are mapped to a", label, "test yet."], " "); add({ id: rowId("info", "covered"), parentId: coveredId, label: message, icon: "info", expandable: false, actions: [] }, { kind: "info", label: message }); }
    for (const [key, links] of [...byKey].sort((a, b) => a[0].localeCompare(b[0]))) {
      const first = links[0]; const id = rowId("test", key);
      const outcome = worstStatus(links.map((link) => link.lastResult));
      const icon = first?.remoteMissing ? "warning" : "beaker";
      const tone = first?.remoteMissing ? "warning" : first?.meta?.status ? statusTone[first.meta.status.category] : outcome ? outcomeTone[outcome] : "warning";
      const description = first?.remoteMissing ? displayJoin([testDescription(links), "not found on remote"], " · ") : testDescription(links);
      const remoteTooltip = first?.remoteMissing
        ? displayJoin([`${display(key)} was not found${first.project ? ` in project ${display(first.project)}` : ""} on the connected site.`, "The tag may be stale, mistyped, or reference a Jira issue that is not a test."], " ")
        : undefined;
      const displayedKey = display(key);
      add({ id, parentId: coveredId, label: displayedKey, description, tooltip: remoteTooltip ?? (first?.meta?.status ? displayJoin([displayedKey, first.meta.status.providerValue], " · ") : displayedKey), icon, tone, expandable: true, actions: [ACTIONS.openRemote, ACTIONS.copy] }, { kind: "testKey", testKey: key, project: first?.project, links });
      links.forEach((link) => addScenario(link, id));
    }
    if (snapshot.completeProjects.length) { addOrphans(); }
  }
  return { state: "ready", rows, nodes };
}
