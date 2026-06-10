import { defineConfig } from "@playwright/test";
import { defineBddConfig } from "playwright-bdd";

/**
 * Sample playwright-bdd configuration. `defineBddConfig` tells playwright-bdd which feature
 * files to scan and where to put the generated specs. The returned `testDir` value is what
 * Playwright's runner will pick up.
 *
 * Install dependencies once before running:
 *   npm i -D @playwright/test playwright-bdd
 *   npx playwright install
 *
 * Then either:
 *   npx bddgen && npx playwright test       (explicit two-step)
 *   npx playwright test                     (if bddgen runs via defineBddProject)
 */
const testDir = defineBddConfig({
  features: "features/**/*.feature",
  steps: ["features/steps/**/*.ts"],
  // One step ("I have a new widget" in background.feature) is intentionally left undefined.
  // 'skip-scenario' makes bddgen skip only that scenario instead of silently dropping the
  // step (which would make the scenario falsely pass) or failing generation for the whole
  // suite — so every other scenario stays runnable/checkable.
  missingSteps: "skip-scenario",
});

export default defineConfig({
  testDir,
  reporter: "list",
  use: {
    headless: true,
    trace: "on-first-retry",
  },
});
