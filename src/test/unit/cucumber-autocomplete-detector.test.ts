import { describe, it, expect } from "vitest";
import { isCucumberAutocompletePresent } from "../../utils/cucumber-autocomplete-detector";

describe("isCucumberAutocompletePresent", () => {
  it("returns false when the extension is not installed", () => {
    const api = {
      getExtension: (_id: string) => undefined,
      onDidChange: () => ({ dispose: (): void => {} }),
    } as unknown as typeof import("vscode").extensions;
    expect(isCucumberAutocompletePresent(api)).toBe(false);
  });

  it("returns true when the extension is installed", () => {
    const api = {
      getExtension: (id: string) =>
        id === "alexkrechik.cucumberautocomplete" ? { id, isActive: true } : undefined,
      onDidChange: () => ({ dispose: (): void => {} }),
    } as unknown as typeof import("vscode").extensions;
    expect(isCucumberAutocompletePresent(api)).toBe(true);
  });

  it("returns false for unrelated extension ids", () => {
    const api = {
      getExtension: (id: string) =>
        id === "someone.else" ? { id, isActive: true } : undefined,
      onDidChange: () => ({ dispose: (): void => {} }),
    } as unknown as typeof import("vscode").extensions;
    expect(isCucumberAutocompletePresent(api)).toBe(false);
  });
});
