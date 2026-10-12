const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { waitForGate } = require("./progress-gate.cjs");

(async () => {
  const stage = process.argv[2];
  await waitForGate(stage);
  if (stage === "generating") {
    const cli = path.join(path.dirname(require.resolve("playwright-bdd/package.json")), "dist/cli/index.js");
    const result = spawnSync(process.execPath, [cli], { stdio: "inherit" });
    if (result.error) {throw result.error;}
    process.exitCode = result.status ?? 1;
  }
})().catch((error) => {console.error(error); process.exitCode = 1;});
