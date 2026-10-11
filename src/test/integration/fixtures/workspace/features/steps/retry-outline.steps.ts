import { createBdd } from "playwright-bdd";

const { Given } = createBdd();

Given("native retry row {string} completes", async ({ $testInfo }, row: string) => {
  if (row !== "first" && $testInfo.retry === 0) {
    $testInfo.setTimeout(2_000);
    await new Promise<void>(() => undefined);
  }
});
