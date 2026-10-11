import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { runBoundedCommand } from "../../core/bounded-command-runner";
import { ExecutionAdmission } from "../../core/execution-admission";
import { LegacyDirectExecutionGateway, ExecutionFailure } from "../../core/execution-gateway";
import type { RunProgressObserver } from "../../core/run-progress";
import type { RunOutputResult, TestExecutor } from "../../core/test-executor";
import { WorkspaceTrust } from "../../core/workspace-trust";
import type { FeatureParser } from "../../parsers/feature-parser";
import { Logger } from "../../utils/logger";

/** Real installed CLI, populated resource, fixture teardown, worker exit and next gateway admission. */
export async function provePlaywrightCancellation(options: { withBrowser?: boolean } = {}): Promise<void> {
  const { withBrowser = false } = options;
  const directory = fs.mkdtempSync(path.join(path.resolve(__dirname, "../../.."), ".specwright-playwright-stop-"));
  const logger = Logger.create();
  const controller = new AbortController();
  let pending: Promise<unknown> | undefined;
  try {
    fs.writeFileSync(path.join(directory, "playwright.config.cjs"),
      'module.exports={testDir:".",timeout:60000,workers:1,reporter:"line"};');
    fs.writeFileSync(path.join(directory, "cancellation.spec.cjs"), [
      'const {test:base,expect}=require("@playwright/test");',
      'const fs=require("node:fs");',
      'const test=base.extend({ownedResource: [async({},use,info)=>{',
      ' const resource={title:info.title,items:["one","two"]};',
      ' try { await use(resource); } finally {',
      '  fs.writeFileSync("teardown.txt","complete"); console.log("fixture teardown completed");',
      ' }',
      '},{auto:true}]});',
      `test("owned resource cancellation",async({ownedResource${withBrowser ? ",page" : ""}})=>{`,
      ' expect(ownedResource).toEqual({title:"owned resource cancellation",items:["one","two"]});',
      ...(withBrowser ? [
        ' await page.setContent("<h1>owned cancellation browser</h1>");',
        ' await expect(page.getByText("owned cancellation browser")).toBeVisible();',
      ] : []),
      ' console.log("running-test:"+process.pid); await new Promise(()=>{});',
      '});',
      `test("next named passing run",async({ownedResource${withBrowser ? ",page" : ""}})=>{`,
      ' expect(ownedResource).toEqual({title:"next named passing run",items:["one","two"]});',
      ...(withBrowser ? [
        ' await page.setContent("<h1>next named passing run</h1>");',
        ' await expect(page.getByText("next named passing run")).toBeVisible();',
      ] : []),
      ' console.log("next named run passed");',
      '});',
    ].join("\n"));
    let command = 'npx playwright test --grep "owned resource cancellation"';
    const executor = {
      setForceParallel: () => undefined,
      runSuiteWithOutput: async (signal: AbortSignal | undefined, _batch: number | undefined,
        progress: RunProgressObserver): Promise<RunOutputResult> => {
        const result = await runBoundedCommand({ command, workingDir: directory, logger, signal,
          onOutput: progress.onOutput });
        return { success: result.success, output: result.output, error: result.error, duration: 1,
          ...(result.outputStreamed ? { outputStreamed: true } : {}),
          ...(result.terminationLease ? { terminationLease: result.terminationLease } : {}),
          ...(result.terminationFailure ? {
            admissionUnsafe: true, infrastructureFailure: result.terminationFailure,
          } : {}),
        };
      },
    } as unknown as TestExecutor;
    const admission = new ExecutionAdmission();
    const gateway = new LegacyDirectExecutionGateway(executor, {} as FeatureParser,
      new WorkspaceTrust(() => true), admission);
    const intent = { mode: "run" as const, targets: [{ kind: "suite" as const }] };
    let announce!: (pid: number) => void;
    const ready = new Promise<number>((resolve) => {announce = resolve;});
    let output = "";
    const running = gateway.execute(intent, { signal: controller.signal, onEvent: (event) => {
      if (event.kind !== "output") {return;}
      output += event.text;
      const match = /running-test:(\d+)/u.exec(output);
      if (match) {announce(Number(match[1]));}
    } });
    pending = running;
    const workerPid = await Promise.race([ready, running.then((result) => {
      throw new Error(`Playwright did not reach the populated test: ${result.output}`);
    }, (error: unknown) => {
      if (error instanceof ExecutionFailure) {throw new Error(error.completion.output);}
      throw error;
    })]);
    controller.abort();
    const cancelled = await running;
    assert.equal(cancelled.state, "cancelled", cancelled.failure);
    assert.equal(fs.readFileSync(path.join(directory, "teardown.txt"), "utf8"), "complete");
    assert.match(cancelled.output, /fixture teardown completed/u);
    assert.equal(admission.blocked, false);
    assert.throws(() => process.kill(workerPid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH",
      "Playwright's worker survived its acknowledged CLI close");
    command = 'npx playwright test --grep "next named passing run"';
    const fresh = await gateway.execute(intent);
    assert.equal(fresh.state, "complete", fresh.failure);
    assert.match(fresh.output, /next named run passed/u);
  } finally {
    controller.abort();
    await pending?.catch(() => undefined);
    logger.dispose();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
