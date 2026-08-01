import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { BoundedOutputTail, EXECUTION_LIMITS } from "./execution-limits";
import { errMsg } from "../utils/text";
import type { Logger } from "../utils/logger";

export type CommandOutputHandler = (stream: "stdout" | "stderr", text: string) => void;

export interface BoundedCommandResult {
  readonly success: boolean;
  readonly output: string;
  readonly error: string;
  readonly returnCode: number;
  readonly outputStreamed?: boolean;
}

export interface BoundedCommandOptions {
  readonly command: string;
  readonly workingDir: string;
  readonly extraEnv?: NodeJS.ProcessEnv | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onOutput?: CommandOutputHandler | undefined;
  readonly logger: Logger;
}

/** Spawn one command while streaming every chunk and retaining only bounded diagnostic tails. */
export function runBoundedCommand(options: BoundedCommandOptions): Promise<BoundedCommandResult> {
  const { command, workingDir, extraEnv, signal, onOutput, logger } = options;
  return new Promise((resolve) => {
    if (!command || command.trim() === "") {
      resolve({ success: false, output: "", error: "Command cannot be empty", returnCode: 1 });
      return;
    }
    if (signal?.aborted) {
      resolve({ success: false, output: "", error: "Cancelled", returnCode: 130 });
      return;
    }

    try {
      const child = spawn(command, {
        cwd: workingDir,
        shell: true,
        ...(process.platform === "win32" ? {} : { detached: true }),
        env: { ...process.env, ...(extraEnv ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout = new BoundedOutputTail(EXECUTION_LIMITS.outputTailBytesPerStream);
      const stderr = new BoundedOutputTail(EXECUTION_LIMITS.outputTailBytesPerStream);
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let outputDelivered = false;
      let settled = false;
      let cancelled = false;

      const emit = (stream: "stdout" | "stderr", text: string): void => {
        outputDelivered = publish(onOutput, stream, text) || outputDelivered;
      };
      const finishOutput = (): void => {
        child.stdout?.removeListener("data", onStdout);
        child.stderr?.removeListener("data", onStderr);
        emit("stdout", stdoutDecoder.end());
        emit("stderr", stderrDecoder.end());
        const stdoutNotice = stdout.truncationNotice("stdout");
        const stderrNotice = stderr.truncationNotice("stderr");
        if (stdoutNotice !== undefined) {emit("stdout", `\n${stdoutNotice}\n`);}
        if (stderrNotice !== undefined) {emit("stderr", `\n${stderrNotice}\n`);}
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      const onStdout = (data: Buffer): void => {
        stdout.append(data);
        emit("stdout", stdoutDecoder.write(data));
      };
      const onStderr = (data: Buffer): void => {
        stderr.append(data);
        emit("stderr", stderrDecoder.write(data));
      };

      const result = (
        success: boolean,
        error: string,
        returnCode: number
      ): BoundedCommandResult => ({
        success,
        output: stdout.format("stdout"),
        error,
        returnCode,
        ...(outputDelivered ? { outputStreamed: true } : {}),
      });
      const settle = (code: number | null): void => {
        if (settled) {return;}
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        finishOutput();
        if (cancelled) {
          resolve(result(false, "Cancelled", 130));
          return;
        }
        const returnCode = code ?? 1;
        resolve(result(returnCode === 0, stderr.format("stderr"), returnCode));
      };
      const onAbort = (): void => {
        cancelled = true;
        killTree(child, logger);
        const timer = setTimeout(() => {settle(130);}, 2_000);
        timer.unref?.();
      };

      signal?.addEventListener("abort", onAbort);
      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
      child.on("close", settle);
      child.on("exit", (code: number | null) => {
        const timer = setTimeout(() => {settle(code);}, 2_000);
        timer.unref?.();
      });
      child.on("error", (error: Error) => {
        logger.error(`Command execution error: ${error.message}`, { command, workingDir });
        if (settled) {return;}
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        finishOutput();
        resolve(result(false, error.message, 1));
      });
    } catch (error) {
      const message = errMsg(error);
      logger.error(`Failed to execute command with output: ${message}`, { command, workingDir });
      resolve({ success: false, output: "", error: message, returnCode: 1 });
    }
  });
}

function publish(
  onOutput: CommandOutputHandler | undefined,
  stream: "stdout" | "stderr",
  text: string
): boolean {
  if (text === "" || onOutput === undefined) {return false;}
  try {
    onOutput(stream, text);
    return true;
  } catch {
    return false;
  }
}

/** Kill the spawned shell and its descendants so cancellation cannot orphan browsers. */
function killTree(child: ChildProcess, logger: Logger): void {
  if (child.pid === undefined) {return;}
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      killer.on("error", () => { /* taskkill unavailable; best effort */ });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      logger.warn(`Failed to kill process tree: ${errMsg(error)}`);
    }
  }
}
