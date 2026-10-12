import { createBdd } from "playwright-bdd";

const { Given } = createBdd();
const { waitForGate } = require("../../progress-gate.cjs") as {
  waitForGate(stage: string): Promise<void>;
};

Given("native progress row {string} completes", async ({ $testInfo }, row: string) => {
  if (row === "clean" || !process.env["SPECWRIGHT_NATIVE_PROGRESS_ROOT"]) {return;}
  if ($testInfo.retry === 0) {throw new Error("retry the named progress row");}
  if (row === "retry") {await waitForGate("retry");}
});
