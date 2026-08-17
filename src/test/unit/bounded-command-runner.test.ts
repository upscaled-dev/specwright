import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  BoundedCommandOutput,
  parseExecutableCommand,
  resolveExecutableCommand,
  runBoundedCommand,
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
  });

  it("keeps cancellation responsive while output is heavy", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runBoundedCommand({
      command: nodeCommand(
        'setInterval(() => { process.stdout.write("x".repeat(65536)); }, 0);'
      ),
      workingDir: process.cwd(),
      logger,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 100);
    const result = await pending;

    expect(result).toMatchObject({ success: false, error: "Cancelled", returnCode: 130 });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(
      EXECUTION_LIMITS.outputTailBytesPerStream + 120
    );
  }, 10_000);

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

  it("stops streaming when the exit grace settles inherited pipes", async () => {
    let streamed = "";
    const result = await runBoundedCommand({
      command: nodeCommand(
        "const cp=require('node:child_process');" +
        "cp.spawn(process.execPath,['-e','setTimeout(()=>process.stdout.write(\"late\"),2600)']," +
        "{stdio:'inherit'});setTimeout(()=>process.exit(0),50);"
      ),
      workingDir: process.cwd(),
      logger,
      onOutput: (_stream, text) => {streamed += text;},
    });
    const settledOutput = streamed;

    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(result.success).toBe(true);
    expect(streamed).toBe(settledOutput);
    expect(streamed).not.toContain("late");
  }, 10_000);

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
  });
});
