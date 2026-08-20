import type * as vscode from "vscode";

const PROJECT_SCOPE_KEY = "playwrightBddRunner.board.projectScope";

/** Trimmed, uppercased, deduped, sorted; empties dropped. The one shape every project key is compared in. */
export function normalizeProjectKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of keys) {
    const key = raw.trim().toUpperCase();
    if (key !== "") {
      seen.add(key);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export interface ProjectUniverseSources {
  // Every project the provider's connection can enumerate. Absent when it cannot enumerate at all,
  // which is not the same as reaching zero projects.
  readonly directoryProjects?: readonly string[] | undefined;
  // Projects the workspace's own test and requirement tags reference. Never a prerequisite: a workspace
  // with no tags still gets the setting, the catalogue, and the default key.
  readonly tagDerivedKeys?: readonly string[] | undefined;
  readonly syncSettingKeys?: readonly string[] | undefined;
  // Projects an earlier sync already pulled a catalogue for, so their cards keep a scope to select.
  readonly catalogueKeys?: readonly string[] | undefined;
  readonly defaultKey?: string | undefined;
  // The board's current project selection, so picking a project there is enough to have it synced.
  readonly selectedKey?: string | undefined;
  // One project this call asks for, such as a forced project sync or a project the board just opened.
  // It names a single fetch rather than the durable scope, so it is the one rung allowed to widen an
  // explicit sync setting.
  readonly explicitKey?: string | undefined;
}

/**
 * The projects a surface may offer, unioned down the source ladder and normalized. One owner for the
 * list the publish dialog's project dropdown and the board's scope selector read, so they can never
 * disagree. The sync scope resolves the same way minus the directory (see `resolveSyncProjectKeys`).
 */
export function resolveProjectUniverse(sources: ProjectUniverseSources): string[] {
  return normalizeProjectKeys([
    ...(sources.directoryProjects ?? []),
    ...(sources.tagDerivedKeys ?? []),
    ...(sources.syncSettingKeys ?? []),
    ...(sources.catalogueKeys ?? []),
    sources.defaultKey ?? "",
    sources.selectedKey ?? "",
    sources.explicitKey ?? "",
  ]);
}

/**
 * The projects one sync fetches a full catalogue for. A non-empty sync setting is the durable answer:
 * the user named the scope, so only a project this call asks for by name (`explicitKey`) joins it, and
 * only for that call. Otherwise the universe ladder minus the provider directory, since a sync fetches
 * one catalogue per project and covering every accessible project is not a scope. The directory is
 * dropped here rather than left to the caller, so a source bag built for a dropdown cannot leak a
 * site-wide fetch into a sync.
 */
export function resolveSyncProjectKeys(sources: ProjectUniverseSources): string[] {
  const chosen = normalizeProjectKeys(sources.syncSettingKeys ?? []);
  return chosen.length > 0
    ? normalizeProjectKeys([...chosen, sources.explicitKey ?? ""])
    : resolveProjectUniverse({ ...sources, directoryProjects: undefined });
}

export type ProjectProvenance =
  | "default project"
  | "referenced by workspace tags"
  | "in the sync setting"
  | "synced earlier"
  | "board selection"
  | "requested for this sync"
  | "from site directory";

/**
 * Why each project of the universe is on offer, first rung wins. One pass over the ladder, so a surface
 * labels every key it shows without re-walking the sources per row. Every rung `resolveProjectUniverse`
 * reads has a label here: a key the user is offered but cannot account for is a worse answer than a
 * rough one.
 */
export function projectProvenance(sources: ProjectUniverseSources): Map<string, ProjectProvenance> {
  const ladder: ReadonlyArray<readonly [ProjectProvenance, readonly string[]]> = [
    ["default project", [sources.defaultKey ?? ""]],
    ["referenced by workspace tags", sources.tagDerivedKeys ?? []],
    ["in the sync setting", sources.syncSettingKeys ?? []],
    ["synced earlier", sources.catalogueKeys ?? []],
    ["board selection", [sources.selectedKey ?? ""]],
    ["requested for this sync", [sources.explicitKey ?? ""]],
    ["from site directory", sources.directoryProjects ?? []],
  ];
  const labels = new Map<string, ProjectProvenance>();
  for (const [label, keys] of ladder) {
    for (const key of normalizeProjectKeys(keys)) {
      if (!labels.has(key)) {labels.set(key, label);}
    }
  }
  return labels;
}

// The board's project scope, persisted per workspace. All Projects is the absence of a selection, so
// both sides of this store speak `undefined` for it.
export interface ProjectScopeStore {
  get(known: readonly string[]): string | undefined;
  set(project: string | undefined): void;
}

// A board with nowhere to persist into (no subsystem, so no workspaceState): every read is All Projects
// and every write goes nowhere, which keeps the selection out of the surface's own state.
export const NO_PROJECT_SCOPE: ProjectScopeStore = {
  get: () => undefined,
  set: () => undefined,
};

// Reads/writes the board's project scope in workspaceState. The read coerces at the boundary: a stored
// key that is no longer known reads as All Projects, but the stored value stays put, so re-adding that
// project to the sync scope restores the selection instead of silently losing it.
export function projectScopeStore(memento: vscode.Memento, onError: (error: unknown) => void): ProjectScopeStore {
  return {
    get: (known) => {
      const stored = memento.get<string>(PROJECT_SCOPE_KEY);
      return stored !== undefined && known.includes(stored) ? stored : undefined;
    },
    set: (project) => {
      Promise.resolve(memento.update(PROJECT_SCOPE_KEY, project)).catch(onError);
    },
  };
}
