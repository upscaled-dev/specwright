import { PLAYWRIGHT_STOP_REQUEST, PLAYWRIGHT_STOP_ACCEPTED } from "./playwright-cli-cancellation";

const cli = process.argv[2];
if (cli === undefined) {throw new Error("The installed Playwright CLI path is required.");}
process.argv.splice(1, 1);
process.on("message", (message: unknown) => {
  if (message !== PLAYWRIGHT_STOP_REQUEST || process.listenerCount("SIGINT") === 0) {return;}
  process.emit("SIGINT");
  if (process.connected) {
    try {process.send?.(PLAYWRIGHT_STOP_ACCEPTED, () => undefined);}
    catch { /* a lost acknowledgement cannot interrupt Playwright teardown */ }
  }
});
// The control channel must not keep a completed CLI alive. It belongs to this process alone.
process.channel?.unref();
require(cli);
