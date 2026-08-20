import * as assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
    const table = await readProcessTable();
    assert.ok(table, "the Windows process table could not be read");
    const members = treeMembers(table, [root]);
    if (matches(members) || Date.now() >= deadline) {return members;}
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Poll until the recorded identities are gone, or report the ones that outlasted the wait. */
async function awaitExit(members: readonly ProcessMember[]): Promise<readonly ProcessMember[]> {
  const deadline = Date.now() + OBSERVE_TIMEOUT_MS;
  for (;;) {
    const table = await readProcessTable();
    assert.ok(table, "the Windows process table could not be read");
    const survivors = survivingMembers(table, members);
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
    killer.once("error", () => resolve());
    killer.once("close", () => resolve());
  });
}

(process.platform === "win32" ? suite : suite.skip)(
  "Windows process tree (real Extension Host)",
  () => {
    let projectDir: string;
    let tree: ChildProcess | undefined;

    setup(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "specwright-process-tree-"));
      fs.writeFileSync(path.join(projectDir, "tree.js"), TREE_SCRIPT);
    });

    teardown(async () => {
      if (tree?.pid !== undefined) {await taskkill(tree.pid);}
      tree = undefined;
      // Windows can hold the just-exited child's files briefly; retry the removal.
      fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    });
  }
);
