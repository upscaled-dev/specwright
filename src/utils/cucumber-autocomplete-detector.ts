import * as vscode from "vscode";

const CUCUMBER_AUTOCOMPLETE_EXT_ID = "alexkrechik.cucumberautocomplete";

export function isCucumberAutocompletePresent(
  extensionsApi: typeof vscode.extensions = vscode.extensions
): boolean {
  return extensionsApi.getExtension(CUCUMBER_AUTOCOMPLETE_EXT_ID) !== undefined;
}
