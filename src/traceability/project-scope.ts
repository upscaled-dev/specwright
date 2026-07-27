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

// Which rung of the source ladder the universe came from: `jira` when the provider enumerated its own
// project directory, `xray-only` when the workspace's own keys are all there is to go on.
export type ProjectUniverseTier = "jira" | "xray-only";

export interface ProjectUniverseSources {
  // Every project the provider's connection can enumerate. Its presence is what makes the tier `jira`.
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
}

export interface ProjectUniverse {
  readonly projects: string[];
  readonly tier: ProjectUniverseTier;
}

/**
 * The projects a surface may offer, unioned down the source ladder and normalized. One owner for the
 * list the publish dialog's project dropdown and the board's scope selector read, so they can never
 * disagree. The sync scope resolves the same way minus the directory (see `resolveSyncProjectKeys`).
 */
export function resolveProjectUniverse(sources: ProjectUniverseSources): ProjectUniverse {
  const projects = normalizeProjectKeys([
    ...(sources.directoryProjects ?? []),
    ...(sources.tagDerivedKeys ?? []),
    ...(sources.syncSettingKeys ?? []),
    ...(sources.catalogueKeys ?? []),
    sources.defaultKey ?? "",
    sources.selectedKey ?? "",
  ]);
  // The tier answers whether the provider could enumerate at all, not how many it returned: a connection
  // that legitimately reaches zero projects is still the jira tier, so its empty state can say the token
  // reaches nothing rather than telling the user to add keys to settings.
  return { projects, tier: sources.directoryProjects !== undefined ? "jira" : "xray-only" };
}

/**
 * The projects one sync fetches a full catalogue for: the same ladder minus the provider directory,
 * since a sync fetches one catalogue per project and covering every accessible project is not a scope.
 * The directory is dropped here rather than left to the caller, so a source bag built for a dropdown
 * cannot leak a site-wide fetch into a sync.
 */
export function resolveSyncProjectKeys(sources: ProjectUniverseSources): string[] {
  return resolveProjectUniverse({ ...sources, directoryProjects: undefined }).projects;
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
