import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  BoundedCommandOutput,
  parseExecutableCommand,
  resolveExecutableCommand,
  runBoundedCommand,
  WINDOWS_TERMINATION_WORST_CASE_MS,
} from "../../core/bounded-command-runner";
import { EXECUTION_LIMITS } from "../../core/execution-limits";
import { Logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shell";

const logger = Logger.create();

function nodeCommand(script: string): string {
  return `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
}

describe("runBoundedCommand", () => {
  it("parses argv without a shell and prevents implicit npx installs", () => {
    expect(parseExecutableCommand('npx playwright test --grep "login works"')).toEqual({
      executable: "npx",
      args: ["--no-install", "playwright", "test", "--grep", "login works"],
    });
    expect(parseExecutableCommand('"C:\\Program Files\\node.exe" "C:\\work\\a.js"')).toEqual({
      executable: "C:\\Program Files\\node.exe",
      args: ["C:\\work\\a.js"],
    });
    expect(() => parseExecutableCommand("npm test && curl example.test")).toThrow("Shell operator");
  });

  it("resolves Windows bddgen and Playwright shims through Node without a shell", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specwright-win-bin-"));
    const bin = path.join(root, "node_modules", ".bin");
    fs.mkdirSync(bin, { recursive: true });
    try {
      const bddgen = path.join(root, "node_modules", "playwright-bdd", "dist", "cli", "index.js");
      const playwright = path.join(root, "node_modules", "@playwright", "test", "cli.js");
      fs.mkdirSync(path.dirname(bddgen), { recursive: true });
      fs.mkdirSync(path.dirname(playwright), { recursive: true });
      fs.writeFileSync(bddgen, "");
      fs.writeFileSync(playwright, "");
      fs.writeFileSync(
        path.join(bin, "bddgen.cmd"),
        "@SETLOCAL\r\n" +
        "@IF NOT DEFINED NODE_PATH (\r\n" +
        '  @SET "NODE_PATH=C:\\pnpm\\node_modules"\r\n' +
        ") ELSE (\r\n" +
        '  @SET "NODE_PATH=C:\\pnpm\\node_modules;%NODE_PATH%"\r\n' +
        ")\r\n" +
        '@IF EXIST "%~dp0\\node.exe" (\r\n' +
        '  "%~dp0\\node.exe" "%~dp0\\..\\playwright-bdd\\dist\\cli\\index.js" %*\r\n' +
        ") ELSE (\r\n" +
        '  node "%~dp0\\..\\playwright-bdd\\dist\\cli\\index.js" %*\r\n' +
        ")\r\n"
      );
      fs.writeFileSync(
        path.join(bin, "playwright.cmd"),
        '@ECHO off\r\nnode "%dp0%\\..\\@playwright\\test\\cli.js" %*\r\n'
      );
      expect(resolveExecutableCommand(
        'pnpm exec bddgen --config "bdd config.ts"',
        root,
        "win32"
      )).toEqual({
        executable: "node",
        args: [bddgen, "--config", "bdd config.ts"],
      });
      expect(resolveExecutableCommand("npx playwright test", root, "win32")).toEqual({
        executable: "node",
        args: [playwright, "test"],
      });
      expect(() => resolveExecutableCommand("npx missing test", root, "win32"))
        .toThrow("not installed");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes POSIX bddgen and Playwright bins directly through their Node shebangs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specwright-posix-bin-"));
    const bin = path.join(root, "node_modules", ".bin");
    fs.mkdirSync(bin, { recursive: true });
    try {
      const bddgen = path.join(root, "node_modules", "playwright-bdd", "cli.js");
      const playwright = path.join(root, "node_modules", "playwright", "cli.js");
      for (const [name, target] of [["bddgen", bddgen], ["playwright", playwright]] as const) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "#!/usr/bin/env node\n", { mode: 0o755 });
        fs.symlinkSync(path.relative(bin, target), path.join(bin, name));
      }

      expect(resolveExecutableCommand("npx bddgen", root, "linux")).toEqual({
        executable: fs.realpathSync(bddgen),
        args: [],
      });
      expect(resolveExecutableCommand("npx playwright test", root, "linux")).toEqual({
        executable: fs.realpathSync(playwright),
        args: ["test"],
      });
      for (const [command, executable, args] of [
        ['npm exec -- bddgen --config "bdd config.ts"', bddgen, ["--config", "bdd config.ts"]],
        ['pnpm exec bddgen --config "bdd config.ts"', bddgen, ["--config", "bdd config.ts"]],
        ['yarn bddgen --config "bdd config.ts"', bddgen, ["--config", "bdd config.ts"]],
        ['yarn run bddgen --config "bdd config.ts"', bddgen, ["--config", "bdd config.ts"]],
        ['npm exec -- playwright test --grep "login works"', playwright, ["test", "--grep", "login works"]],
        ['pnpm exec playwright test --grep "login works"', playwright, ["test", "--grep", "login works"]],
        ['yarn playwright test --grep "login works"', playwright, ["test", "--grep", "login works"]],
        ['yarn run playwright test --grep "login works"', playwright, ["test", "--grep", "login works"]],
      ] as const) {
        expect(resolveExecutableCommand(command, root, "linux")).toEqual({
          executable: fs.realpathSync(executable),
          args,
        });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("never falls back to package-manager execution when a local bin is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specwright-missing-bin-"));
    try {
      for (const command of [
        "npx missing test",
        "npm exec -- missing test",
        "pnpm exec missing test",
        "yarn missing test",
        "yarn run missing test",
      ]) {
        expect(() => resolveExecutableCommand(command, root, "linux")).toThrow("not installed");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("streams all chunks while retaining bounded diagnostic tails", async () => {
    const bytes = EXECUTION_LIMITS.outputTailBytesPerStream + 4096;
    const streamed = { stdout: "", stderr: "" };
    const result = await runBoundedCommand({
      command: nodeCommand(
        `process.stdout.write("o".repeat(${bytes}));process.stderr.write("e".repeat(${bytes}));`
      ),
      workingDir: process.cwd(),
      logger,
      onOutput: (stream, text) => {streamed[stream] += text;},
    });

    expect(result.success).toBe(true);
    expect(result.outputStreamed).toBe(true);
    expect(streamed.stdout).toContain("o".repeat(4096));
    expect(streamed.stderr).toContain("e".repeat(4096));
    expect(streamed.stdout).toContain(
      `retained ${EXECUTION_LIMITS.outputTailBytesPerStream} bytes, discarded 4096 bytes`
    );
    expect(streamed.stderr).toContain(
      `retained ${EXECUTION_LIMITS.outputTailBytesPerStream} bytes, discarded 4096 bytes`
    );
    expect(result.output).toContain(
      `retained ${EXECUTION_LIMITS.outputTailBytesPerStream} bytes, discarded 4096 bytes`
    );
    expect(result.error).toContain(
      `retained ${EXECUTION_LIMITS.outputTailBytesPerStream} bytes, discarded 4096 bytes`
    );
    expect(Buffer.byteLength(result.output)).toBeLessThan(bytes);
    expect(Buffer.byteLength(result.error)).toBeLessThan(bytes);
    // A real spawn writing half a megabyte pays node's start-up and, on Windows, the exit grace
    // that drains inherited handles; the 5s default leaves a slow runner no room.
  }, 20_000);

  // The flood must outlast every termination path, so a Stop starved by the writes settles at the
  // child's own end and fails the budget below instead of hanging to the suite timeout.
  const FLOOD_LIFETIME_MS = 30_000;
  // Head-room over the ladder's worst case for a cold or loaded runner, kept far below
  // FLOOD_LIFETIME_MS so a starved cancellation still fails the budget rather than the child's end.
  const SLOW_RUNNER_MARGIN_MS = 10_000;
  const CANCEL_SETTLE_BUDGET_MS = WINDOWS_TERMINATION_WORST_CASE_MS + SLOW_RUNNER_MARGIN_MS;
  // The child announces its pid on its first write so the kill can be checked against the process
  // itself. The exit timer is armed by the first flood write rather than at boot, so the margin
  // between a starved cancellation and CANCEL_SETTLE_BUDGET_MS does not shrink with a cold start.
  const FLOODING_CHILD =
    'process.stdout.write(process.pid + "\\n");' +
    "let armed = false;" +
    "setInterval(() => {" +
    ' process.stdout.write("x".repeat(65536));' +
    " if (armed) { return; }" +
    " armed = true;" +
    ` setTimeout(() => process.exit(0), ${FLOOD_LIFETIME_MS});` +
    "}, 0);";

  const stillRunning = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };

  it("keeps cancellation responsive while output is heavy", async () => {
    const controller = new AbortController();
    let chunkArrived: () => void = () => undefined;
    const flooding = new Promise<void>((resolve) => {chunkArrived = resolve;});
    let childPid = 0;
    let announced = "";
    const pending = runBoundedCommand({
      command: nodeCommand(FLOODING_CHILD),
      workingDir: process.cwd(),
      logger,
      signal: controller.signal,
      onOutput: (_stream, text) => {
        // Stop accumulating once the pid line is complete; the flood that follows is unbounded.
        if (childPid > 0) {
          chunkArrived();
          return;
        }
        announced += text;
        const end = announced.indexOf("\n");
        if (end < 0) {return;}
        childPid = Number(announced.slice(0, end));
        if (announced.length > end + 1) {chunkArrived();}
      },
    });

    // Cancel only once the writes are provably under way, so Stop really does race the flood. A
    // child that died before its first chunk settles `pending` instead, which keeps that failure on
    // the result assertions rather than hanging until the suite timeout.
    await Promise.race([flooding, pending]);
    const abortedAt = Date.now();
    controller.abort();
    const result = await pending;
    const settleMs = Date.now() - abortedAt;

    expect(result.success).toBe(false);
    // A Windows ladder that cannot confirm the kill inside its budget fails closed by design, and a
    // slow runner reaches that legitimately. Either verdict is accepted, neither half-applied.
    if (process.platform === "win32" && result.error !== "Cancelled") {
      expect(result.error).toMatch(/^Process-tree termination /);
      expect(result.terminationFailure).toBe(result.error);
      expect(result.terminationLease).toBeDefined();
      expect(result.returnCode).toBe(1);
    } else {
      // This child is shell-less and childless, so taskkill's verdict on the root covers the whole
      // tree and "Cancelled" does mean it is gone. Do not copy that reading into a shell-spawned
      // test: terminateWindowsTree also returns undefined when no identity could be read and
      // taskkill merely exited 0, having probed nothing.
      expect(result.error).toBe("Cancelled");
      expect(result.terminationFailure).toBeUndefined();
      expect(result.terminationLease).toBeUndefined();
      expect(result.returnCode).toBe(130);
    }
    expect(settleMs).toBeLessThan(CANCEL_SETTLE_BUDGET_MS);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(
      EXECUTION_LIMITS.outputTailBytesPerStream + 120
    );
    // Unconditional under either verdict: only the bookkeeping may be inconclusive, the flood child
    // still has to be gone. The fail-closed branch carries no kill evidence of its own.
    expect(childPid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(stillRunning(childPid)).toBe(false), { timeout: 5_000, interval: 50 });
  }, 45_000);

  it("preserves a UTF-8 code point split across process chunks", async () => {
    let streamed = "";
    const result = await runBoundedCommand({
      command: nodeCommand(
        "const value=Buffer.from('😀');process.stdout.write(value.subarray(0,2));" +
        "setTimeout(()=>process.stdout.write(value.subarray(2)),25);"
      ),
      workingDir: process.cwd(),
      logger,
      onOutput: (_stream, text) => {streamed += text;},
    });

    expect(result.success).toBe(true);
    expect(streamed).toBe("😀");
    expect(result.output).toBe("😀");
  });

  // Room for a cold runner's process boots on top of the ladder's worst case.
  const COLD_BOOT_MARGIN_MS = 5_000;
  // How long the grandchild will wait for its cue, which is the longest a run can take to settle.
  const LATE_WRITE_WAIT_MS = WINDOWS_TERMINATION_WORST_CASE_MS + COLD_BOOT_MARGIN_MS;
  const MARKER_POLL_MS = 50;
  const SETTLED_MARKER = "settled";
  const LATE_WRITE_MARKER = "written";

  it("stops streaming when the exit grace settles inherited pipes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specwright-late-write-"));
    const script = path.join(dir, "late-write.js");
    const marker = path.join(dir, LATE_WRITE_MARKER);
    // The grandchild writes only once the test says the run has settled, so its write needs no
    // timer raced against the grace window. It records the kind of handle fd 1 turned out to be,
    // which is the only proof that the silence below is a closed inherited pipe rather than a
    // grandchild that never held one.
    fs.writeFileSync(script, [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      `const settled = path.join(__dirname, ${JSON.stringify(SETTLED_MARKER)});`,
      `const deadline = Date.now() + ${LATE_WRITE_WAIT_MS};`,
      "const poll = setInterval(() => {",
      "  if (!fs.existsSync(settled)) {",
      "    if (Date.now() < deadline) { return; }",
      "    clearInterval(poll);",
      "    process.exit(1);",
      "  }",
      "  clearInterval(poll);",
      "  const fd = fs.fstatSync(1);",
      '  const handle = fd.isFIFO() ? "fifo" : fd.isSocket() ? "socket"',
      '    : fd.isCharacterDevice() ? "chardev" : "other";',
      '  process.stdout.write("late");',
      // Renamed into place so the marker is complete the moment the test can see it.
      `  const marker = path.join(__dirname, ${JSON.stringify(LATE_WRITE_MARKER)});`,
      '  fs.writeFileSync(marker + ".part", JSON.stringify({ handle }));',
      '  fs.renameSync(marker + ".part", marker);',
      `}, ${MARKER_POLL_MS});`,
    ].join("\n"));

    let streamed = "";
    try {
      const result = await runBoundedCommand({
        // The grandchild's path rides in argv rather than inside the -e source, so no Windows
        // backslash has to survive a round trip through a nested JS string literal.
        command: `${nodeCommand(
          "const cp=require('node:child_process');" +
          // POSIX detaches so the grandchild leads its own group: the runner kills the group it
          // owns on every completed run, which would take the grandchild down before it can write
          // and leave nothing for this test to observe. Windows has no group to escape, and
          // detaching there would hand the grandchild its own console. Unref'd either way, so the
          // parent exits at once and leaves only the grandchild holding the pipes.
          "cp.spawn(process.execPath,[process.argv[1]]," +
          "{stdio:'inherit',detached:process.platform!=='win32'}).unref();"
        )} ${shellQuote(script)}`,
        workingDir: process.cwd(),
        logger,
        onOutput: (_stream, text) => {streamed += text;},
      });
      const settledOutput = streamed;
      fs.writeFileSync(path.join(dir, SETTLED_MARKER), "yes");

      const record = await vi.waitFor(() => {
        if (!fs.existsSync(marker)) {
          throw new Error("the grandchild never recorded its late write");
        }
        return JSON.parse(fs.readFileSync(marker, "utf8")) as { handle: string };
      }, { timeout: LATE_WRITE_WAIT_MS, interval: MARKER_POLL_MS });

      expect(result.success).toBe(true);
      // The runner's stdio pipe reaches the grandchild as a socketpair on POSIX and a named pipe on
      // Windows. A grandchild given stdio:"ignore" would land on the null device instead, so this is
      // what makes the silence below the runner closing an inherited pipe.
      expect(["fifo", "socket"]).toContain(record.handle);
      expect(streamed).toBe(settledOutput);
      expect(streamed).not.toContain("late");
    } finally {
      // Reached only once the grandchild has written or given up, so nothing is left pointing a
      // pending write at a removed directory. Windows can still hold its handles for a moment.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    // The run has to settle before the observation can start, so the ceiling covers both.
  }, WINDOWS_TERMINATION_WORST_CASE_MS + LATE_WRITE_WAIT_MS);

  it("does not claim output was streamed when spawn fails before delivering a chunk", async () => {
    const result = await runBoundedCommand({
      command: nodeCommand("process.stdout.write('never')"),
      workingDir: path.join(process.cwd(), "missing-working-directory"),
      logger,
      onOutput: () => undefined,
    });

    expect(result.success).toBe(false);
    expect(result.error).not.toBe("");
    expect(result.outputStreamed).toBeUndefined();
  });

  it("keeps command diagnostics local while one capture retains the whole run", async () => {
    const capture = new BoundedCommandOutput(() => undefined);
    await runBoundedCommand({
      command: nodeCommand("process.stderr.write('first')"),
      workingDir: process.cwd(),
      logger,
      onOutput: capture.onOutput,
    });
    const second = await runBoundedCommand({
      command: nodeCommand("process.stderr.write('second');process.exitCode=1"),
      workingDir: process.cwd(),
      logger,
      onOutput: capture.onOutput,
    });

    expect(second.error).toBe("second");
    expect(capture.format()).toBe("firstsecond");
    // Two sequential real spawns pay node's start-up twice, and on Windows the exit grace twice.
  }, 20_000);
});
