import * as assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveExecutableCommand,
  runBoundedCommand,
  WINDOWS_TASKKILL_TIMEOUT_MS,
  WINDOWS_TERMINATION_WORST_CASE_MS,
} from "../../../core/bounded-command-runner";
import { ExecutionAdmission } from "../../../core/execution-admission";
import { LegacyDirectExecutionGateway } from "../../../core/execution-gateway";
import type { RunProgressObserver } from "../../../core/run-progress";
import type { TestExecutor, RunOutputResult } from "../../../core/test-executor";
import { WorkspaceTrust } from "../../../core/workspace-trust";
import type { FeatureParser } from "../../../parsers/feature-parser";
import { Logger } from "../../../utils/logger";
import { shellQuote } from "../../../utils/shell";
import { provePlaywrightCancellation } from "../../helpers/playwright-cancellation";
import {
  readProcessIdentity,
  readProcessTable,
  survivingMembers,
  treeMembers,
  type ProcessIdentity,
  type ProcessMember,
} from "../../../core/windows-process-tree";

const OBSERVE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

const TREE_SCRIPT = [
  'const { spawn } = require("node:child_process");',
  'spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });',
  'console.log("tree-ready:" + process.pid);',
  "setInterval(() => {}, 1000);",
].join("\n");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll the real process table until the tree rooted at `root` matches, or report what it saw. */
async function awaitTree(
  root: ProcessIdentity,
  matches: (members: readonly ProcessMember[]) => boolean
): Promise<readonly ProcessMember[]> {
  const deadline = Date.now() + OBSERVE_TIMEOUT_MS;
  for (;;) {
    const members = treeMembers(await readProcessTable(), [root]);
    if (matches(members) || Date.now() >= deadline) {return members;}
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Poll until the recorded identities are gone, or report the ones that outlasted the wait. */
async function awaitExit(members: readonly ProcessMember[]): Promise<readonly ProcessMember[]> {
  const deadline = Date.now() + OBSERVE_TIMEOUT_MS;
  for (;;) {
    const survivors = survivingMembers(await readProcessTable(), members);
    if (survivors.length === 0 || Date.now() >= deadline) {return survivors;}
    await sleep(POLL_INTERVAL_MS);
  }
}

function taskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const complete = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {killer.kill("SIGKILL");} catch { /* cleanup remains bounded */ }
      complete();
    }, WINDOWS_TASKKILL_TIMEOUT_MS);
    timer.unref?.();
    killer.once("error", complete);
    killer.once("close", complete);
  });
}

(process.platform === "win32" ? suite : suite.skip)(
  "Windows process tree (real Extension Host)",
  () => {
    let projectDir: string;
    let tree: ChildProcess | undefined;
    let runnerPid: number | undefined;
    const logger = Logger.create();

    setup(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "specwright-process-tree-"));
      fs.writeFileSync(path.join(projectDir, "tree.js"), TREE_SCRIPT);
      fs.writeFileSync(path.join(projectDir, "fresh.js"), 'console.log("fresh execution completed");');
    });

    teardown(async () => {
      if (tree?.pid !== undefined) {await taskkill(tree.pid);}
      if (runnerPid !== undefined) {await taskkill(runnerPid);}
      tree = undefined;
      runnerPid = undefined;
      // Windows can hold the just-exited child's files briefly; retry the removal.
      fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    suiteTeardown(() => {logger.dispose();});

    test("cooperatively cancels the populated Playwright fixture and admits the next named run", async function () {
      this.timeout(90_000);
      const checkoutDir = path.resolve(__dirname, "../../../..");
      const shim = path.join(checkoutDir, "node_modules", ".bin", "bddgen.cmd");
      const manifest = path.join(checkoutDir, "node_modules", "playwright-bdd", "package.json");
      assert.ok(fs.existsSync(shim), "installed bddgen shim was missing before cancellation");
      assert.ok(fs.existsSync(manifest), "installed bddgen manifest was missing before cancellation");
      const invocation = resolveExecutableCommand("npx bddgen", checkoutDir);
      const target = invocation.args[0];
      assert.ok(target, "installed bddgen target was missing before cancellation");
      const dependencies = [shim, manifest, target];
      const before = dependencies.map((file) => fs.readFileSync(file));
      await provePlaywrightCancellation();
      for (const [index, file] of dependencies.entries()) {
        assert.ok(fs.existsSync(file), `installed bddgen file was removed by cancellation fixture: ${file}`);
        assert.deepEqual(fs.readFileSync(file), before[index], `installed bddgen file changed during cancellation fixture: ${file}`);
      }
      assert.deepEqual(resolveExecutableCommand("npx bddgen", checkoutDir), invocation,
        "installed bddgen resolution changed during cancellation fixture");
    });

    test("cancels an owned tree through the gateway and admits the next named command", async function () {
      this.timeout(WINDOWS_TERMINATION_WORST_CASE_MS + 3 * OBSERVE_TIMEOUT_MS);
      let command = `node ${shellQuote(path.join(projectDir, "tree.js"))}`;
      // Keep the runner's admission evidence intact across this command-only executor boundary.
      const executor = {
        setForceParallel: () => undefined,
        runSuiteWithOutput: async (
          signal: AbortSignal | undefined,
          _artifactBatch: number | undefined,
          progress: RunProgressObserver
        ): Promise<RunOutputResult> => {
          const result = await runBoundedCommand({
            command,
            workingDir: projectDir,
            logger,
            signal,
            onOutput: progress.onOutput,
          });
          return {
            success: result.success,
            output: result.output,
            error: result.error,
            duration: 1,
            ...(result.outputStreamed ? { outputStreamed: true } : {}),
            ...(result.terminationLease ? { terminationLease: result.terminationLease } : {}),
            ...(result.terminationFailure ? {
              admissionUnsafe: true,
              infrastructureFailure: result.terminationFailure,
            } : {}),
          };
        },
      } as unknown as TestExecutor;
      const admission = new ExecutionAdmission();
      const gateway = new LegacyDirectExecutionGateway(
        executor,
        {} as FeatureParser,
        new WorkspaceTrust(() => true),
        admission
      );
      const controller = new AbortController();
      let resolveReady!: (pid: number) => void;
      const ready = new Promise<number>((resolve) => {resolveReady = resolve;});
      let streamed = "";
      const intent = { mode: "run" as const, targets: [{ kind: "suite" as const }] };
      const pending = gateway.execute(intent, {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.kind !== "output") {return;}
          streamed += event.text;
          const match = /tree-ready:(\d+)/u.exec(streamed);
          if (match) {resolveReady(Number(match[1]));}
        },
      });
      // If startup fails, surface the completion instead of leaving the readiness wait pending.
      runnerPid = await Promise.race([ready, pending.then(() => {
        throw new Error("the owned tree exited before reporting readiness");
      })]);
      const root = await readProcessIdentity(runnerPid);
      assert.ok(root, "the runner's live process had no readable identity");
      const members = await awaitTree(root, (found) => found.length >= 2);
      assert.ok(members.length >= 2, "the runner did not start its child process");

      controller.abort();
      const cancelled = await pending;
      assert.equal(cancelled.state, "cancelled", cancelled.failure);
      assert.equal(admission.blocked, false, "cancellation left execution admission blocked");
      assert.deepEqual(await awaitExit(members), [], "the runner left a recorded process alive");
      runnerPid = undefined;

      command = `node ${shellQuote(path.join(projectDir, "fresh.js"))}`;
      const fresh = await gateway.execute(intent);
      assert.equal(fresh.state, "complete", fresh.failure);
      assert.match(fresh.output, /fresh execution completed/u);
    });

    test("confirms a live tree and then its termination", async function () {
      this.timeout(2 * OBSERVE_TIMEOUT_MS);
      tree = spawn(process.execPath, [path.join(projectDir, "tree.js")], { stdio: "ignore" });
      assert.ok(tree.pid, "the process tree did not start");

      const root = await readProcessIdentity(tree.pid);
      assert.ok(root, "the spawned process had no readable identity");
      assert.equal(root.pid, tree.pid);

      const members = await awaitTree(root, (found) => found.length >= 2);
      assert.ok(
        members.length >= 2,
        `expected the spawned parent and its child, saw ${JSON.stringify(members)}`
      );
      assert.ok(
        members.some((member) => member.pid === tree?.pid),
        "the recorded root was not reported as a member"
      );

      await taskkill(tree.pid);
      const survivors = await awaitExit(members);

      assert.deepEqual(survivors, [], "the terminated tree was still reported as running");
      tree = undefined;
    });
  }
);
