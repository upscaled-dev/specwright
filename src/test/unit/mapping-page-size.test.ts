import { describe, it, expect, vi } from "vitest";
import type * as vscode from "vscode";
import {
  DEFAULT_MAPPING_PAGE_SIZE,
  MAPPING_PAGE_SIZES,
  NO_MAPPING_PAGE_SIZE,
  mappingPageSizeStore,
} from "../../traceability/mapping-page-size";

const KEY = "playwrightBddRunner.board.mappingPageSize";

// A workspaceState stand-in: the same read-your-write behaviour the real memento has, plus a hook for the
// rejected update the store routes to its error callback.
function memento(seed: Record<string, unknown> = {}): vscode.Memento & { values: Record<string, unknown> } {
  const store = {
    values: { ...seed },
    get: <T>(key: string): T | undefined => store.values[key] as T | undefined,
    update: (key: string, value: unknown): Promise<void> => {
      store.values[key] = value;
      return Promise.resolve();
    },
    keys: () => Object.keys(store.values),
  };
  return store as unknown as vscode.Memento & { values: Record<string, unknown> };
}

describe("mappingPageSizeStore", () => {
  const noop = (): void => undefined;

  it("offers three sizes and starts on the middle one", () => {
    expect(MAPPING_PAGE_SIZES).toEqual([25, 50, 100]);
    expect(DEFAULT_MAPPING_PAGE_SIZE).toBe(50);
  });

  it("reads the default when nothing has been chosen", () => {
    expect(mappingPageSizeStore(memento(), noop).get()).toBe(50);
  });

  it("round-trips every offered size through the memento", () => {
    const state = memento();
    const store = mappingPageSizeStore(state, noop);

    for (const size of MAPPING_PAGE_SIZES) {
      store.set(size);
      expect(state.values[KEY]).toBe(size);
      expect(store.get()).toBe(size);
    }
  });

  it("reads a size the dropdown does not offer as the default", () => {
    expect(mappingPageSizeStore(memento({ [KEY]: 7 }), noop).get()).toBe(50);
    expect(mappingPageSizeStore(memento({ [KEY]: 0 }), noop).get()).toBe(50);
    expect(mappingPageSizeStore(memento({ [KEY]: -25 }), noop).get()).toBe(50);
    expect(mappingPageSizeStore(memento({ [KEY]: Number.NaN }), noop).get()).toBe(50);
    expect(mappingPageSizeStore(memento({ [KEY]: "50" }), noop).get()).toBe(50);
  });

  it("leaves an out-of-range stored value untouched on read", () => {
    const state = memento({ [KEY]: 7 });

    mappingPageSizeStore(state, noop).get();

    expect(state.values[KEY]).toBe(7);
  });

  it("reports a failed write instead of throwing at the caller", async () => {
    const state = memento();
    const failure = new Error("state is read-only");
    vi.spyOn(state, "update").mockReturnValue(Promise.reject(failure));
    const onError = vi.fn();

    mappingPageSizeStore(state, onError).set(25);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("reads the default and swallows writes with nowhere to persist into", () => {
    expect(NO_MAPPING_PAGE_SIZE.get()).toBe(50);

    NO_MAPPING_PAGE_SIZE.set(25);

    expect(NO_MAPPING_PAGE_SIZE.get()).toBe(50);
  });
});
