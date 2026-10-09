import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const PLAYWRIGHT_STOP_REQUEST = "specwright:playwright-stop";
export const PLAYWRIGHT_STOP_ACCEPTED = "specwright:playwright-stop-accepted";
export const PLAYWRIGHT_STOP_GRACE_MS = 5_000;

/** The bridge is a separate Node entry, so workers never inherit a preload or interrupt listener. */
export function playwrightCliInvocation(cli: string | undefined, args: readonly string[]): {
  executable: string; args: string[];
} | undefined {
  if (cli === undefined) {return undefined;}
  const bundled = path.join(__dirname, "playwright-cli-bootstrap.js");
  const development = path.resolve(__dirname, "../../dist/playwright-cli-bootstrap.js");
  const bootstrap = [bundled, development].find((file) => fs.existsSync(file));
  return bootstrap === undefined ? undefined : { executable: "node", args: [bootstrap, cli, ...args] };
}

/** A requested, acknowledged interrupt followed by the CLI's complete clean close is release evidence. */
export function stopPlaywrightCli(child: ChildProcess): Promise<boolean> {
  return new Promise((resolve) => {
    let accepted = false;
    let finished = false;
    const complete = (stopped: boolean): void => {
      if (finished) {return;}
      finished = true;
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      child.removeListener("disconnect", onDisconnect);
      resolve(stopped);
    };
    const onMessage = (message: unknown): void => {
      if (message === PLAYWRIGHT_STOP_ACCEPTED) {accepted = true;}
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      complete(accepted && signal === null && (code === 0 || code === 130));
    };
    const onError = (): void => complete(false);
    const onDisconnect = (): void => {if (!accepted) {complete(false);}};
    const timer = setTimeout(() => complete(false), PLAYWRIGHT_STOP_GRACE_MS);
    timer.unref?.();
    child.on("message", onMessage);
    child.once("close", onClose);
    child.once("error", onError);
    child.once("disconnect", onDisconnect);
    if (!child.connected) {complete(false); return;}
    try {
      child.send(PLAYWRIGHT_STOP_REQUEST, (error) => {if (error) {complete(false);}});
    } catch {complete(false);}
  });
}
