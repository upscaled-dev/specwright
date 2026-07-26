import type * as vscode from "vscode";

const PROJECT_SCOPE_KEY = "playwrightBddRunner.board.projectScope";

/**
 * The project keys this workspace knows about, unioned from the sync setting, the synced catalogue, and
 * the default project key, then trimmed, uppercased, deduped, and sorted. One owner for the list the
 * publish dialog's project dropdown and the board's scope selector both offer, so they can never
 * disagree. The trailing sources default to empty for a caller that already holds a single union.
 */
export function knownProjectKeys(
  syncKeys: readonly string[],
  catalogueProjects: readonly string[] = [],
  defaultKey = ""
): string[] {
  const keys = new Set<string>();
  for (const raw of [...syncKeys, ...catalogueProjects, defaultKey]) {
    const key = raw.trim().toUpperCase();
    if (key !== "") {
      keys.add(key);
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
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
