import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { ExtensionApi } from "../../../extension";

const EXTENSION_ID = "upscaled-dev.specwright";

export type TestProviderApi = NonNullable<ExtensionApi["testProvider"]>;

/** One discovered scenario as the fixture suites address it: test item id, run target, report source. */
export interface TargetScenario {
  id: string;
  name: string;
  filePath: string;
  lineNumber: number;
}

export async function activateExtension(): Promise<ExtensionApi> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  if (!extension) {throw new Error(`Extension ${EXTENSION_ID} not found`);}
  return (await extension.activate()) as ExtensionApi;
}

export async function activatedTestProvider(): Promise<TestProviderApi> {
  const api = await activateExtension();
  assert.ok(api.testProvider, "testProvider not exposed by ExtensionApi");
  return api.testProvider;
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  description: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {return;}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

export function findScenario(provider: TestProviderApi, name: string): TargetScenario | undefined {
  for (const [id, scenario] of provider.testIdToScenarioMap) {
    if (scenario.name === name) {
      return { id, name: scenario.name, filePath: scenario.filePath, lineNumber: scenario.lineNumber };
    }
  }
  return undefined;
}

export interface CannedReportOptions {
  readonly featureTitle: string;
  readonly specFile: string;
  readonly status: "passed" | "failed";
}

/** A canned Playwright JSON report for one scenario, with a source annotation so the parser maps
 * it back to the .feature line without needing a generated spec on disk. */
export function cannedReport(target: TargetScenario, options: CannedReportOptions): string {
  return JSON.stringify({
    suites: [{
      title: options.featureTitle,
      specs: [{
        title: target.name,
        file: options.specFile,
        tests: [{
          annotations: [{ type: `${target.filePath}:${target.lineNumber}` }],
          results: [{
            status: options.status,
            duration: 5,
            ...(options.status === "failed"
              ? { error: { message: "boom", stack: "Error: boom\n    at steps.ts:1:1" } }
              : {}),
            steps: [{ title: "Given I am on the test page", duration: 2 }],
          }],
        }],
      }],
    }],
  });
}
