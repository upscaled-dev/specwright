import { ORGANIZATION_ITEM_LIMIT, type BatchSelection, type OrganizationSnapshot, type RemoteTestSet, type TestCaseMetadata } from "./contracts";
import { refIdentity, type ScenarioRef } from "./scenario-ref";
import type { TraceabilitySnapshot } from "./traceability-model";
import {
  TRACEABILITY_ACTIONS,
  traceabilityRowId,
  type TraceabilityAction,
  type TraceabilityProjectionRow,
} from "./traceability-tree-projection";
import { boundedTraceabilityText } from "../webview/traceability-view-protocol";

const PREVIEW_SET: TraceabilityAction = { id: "preview-run", label: "Run Set and publish", icon: "play" };
const PREVIEW_FOLDER: TraceabilityAction = { id: "preview-run", label: "Run folder and publish", icon: "play" };
export const REPOSITORY_FOLDER_NODE_LIMIT = 2_000;
export const REPOSITORY_FOLDER_DEPTH_LIMIT = 32;

export type OrganizationNode =
  | { readonly kind: "repositoryProject"; readonly projectKey: string }
  | { readonly kind: "repositoryFolder"; readonly projectKey: string; readonly folderPath: string }
  | { readonly kind: "repositoryTest"; readonly testKey: string; readonly summary?: string | undefined }
  | { readonly kind: "testSetProject"; readonly projectKey: string }
  | { readonly kind: "testSet"; readonly testSetKey: string; readonly testKey: string }
  | { readonly kind: "testSetMember"; readonly testKey: string; readonly summary?: string | undefined }
  | { readonly kind: "organizationInfo"; readonly label: string };

export interface OrganizationProjection {
  readonly rows: readonly TraceabilityProjectionRow[];
  readonly nodes: ReadonlyMap<string, OrganizationNode>;
}

export interface RepositoryFolderPreview {
  readonly selection: Extract<BatchSelection, { kind: "repository-folder" }>;
  readonly title: string;
  readonly remoteTests: number;
  readonly remoteOnly: number;
  readonly members: readonly { readonly label: string; readonly mapped: boolean }[];
}

interface FolderEntry {
  readonly path: string;
  readonly parentPath?: string | undefined;
  readonly directTests: TestCaseMetadata[];
  descendantTests: number;
  descendantMappedTests: number;
}

function mappedByKey(snapshot: TraceabilitySnapshot | undefined): Map<string, ScenarioRef[]> {
  const output = new Map<string, ScenarioRef[]>();
  for (const link of snapshot?.links ?? []) {
    const refs = output.get(link.testKey) ?? [];
    if (!refs.some((ref) => refIdentity(ref) === refIdentity(link.scenario))) {refs.push(link.scenario);}
    output.set(link.testKey, refs);
  }
  return output;
}

function folderPath(test: TestCaseMetadata): string {
  const path = test.repositoryFolder?.path.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  return path ? `/${path}` : "/Unfiled";
}

function folderIndex(tests: readonly TestCaseMetadata[], mapped: ReadonlyMap<string, readonly ScenarioRef[]>): {
  readonly folders: ReadonlyMap<string, FolderEntry>;
  readonly truncated: boolean;
} {
  const folders = new Map<string, FolderEntry>();
  let truncated = false;
  for (const test of tests) {
    const testPath = folderPath(test);
    const parts = testPath.split("/").filter(Boolean);
    if (parts.length > REPOSITORY_FOLDER_DEPTH_LIMIT) {truncated = true; continue;}
    let leaf: FolderEntry | undefined;
    for (let index = 0; index < parts.length; index += 1) {
      const path = `/${parts.slice(0, index + 1).join("/")}`;
      let entry = folders.get(path);
      if (!entry) {
        if (folders.size >= REPOSITORY_FOLDER_NODE_LIMIT) {truncated = true; break;}
        const parentPath = index > 0 ? `/${parts.slice(0, index).join("/")}` : undefined;
        entry = { path, parentPath, directTests: [], descendantTests: 0, descendantMappedTests: 0 };
        folders.set(path, entry);
      }
      leaf = entry;
    }
    if (leaf?.path === testPath) {leaf.directTests.push(test);}
  }
  const deepestFirst = [...folders.values()].sort((a, b) => b.path.split("/").length - a.path.split("/").length);
  for (const folder of deepestFirst) {
    folder.descendantTests += folder.directTests.length;
    folder.descendantMappedTests += folder.directTests.filter((test) => mapped.has(test.key)).length;
    const parent = folder.parentPath ? folders.get(folder.parentPath) : undefined;
    if (parent) {
      parent.descendantTests += folder.descendantTests;
      parent.descendantMappedTests += folder.descendantMappedTests;
    }
  }
  return { folders, truncated };
}

function scenariosFor(tests: readonly TestCaseMetadata[], mapped: ReadonlyMap<string, readonly ScenarioRef[]>): ScenarioRef[] {
  const seen = new Set<string>();
  const refs: ScenarioRef[] = [];
  for (const test of tests) {
    for (const ref of mapped.get(test.key) ?? []) {
      const identity = refIdentity(ref);
      if (!seen.has(identity)) {seen.add(identity); refs.push(ref);}
    }
  }
  return refs;
}

function testSetCounts(set: RemoteTestSet, mapped: ReadonlyMap<string, readonly ScenarioRef[]>): { runnable: number; remoteOnly: number } {
  const runnable = scenariosFor(set.members.map((member) => ({ key: member.key })), mapped).length;
  return { runnable, remoteOnly: set.remoteMemberCount - set.members.filter((member) => mapped.has(member.key)).length };
}

export function resolveRepositoryFolderPreview(
  organization: OrganizationSnapshot | undefined,
  snapshot: TraceabilitySnapshot | undefined,
  projectKey: string,
  path: string
): RepositoryFolderPreview | undefined {
  const project = organization?.repositories.find((candidate) => candidate.projectKey === projectKey);
  if (!project?.complete) {return undefined;}
  const mapped = mappedByKey(snapshot);
  const index = folderIndex(project.tests, mapped);
  if (index.truncated || !index.folders.has(path)) {return undefined;}
  const tests = project.tests.filter((test) => {
    const candidate = folderPath(test);
    return candidate === path || candidate.startsWith(`${path}/`);
  });
  const scenarios = scenariosFor(tests, mapped);
  if (tests.length === 0 || scenarios.length === 0) {return undefined;}
  return {
    selection: { kind: "repository-folder", projectKey, folderPath: path, scenarios },
    title: boundedTraceabilityText(`${projectKey} · ${path}`),
    remoteTests: tests.length,
    remoteOnly: tests.filter((test) => !mapped.has(test.key)).length,
    members: tests.map((test) => ({
      label: boundedTraceabilityText([test.key, test.summary].filter(Boolean).join(" · ")),
      mapped: mapped.has(test.key),
    })),
  };
}

export function projectTraceabilityOrganization(
  organization: OrganizationSnapshot | undefined,
  snapshot: TraceabilitySnapshot | undefined
): OrganizationProjection {
  const rows: TraceabilityProjectionRow[] = [];
  const nodes = new Map<string, OrganizationNode>();
  const mapped = mappedByKey(snapshot);
  const truncatedViews = new Set<TraceabilityProjectionRow["view"]>();
  const add = (row: TraceabilityProjectionRow, node: OrganizationNode): void => {
    if (rows.length >= ORGANIZATION_ITEM_LIMIT - 2) {truncatedViews.add(row.view); return;}
    rows.push({
      ...row,
      label: boundedTraceabilityText(row.label),
      description: row.description ? boundedTraceabilityText(row.description) : undefined,
      tooltip: row.tooltip ? boundedTraceabilityText(row.tooltip) : undefined,
    });
    nodes.set(row.id, node);
  };

  for (const project of organization?.repositories ?? []) {
    const projectId = traceabilityRowId("repository-project", project.projectKey);
    const index = folderIndex(project.tests, mapped);
    const usable = project.complete && !project.truncated && !index.truncated;
    const qualifier = index.truncated ? "hierarchy truncated" : project.complete ? "complete" : project.truncated ? "truncated" : "partial";
    const hierarchyError = index.truncated
      ? [`Repository hierarchy reached the ${REPOSITORY_FOLDER_NODE_LIMIT}-folder or ${REPOSITORY_FOLDER_DEPTH_LIMIT}-level limit.`]
      : [];
    add({ id: projectId, view: "repository", label: project.projectKey, description: `${project.tests.length} remote tests · ${qualifier}`, tooltip: [...project.errors, ...hierarchyError].join("\n") || undefined, icon: "project", tone: usable ? "info" : "warning", expandable: true, actions: [] }, { kind: "repositoryProject", projectKey: project.projectKey });
    for (const folder of [...index.folders.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      const folderId = traceabilityRowId("repository-folder", `${project.projectKey}:${folder.path}`);
      add({
        id: folderId,
        parentId: folder.parentPath ? traceabilityRowId("repository-folder", `${project.projectKey}:${folder.parentPath}`) : projectId,
        view: "repository", label: folder.path.slice(folder.path.lastIndexOf("/") + 1),
        description: `${folder.descendantTests} remote tests · ${folder.descendantMappedTests} mapped locally`,
        tooltip: usable ? undefined : "Folder run unavailable because the repository hierarchy is incomplete.",
        icon: "folder-library", tone: usable ? (folder.descendantMappedTests ? "info" : "muted") : "warning",
        expandable: true, actions: usable && folder.descendantMappedTests > 0 ? [PREVIEW_FOLDER] : [],
      }, { kind: "repositoryFolder", projectKey: project.projectKey, folderPath: folder.path });
      // Depth-first: the client renders host order, so a folder's tests must follow their own folder
      // row rather than trail every sibling folder.
      for (const test of [...folder.directTests].sort((a, b) => a.key.localeCompare(b.key))) {
        const mappedCount = mapped.get(test.key)?.length ?? 0;
        add({
          id: traceabilityRowId("repository-test", `${project.projectKey}:${test.key}`),
          parentId: folderId,
          view: "repository", label: test.key,
          description: [test.summary, mappedCount ? `${mappedCount} mapped locally` : "remote only"].filter(Boolean).join(" · "),
          icon: "beaker", tone: mappedCount ? "success" : "muted", expandable: false,
          actions: [TRACEABILITY_ACTIONS.openRemote, TRACEABILITY_ACTIONS.copy], defaultAction: "open",
        }, { kind: "repositoryTest", testKey: test.key, summary: test.summary });
      }
    }
  }

  for (const project of organization?.testSetProjects ?? []) {
    const projectId = traceabilityRowId("test-set-project", project.projectKey);
    add({ id: projectId, view: "test-sets", label: project.projectKey, description: `${project.testSets.length} Test Sets${project.truncated ? " · truncated" : ""}`, tooltip: project.errors.join("\n") || undefined, icon: "project", tone: project.complete ? "info" : "warning", expandable: true, actions: [] }, { kind: "testSetProject", projectKey: project.projectKey });
    for (const set of [...project.testSets].sort((a, b) => a.key.localeCompare(b.key))) {
      const setId = traceabilityRowId("test-set", set.key);
      let detail = `${set.remoteMemberCount} remote members · ${set.members.length} ${set.membersLastKnown ? "cached" : "loaded"} · membership incomplete`;
      if (set.membershipComplete) {
        const counts = testSetCounts(set, mapped);
        detail = `${set.remoteMemberCount} remote members · ${counts.runnable} runnable locally · ${counts.remoteOnly} remote only`;
      }
      add({
        id: setId, parentId: projectId, view: "test-sets", label: set.key,
        description: [set.summary, detail].filter(Boolean).join(" · "),
        tooltip: [set.description, ...set.errors].filter(Boolean).join("\n") || undefined,
        icon: "list-selection", tone: set.membershipComplete ? "info" : "warning", expandable: true,
        actions: set.remoteMemberCount > 0 ? [PREVIEW_SET, TRACEABILITY_ACTIONS.openRemote, TRACEABILITY_ACTIONS.copy] : [TRACEABILITY_ACTIONS.openRemote, TRACEABILITY_ACTIONS.copy],
      }, { kind: "testSet", testSetKey: set.key, testKey: set.key });
      for (const member of set.members) {
        const local = mapped.has(member.key);
        add({
          id: traceabilityRowId("test-set-member", `${set.key}:${member.key}`), parentId: setId,
          view: "test-sets", label: member.key,
          description: [member.summary, local ? "mapped" : "remote only"].filter(Boolean).join(" · "),
          // A member is a remote test, like a repository test or a Workspace orphan, so it carries the
          // same glyph; whether this workspace maps it is tone and description, never identity.
          icon: "beaker", tone: local ? "success" : "muted", expandable: false,
          actions: [TRACEABILITY_ACTIONS.openRemote, TRACEABILITY_ACTIONS.copy], defaultAction: "open",
        }, { kind: "testSetMember", testKey: member.key, summary: member.summary });
      }
    }
  }

  if (!(organization?.repositories.length)) {
    const label = "No complete Test Repository catalogue is cached. Sync Traceability to load it.";
    add({ id: traceabilityRowId("repository-info", "empty"), view: "repository", label, icon: "info", tone: "muted", expandable: false, actions: [] }, { kind: "organizationInfo", label });
  }
  if (!(organization?.testSetProjects.length)) {
    const label = "No Test Sets are cached. Sync Traceability to load them.";
    add({ id: traceabilityRowId("test-set-info", "empty"), view: "test-sets", label, icon: "info", tone: "muted", expandable: false, actions: [] }, { kind: "organizationInfo", label });
  }
  if ((organization?.omittedRepositoryProjectCount ?? 0) > 0) {
    const count = organization?.omittedRepositoryProjectCount ?? 0;
    const label = `${count} Repository projects omitted by the organization item limit.`;
    add({ id: traceabilityRowId("repository-info", "bounded"), view: "repository", label, icon: "warning", tone: "warning", expandable: false, actions: [] }, { kind: "organizationInfo", label });
  }
  if ((organization?.omittedTestSetProjectCount ?? 0) > 0) {
    const count = organization?.omittedTestSetProjectCount ?? 0;
    const label = `${count} Test Set projects omitted by the organization item limit.`;
    add({ id: traceabilityRowId("test-set-info", "bounded"), view: "test-sets", label, icon: "warning", tone: "warning", expandable: false, actions: [] }, { kind: "organizationInfo", label });
  }
  for (const view of ["repository", "test-sets"] as const) {
    if (!truncatedViews.has(view)) {continue;}
    const label = `${view === "repository" ? "Repository" : "Test Sets"} display reached the ${ORGANIZATION_ITEM_LIMIT}-item limit.`;
    const row = { id: traceabilityRowId("organization-info", `bounded:${view}`), view, label, icon: "warning", tone: "warning" as const, expandable: false, actions: [] };
    rows.push(row);
    nodes.set(row.id, { kind: "organizationInfo", label });
  }
  return { rows, nodes };
}
