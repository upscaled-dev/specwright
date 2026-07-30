import type * as vscode from "vscode";

const MAPPING_PAGE_SIZE_KEY = "playwrightBddRunner.board.mappingPageSize";

// The sizes the Mapping tab's one dropdown offers, and the size it starts on. There is no "all rows":
// a paginated list is the whole point, and one control governs every section so the columns cannot
// drift out of alignment.
export const MAPPING_PAGE_SIZES: readonly number[] = [25, 50, 100];
export const DEFAULT_MAPPING_PAGE_SIZE = 50;

// How many cards one Mapping section shows at a time, persisted per workspace.
export interface MappingPageSizeStore {
  get(): number;
  set(size: number): void;
}

// A board with nowhere to persist into (no subsystem, so no workspaceState): every read is the default
// and every write goes nowhere.
export const NO_MAPPING_PAGE_SIZE: MappingPageSizeStore = {
  get: () => DEFAULT_MAPPING_PAGE_SIZE,
  set: () => undefined,
};

// Reads/writes the Mapping tab's page size in workspaceState. The read coerces at the boundary: anything
// the dropdown does not offer reads as the default, so a hand-edited or stale stored value can never
// leave a section showing a size no control can undo.
export function mappingPageSizeStore(memento: vscode.Memento, onError: (error: unknown) => void): MappingPageSizeStore {
  return {
    get: () => {
      const stored = memento.get<number>(MAPPING_PAGE_SIZE_KEY);
      return stored !== undefined && MAPPING_PAGE_SIZES.includes(stored) ? stored : DEFAULT_MAPPING_PAGE_SIZE;
    },
    set: (size) => {
      Promise.resolve(memento.update(MAPPING_PAGE_SIZE_KEY, size)).catch(onError);
    },
  };
}
